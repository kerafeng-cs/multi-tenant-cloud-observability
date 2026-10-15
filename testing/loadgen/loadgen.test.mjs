import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { configuration, endpoint, partition, plan } from './config.mjs';
import { metricsPayload, logsPayload } from './model.mjs';
import { AgentToken, exportPayload, requestJson, RequestError } from './transport.mjs';
import { generate } from './worker.mjs';
import { Kubernetes, labels, job, configMap, sourceData } from './kubernetes.mjs';
import { ensureCredentials, secretValue, revokeCredentials } from './enrollment.mjs';
import { argumentsFor, main } from './fleet.mjs';

const cfg = (extra = {}) => configuration({ run: 'check', tenant: 'alpha-tenant', ...extra });
const credential = {
  tenantKey: 'alpha-tenant', agentId: '00000000-0000-4000-8000-000000000001',
  clientId: 'test-client', clientSecret: 'test-only-secret', tokenUrl: 'http://localhost/token', gatewayEndpoint: 'http://localhost',
};
function jwt(extra = {}) {
  const claims = { iss: 'http://test-issuer', tenant_id: credential.tenantKey, agent_id: credential.agentId, vm_account_id: '1', aud: ['otel-gateway'], exp: Math.floor(Date.now() / 1000) + 300, ...extra };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test-signature`;
}
async function server(t, handler) {
  const requests = [];
  const instance = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString();
    requests.push({ url: req.url, body, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    await handler(req, res, body);
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return { url: `http://127.0.0.1:${instance.address().port}`, requests };
}

class FakeKube {
  namespace = 'observability';
  objects = new Map();
  events = [];
  key(kind, name) { return `${kind.toLowerCase().replace(/s$/, '')}/${name}`; }
  get(kind, name) { return structuredClone(this.objects.get(this.key(kind, name)) ?? null); }
  create(object) {
    const key = this.key(object.kind, object.metadata.name);
    if (this.objects.has(key)) throw new Error('already exists');
    this.events.push(`create:${key}`);
    const copy = structuredClone(object); copy.metadata.resourceVersion = '1';
    this.objects.set(key, copy);
  }
  replace(object) {
    const key = this.key(object.kind, object.metadata.name);
    this.events.push(`replace:${key}`); this.objects.set(key, structuredClone(object));
  }
  list(kind, run) { return [...this.objects.values()].filter((o) => this.key(o.kind, '').startsWith(this.key(kind, '')) && o.metadata.labels?.['mtco.test/run'] === run); }
  suspend(name) { this.events.push(`suspend:${name}`); this.objects.get(`job/${name}`).spec.suspend = true; }
  delete(kind, name) { this.events.push(`delete:${kind}/${name}`); this.objects.delete(this.key(kind, name)); }
}

test('partition 10,003 hosts exactly once, with 100 per pod and a bounded global rate', () => {
  const c = cfg({ hosts: 10003, maxPods: 101 });
  const ids = [], shards = [];
  for (let i = 0; i < c.pods; i++) {
    const shard = partition(c, i); shards.push(shard);
    assert.ok(shard.count <= 100);
    for (let j = 0; j < shard.count; j++) ids.push(shard.start + j);
  }
  assert.equal(new Set(ids).size, 10003); assert.equal(ids.at(-1), 10002);
  assert.ok(Math.abs(shards.reduce((n, s) => n + s.metricPointsPerSecond, 0) - 500) < 0.0001);
  assert.ok(Math.abs(shards.reduce((n, s) => n + s.logsPerSecond, 0) - 5) < 0.0001);
  assert.equal(plan(c).pods, 101);
  assert.equal(plan(cfg({ hosts: 10000 })).deployAllowed, false);
});

test('invalid sizing, unknown flags and credential-bearing URLs fail before deploy', () => {
  for (const input of [{ hosts: 0 }, { hosts: 1.5 }, { logsPerSecond: NaN }, { hostsPerPod: 1001 }, { durationSeconds: Infinity }]) assert.throws(() => cfg(input));
  assert.throws(() => argumentsFor(['deploy', '--run', 'check', '--tenant', 'alpha-tenant', '--password', 'never-accept-this']));
  assert.throws(() => cfg({ run: 'a'.repeat(40) }));
  for (const url of ['http://host', 'https://user:password@host', 'https://host?token=x', 'file:///tmp/x']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://host/', true), 'http://host');
  assert.equal(plan(cfg()).requests.cpuMillicores, 50);
});

test('synthetic payload matches dashboard series and remains bounded/monotonic', () => {
  const start = 1700000000000;
  const first = metricsPayload('check', [0, 1], start + 1000, start);
  const later = metricsPayload('check', [0], start + 61000, start);
  const metrics = first.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.reduce((n, m) => n + (m.sum ?? m.gauge).dataPoints.length, 0), 10);
  assert.deepEqual(metrics.map((m) => m.name), ['system.cpu.time', 'system.memory.usage', 'system.cpu.load_average.1m', 'system.network.io', 'system.filesystem.usage']);
  assert.equal(first.resourceMetrics[0].resource.attributes[0].value.stringValue, 'check-host-000001');
  assert.notDeepEqual(metrics[1], first.resourceMetrics[1].scopeMetrics[0].metrics[1]);
  assert.equal(metrics[0].sum.aggregationTemporality, 2);
  for (const index of [0, 3]) {
    metrics[index].sum.dataPoints.forEach((point, i) => {
      assert.ok(later.resourceMetrics[0].scopeMetrics[0].metrics[index].sum.dataPoints[i].asDouble >= point.asDouble);
      assert.match(point.timeUnixNano, /^\d{19}$/);
    });
  }
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes('tenant.id') && !serialized.includes('agent.id'));
  assert.ok(Buffer.byteLength(JSON.stringify(metricsPayload('check', Array.from({ length: 10 }, (_, i) => i), start, start))) < 1024 * 1024);
  const logs = logsPayload('check', [0, 1], start);
  assert.equal(logs.resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber, 17);
  assert.equal(logs.resourceLogs[1].scopeLogs[0].logRecords[0].severityNumber, 9);
});

test('[http] OAuth is cached/single-flight and issuer mismatch stops before OTLP', async (t) => {
  let claims = {};
  const mock = await server(t, (_req, res) => res.end(JSON.stringify({ access_token: jwt(claims), expires_in: 300 })));
  const tokens = new AgentToken(credential, `${mock.url}/token`, 'http://test-issuer');
  const values = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
  assert.equal(mock.requests.length, 1); assert.equal(new Set(values).size, 1);
  assert.equal(new URLSearchParams(mock.requests[0].body).get('grant_type'), 'client_credentials');
  tokens.expires = 0; await tokens.get(); assert.equal(mock.requests.length, 2);
  claims = { iss: 'http://wrong-issuer' }; tokens.expires = 0;
  await assert.rejects(tokens.get(), /Issuer mismatch/);
  claims = { tenant_id: 'beta-tenant' };
  await assert.rejects(tokens.get(), /does not match/);
});

test('[http] partial success and HTTP errors never leak response bodies or retry partial data', async (t) => {
  let status = 200, response = { partialSuccess: { rejectedLogRecords: '1', errorMessage: 'trap-secret' } };
  const mock = await server(t, (_req, res) => { res.statusCode = status; res.end(JSON.stringify(response)); });
  const token = { get: async () => 'test-token' };
  await assert.rejects(exportPayload(mock.url, 'logs', {}, token), (e) => !e.message.includes('trap-secret') && /partial success/.test(e.message));
  assert.equal(mock.requests.length, 1);
  status = 401; response = { error: 'trap-secret' };
  await assert.rejects(requestJson(mock.url), (e) => e.status === 401 && !e.message.includes('trap-secret'));
});

test('[http] redirects and oversized responses are bounded and cannot forward credentials', async (t) => {
  const destination = await server(t, (_req, res) => res.end('{}'));
  let redirect = true;
  const origin = await server(t, (_req, res) => {
    if (redirect) { res.statusCode = 307; res.setHeader('location', destination.url); res.end(); }
    else res.end('x'.repeat(70000));
  });
  await assert.rejects(requestJson(origin.url, { method: 'POST', body: 'test-secret' }));
  assert.equal(destination.requests.length, 0);
  redirect = false;
  await assert.rejects(requestJson(origin.url), /too large/);
});

test('worker aborts promptly; fatal auth failure stops both pipelines', async () => {
  const abort = new AbortController(); const records = [], reports = [];
  const c = cfg({ tokenUrl: 'http://test/token', gatewayEndpoint: 'http://test', allowHttp: true, expectedIssuer: 'http://test' });
  const result = await generate(c, credential, 0, 'load', { signal: abort.signal, report: (r) => reports.push(r), send: async (kind, payload) => { records.push({ kind, payload }); if (records.length === 2) abort.abort(); } });
  assert.equal(records.length, 2); assert.ok(result.metricsAccepted > 0); assert.ok(reports.some((r) => r.includes('finished')));
  let failures = 0;
  await assert.rejects(generate(c, credential, 0, 'load', { report: () => {}, send: async () => { failures++; throw new RequestError('OTLP', 403); } }), /403/);
  assert.ok(failures <= 2);
});

test('transient failures are dropped with backoff, no immediate retry loop', async () => {
  const abort = new AbortController(); let sends = 0;
  const timer = setTimeout(() => abort.abort(), 150);
  try {
    const result = await generate(cfg({ logsPerSecond: 0, tokenUrl: 'http://test/token', gatewayEndpoint: 'http://test', allowHttp: true }), credential, 0, 'load', {
      signal: abort.signal, report: () => {}, send: async () => { sends++; throw new RequestError('OTLP', 429); },
    });
    assert.equal(sends, 1); assert.equal(result.failedBatches, 1); assert.equal(result.uncertainOrDroppedItems, 100);
  } finally { clearTimeout(timer); }
});

test('manifest security, sharding and source size: no operator credential or privileged mounts', async () => {
  const c = cfg({ hosts: 1000 });
  const manifest = job(c, 'observability', 'node:22.19.0-alpine', 'load');
  assert.equal(manifest.spec.completions, 10); assert.equal(manifest.spec.backoffLimit, 0);
  assert.equal(manifest.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(manifest.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(manifest.spec.template.spec.volumes.length, 2);
  assert.ok(!JSON.stringify(manifest).includes('hostPath'));
  const cm = configMap(c, 'observability', await sourceData());
  assert.ok(Buffer.byteLength(JSON.stringify(cm)) < 200000);
  assert.equal(cm.immutable, true);
});

test('Kubernetes Secret bytes only travel over stdin, errors are redacted', () => {
  let args, options;
  const kube = new Kubernetes('observability', (_file, a, o) => { args = a; options = o; return { status: 0, stdout: 'secret/test\n' }; });
  kube.create({ kind: 'Secret', data: { password: 'test-only-sensitive' } });
  assert.ok(!JSON.stringify(args).includes('test-only-sensitive'));
  assert.ok(options.input.includes('test-only-sensitive'));
  const fail = new Kubernetes('observability', () => ({ status: 1, stdout: 'trap-secret', stderr: 'trap-secret' }));
  assert.throws(() => fail.create({}), (e) => !e.message.includes('trap-secret'));
});

test('enrollment journals token before exchange, reuses credentials, and checks ownership', async () => {
  const kube = new FakeKube(); let calls = 0;
  const api = async (_method, path) => {
    calls++;
    if (path.endsWith('/exchange')) {
      assert.equal(secretValue(kube.get('secret', 'mtco-load-check-credentials')).enrollmentToken, 'test-once');
      return credential;
    }
    return { id: 'enrollment-1', enrollmentToken: 'test-once' };
  };
  const first = await ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => api);
  assert.equal(first.agentId, credential.agentId);
  assert.equal(secretValue(kube.get('secret', 'mtco-load-check-credentials')).enrollmentToken, undefined);
  await ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => { throw new Error('should not sign in twice'); });
  assert.equal(calls, 2);
  await assert.rejects(ensureCredentials(kube, 'check', 'beta-tenant', 'http://api', async () => api), /another/);
  kube.objects.get('secret/mtco-load-check-credentials').metadata.labels = {};
  await assert.rejects(ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => api), /collision/);
});

test('used enrollment does not silently create another agent and recovery revokes known agent', async () => {
  const kube = new FakeKube();
  kube.create({ kind: 'Secret', metadata: { name: 'mtco-load-check-credentials', labels: labels('check'), annotations: { 'mtco.test/api': 'http://api', 'mtco.test/tenant': 'alpha-tenant' } }, data: { 'credentials.json': Buffer.from(JSON.stringify({ enrollmentId: 'e1', enrollmentToken: 'test-once' })).toString('base64') } });
  let calls = 0;
  await assert.rejects(ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => async () => { calls++; throw new RequestError('exchange', 410); }), /not replayable/);
  assert.equal(calls, 1);
  const operations = [];
  await revokeCredentials(kube, 'check', async () => async (method, path) => { operations.push([method, path]); return { items: [{ id: 'e1', agentId: credential.agentId }] }; });
  assert.equal(operations[1][0], 'DELETE'); assert.ok(operations[1][1].endsWith(credential.agentId));
});

test('[http] deployment integrates enrollment and in-cluster probe before creating load; probe failure blocks it', async (t) => {
  const mock = await server(t, (req, res) => {
    if (req.url === '/api/v1/tenants/alpha-tenant/agent-enrollments') res.end(JSON.stringify({ id: 'e1', enrollmentToken: 'once' }));
    else if (req.url === '/api/v1/agent-enrollments/exchange') res.end(JSON.stringify({ ...credential, tokenUrl: `${mock.url}/token`, gatewayEndpoint: mock.url }));
    else if (req.url === '/token') res.end(JSON.stringify({ access_token: jwt(), expires_in: 300 }));
    else res.end('{}');
  });
  const output = []; const previous = console.log; console.log = (value) => output.push(String(value));
  t.after(() => { console.log = previous; });
  const kube = new FakeKube(); let probeDone = false;
  await main(['deploy', '--run', 'check', '--tenant', 'alpha-tenant', '--api-url', mock.url, '--issuer', 'http://test-issuer', '--allow-http'], {
    kube, login: async () => 'test-operator-token',
    waitProbe: async () => {
      assert.equal(kube.get('job', 'mtco-load-check'), null);
      const runtime = JSON.parse(kube.get('configmap', 'mtco-load-check').data['scenario.json']);
      await generate(runtime, secretValue(kube.get('secret', 'mtco-load-check-credentials')), 0, 'probe', { report: () => {} });
      probeDone = true;
    },
  });
  assert.equal(probeDone, true); assert.ok(kube.get('job', 'mtco-load-check'));
  assert.ok(mock.requests.some((r) => r.url === '/v1/metrics'));
  assert.ok(!output.join('').includes(credential.clientSecret));
  const other = new FakeKube();
  await assert.rejects(main(['deploy', '--run', 'other', '--tenant', 'alpha-tenant', '--api-url', mock.url, '--issuer', 'http://test-issuer', '--allow-http'], {
    kube: other, login: async () => 'test-operator-token', waitProbe: async () => { throw new Error('probe failed'); },
  }), /probe failed/);
  assert.equal(other.get('job', 'mtco-load-other'), null);
});

test('offline transport: OAuth refresh, claims, OTLP response handling and redaction', async (t) => {
  let calls = 0, claims = {}, status = 200, payload = '{}', contentType = 'application/json';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: jwt(claims), expires_in: 300 }));
    assert.equal(options.headers.authorization, 'Bearer test-token');
    return new Response(payload, { status, headers: { 'content-type': contentType } });
  });
  const tokens = new AgentToken(credential, 'http://test/token', 'http://test-issuer');
  await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
  assert.equal(calls, 1);
  tokens.expires = 0; await tokens.get(); assert.equal(calls, 2);
  for (const invalid of [{ iss: 'wrong' }, { aud: 'wrong' }, { tenant_id: 'other' }, { agent_id: 'other' }, { vm_account_id: null }, { exp: 1 }]) {
    tokens.expires = 0; claims = invalid; await assert.rejects(tokens.get());
  }
  const send = () => exportPayload('http://test', 'metrics', {}, { get: async () => 'test-token' });
  await send();
  for (const body of ['null', '[]', '', 'not JSON', 'x'.repeat(70000), '{"partialSuccess":{"rejectedDataPoints":"1","errorMessage":"trap-secret"}}']) {
    payload = body; await assert.rejects(send(), (e) => !e.message.includes('trap-secret'));
  }
  payload = '{}'; status = 202; await assert.rejects(send());
  status = 200; contentType = 'text/html'; await assert.rejects(send(), /expected JSON/);
  status = 403; payload = 'trap-secret';
  await assert.rejects(send(), (e) => e.status === 403 && !e.message.includes('trap-secret'));
});

test('offline deployment: journal, probe gate, immutable runs, and rejected plans', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    const body = url.endsWith('/exchange') ? credential : { id: 'e1', enrollmentToken: 'once' };
    return new Response(JSON.stringify(body));
  });
  const args = ['deploy', '--run', 'check', '--tenant', 'alpha-tenant', '--issuer', 'http://test-issuer', '--allow-http'];
  const kube = new FakeKube(); let checked = false;
  await main(args, { kube, login: async () => 'operator-test', waitProbe: async () => {
    assert.equal(kube.get('job', 'mtco-load-check'), null);
    assert.equal(secretValue(kube.get('secret', 'mtco-load-check-credentials')).clientId, credential.clientId);
    checked = true;
  } });
  assert.ok(checked); assert.ok(kube.get('job', 'mtco-load-check'));
  assert.equal(requests.length, 2);
  await assert.rejects(main(args, { kube }), /already has/);
  const rejected = new FakeKube();
  await assert.rejects(main([...args, '--hosts', '10000'], { kube: rejected }), /pod budget/);
  assert.equal(rejected.events.length, 0);
  const failed = new FakeKube();
  await assert.rejects(main(args, { kube: failed, login: async () => 'operator-test', waitProbe: async () => { throw new Error('probe failed'); } }), /probe failed/);
  assert.equal(failed.get('job', 'mtco-load-check'), null);
});

test('stop and cleanup affect only owned resources and revoke before removal', async (t) => {
  t.mock.method(console, 'log', () => {});
  const kube = new FakeKube();
  await ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => async (_method, path) =>
    path.endsWith('/exchange') ? credential : { id: 'e1', enrollmentToken: 'once' });
  kube.create(job(cfg(), 'observability', 'node:test', 'load'));
  kube.create(job(cfg({ run: 'other' }), 'observability', 'node:test', 'load'));
  kube.create(configMap(cfg(), 'observability', {}));
  await main(['stop', '--run', 'check'], { kube });
  assert.equal(kube.get('job', 'mtco-load-check').spec.suspend, true);
  assert.equal(kube.get('job', 'mtco-load-other').spec.suspend, undefined);
  assert.ok(kube.get('secret', 'mtco-load-check-credentials'));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(kube.events.some((e) => e.startsWith('delete:')), false);
    kube.events.push('agent-revoked'); return new Response(null, { status: 204 });
  });
  await main(['cleanup', '--run', 'check', '--allow-http'], { kube, login: async () => 'operator-test' });
  assert.equal(kube.get('secret', 'mtco-load-check-credentials'), null);
  assert.ok(kube.get('job', 'mtco-load-other'));
  assert.ok(kube.events.findIndex((e) => e.startsWith('delete:')) > kube.events.indexOf('agent-revoked'));
});

test('cleanup is retryable after revocation; pending and corrupt journals are handled safely', async () => {
  const kube = new FakeKube();
  await ensureCredentials(kube, 'check', 'alpha-tenant', 'http://api', async () => async (_method, path) =>
    path.endsWith('/exchange') ? credential : { id: 'e1', enrollmentToken: 'once' });
  await revokeCredentials(kube, 'check', async () => async (method) => {
    if (method === 'DELETE') throw new RequestError('api', 404);
    return { items: [] };
  });
  await assert.rejects(revokeCredentials(kube, 'check', async () => async () => { throw new RequestError('api', 403); }), /403/);
  const secret = kube.objects.get('secret/mtco-load-check-credentials');
  secret.data['credentials.json'] = Buffer.from(JSON.stringify({ enrollmentId: 'e1', enrollmentToken: 'once' })).toString('base64');
  const operations = [];
  await revokeCredentials(kube, 'check', async () => async (method, path) => {
    operations.push([method, path]); return { items: [{ id: 'e1', agentId: null, state: 'pending' }] };
  });
  assert.deepEqual(operations.at(-1), ['DELETE', '/tenants/alpha-tenant/agent-enrollments/e1']);
  await assert.rejects(revokeCredentials(kube, 'check', async () => async () => ({ items: [] })), /no longer/);
  secret.data['credentials.json'] = Buffer.from('{}').toString('base64');
  await assert.rejects(revokeCredentials(kube, 'check', async () => { throw new Error('must not log in'); }), /Incomplete/);
});

test('slow receivers cannot create concurrent batches within a pipeline or a catch-up queue', async () => {
  const abort = new AbortController(); let inFlight = 0, peak = 0, sent = 0;
  const c = cfg({ logsPerSecond: 0, metricIntervalSeconds: 1, maxMetricPointsPerSecond: 1000000,
    tokenUrl: 'http://test/token', gatewayEndpoint: 'http://test', allowHttp: true });
  await generate(c, credential, 0, 'load', { signal: abort.signal, report: () => {}, send: async () => {
    peak = Math.max(peak, ++inFlight); sent++;
    await new Promise((resolve) => setTimeout(resolve, 120));
    inFlight--; if (sent === 2) abort.abort();
  } });
  assert.equal(sent, 2); assert.equal(peak, 1);
});
