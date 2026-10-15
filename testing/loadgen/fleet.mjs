#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, endpoint, name, plan } from './config.mjs';
import { Kubernetes, assertOwned, configMap, job, sourceData } from './kubernetes.mjs';
import { apiClient, ensureCredentials, login, revokeCredentials } from './enrollment.mjs';

const numericOptions = {
  hosts: 'hosts', 'hosts-per-pod': 'hostsPerPod', duration: 'durationSeconds',
  'metric-interval': 'metricIntervalSeconds', 'metric-points-per-second': 'maxMetricPointsPerSecond',
  'logs-per-second': 'logsPerSecond', ramp: 'rampSeconds', 'max-pods': 'maxPods',
};
export function argumentsFor(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    ...Object.fromEntries(['run', 'tenant', 'namespace', 'api-url', 'keycloak-url', 'token-url', 'gateway-url', 'issuer', 'user', 'image', ...Object.keys(numericOptions)].map((key) => [key, { type: 'string' }])),
    'allow-http': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) return { help: true };
  if (!['plan', 'deploy', 'status', 'stop', 'cleanup'].includes(command) || positionals.length !== 1) throw new Error('Use plan, deploy, status, stop or cleanup');
  name(values.run, 'run');
  if (values.run.length > 32) throw new Error('run: maximum 32 characters');
  const namespace = name(values.namespace ?? 'observability', 'namespace');
  const config = ['plan', 'deploy'].includes(command) ? configuration({
    run: values.run, tenant: values.tenant,
    ...Object.fromEntries(Object.entries(numericOptions).filter(([flag]) => values[flag] !== undefined).map(([flag, key]) => [key, Number(values[flag])])),
  }) : null;
  return { command, values, namespace, config };
}

const help = `MTCO synthetic host fleet (Node 22+, no npm packages)
  node testing/loadgen/fleet.mjs plan --run smoke --tenant alpha-tenant --hosts 100
  node testing/loadgen/fleet.mjs deploy --run smoke --tenant alpha-tenant --hosts 100 --allow-http
  node testing/loadgen/fleet.mjs status --run smoke
  node testing/loadgen/fleet.mjs stop --run smoke
  node testing/loadgen/fleet.mjs cleanup --run smoke --allow-http

Endpoints: --api-url (operator -> control-plane, default http://localhost:18081)
           --keycloak-url (operator login base, default http://localhost:8080)
           --token-url (pods -> full agent token URL; default enrollment result)
           --gateway-url (pods -> OTLP base URL; default enrollment result)
           --issuer (expected JWT iss; default platform-endpoints ConfigMap)
Sizing: --hosts 100 --hosts-per-pod 100 --duration 600 --metric-interval 15
        --metric-points-per-second 500 --logs-per-second 5 --ramp 30 --max-pods 10
Other: --namespace observability --user admin --image node:22.19.0-alpine
HTTP requires explicit --allow-http. TLS verification is never disabled.
Rates are TOTAL for this run, not per pod. Different runs add their rates.
Deploy calls kubectl ONLY when the operator executes it. Plan is offline.
`;

export function summarizeJob(object) {
  return { name: object.metadata.name, suspended: object.spec.suspend ?? false,
    active: object.status?.active ?? 0, succeeded: object.status?.succeeded ?? 0,
    failed: object.status?.failed ?? 0, conditions: object.status?.conditions?.map(({ type, status }) => ({ type, status })) ?? [] };
}

async function waitProbe(kube, resourceName) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const value = kube.get('job', resourceName);
    if (value?.status?.conditions?.some((c) => c.type === 'Complete' && c.status === 'True')) return;
    if (value?.status?.failed || value?.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True')) {
      throw new Error(`Preflight failed. Load was not started. Inspect: kubectl -n ${kube.namespace} logs job/${resourceName}`);
    }
    await delay(2000);
  }
  // A timed-out preflight must not keep sending, even if scheduling was slow.
  kube.suspend(resourceName);
  throw new Error(`Preflight timed out and was suspended: ${resourceName}. Load was not started.`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = argumentsFor(argv);
  if (args.help) { console.log(help); return; }
  const { command, values: v, namespace, config } = args;
  if (command === 'plan') { console.log(JSON.stringify(plan(config), null, 2)); return; }
  const kube = dependencies.kube ?? new Kubernetes(namespace);
  const run = v.run;
  const base = `mtco-load-${run}`;
  let bearer;
  const getApi = async (override) => {
    const apiUrl = endpoint(override ?? v['api-url'] ?? 'http://localhost:18081', v['allow-http']);
    const keycloak = endpoint(v['keycloak-url'] ?? 'http://localhost:8080', v['allow-http']);
    bearer ??= await (dependencies.login ?? login)(`${keycloak}/realms/observability/protocol/openid-connect/token`, v.user);
    return apiClient(apiUrl, bearer);
  };
  if (command === 'status') {
    console.log(JSON.stringify(kube.list('jobs', run).map(summarizeJob), null, 2)); return;
  }
  if (command === 'stop' || command === 'cleanup') {
    const jobs = kube.list('jobs', run);
    for (const value of jobs) assertOwned(value, run);
    for (const value of jobs) kube.suspend(value.metadata.name);
    console.log('Run suspended; no new generator pods will start. Stored telemetry is retained.');
    if (command === 'stop') return;
    await revokeCredentials(kube, run, getApi);
    // Exact owned resources only. No namespace deletion and no data/index deletion.
    for (const kind of ['jobs', 'configmaps', 'secrets']) {
      for (const value of kube.list(kind, run)) { assertOwned(value, run); kube.delete(kind, value.metadata.name); }
    }
    console.log('Owned test resources removed; enrolled agent revoked. Stored telemetry is retained.');
    return;
  }
  const summary = plan(config);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.deployAllowed) throw new Error('Plan exceeds the selected pod budget or duration; adjust the plan before deploy');
  const existingJob = kube.get('job', base);
  if (existingJob) {
    assertOwned(existingJob, run);
    throw new Error('Run name already has a load Job. Use status/stop/cleanup; a new run name is required for a different or repeated test.');
  }
  const apiUrl = endpoint(v['api-url'] ?? 'http://localhost:18081', v['allow-http']);
  const issuer = v.issuer ?? kube.get('configmap', 'platform-endpoints')?.data?.KEYCLOAK_ISSUER;
  if (!issuer) throw new Error('Expected issuer is missing; set --issuer or platform-endpoints.KEYCLOAK_ISSUER');
  endpoint(issuer, v['allow-http']);
  // Validate supplied pod endpoints before creating any agent.
  if (v['token-url']) endpoint(v['token-url'], v['allow-http']);
  if (v['gateway-url']) endpoint(v['gateway-url'], v['allow-http']);
  const credentials = await ensureCredentials(kube, run, config.tenant, apiUrl, () => getApi());
  const runtime = { ...config, expectedIssuer: issuer, allowHttp: v['allow-http'],
    tokenUrl: endpoint(v['token-url'] ?? credentials.tokenUrl, v['allow-http']),
    gatewayEndpoint: endpoint(v['gateway-url'] ?? credentials.gatewayEndpoint, v['allow-http']),
  };
  const cm = configMap(runtime, namespace, await sourceData());
  const existingConfig = kube.get('configmap', base);
  if (existingConfig) {
    assertOwned(existingConfig, run);
    if (existingConfig.metadata.annotations?.['mtco.test/digest'] !== cm.metadata.annotations['mtco.test/digest']) {
      throw new Error('Run configuration is immutable. Cleanup this attempt and use a new run name for changed settings.');
    }
  } else kube.create(cm);
  const image = v.image ?? 'node:22.19.0-alpine';
  const probe = job(runtime, namespace, image, 'probe', Date.now().toString(36));
  kube.create(probe);
  console.log(`Checking one host from inside the cluster: ${probe.metadata.name}`);
  await (dependencies.waitProbe ?? waitProbe)(kube, probe.metadata.name);
  kube.create(job(runtime, namespace, image, 'load'));
  console.log(`Created load Job for ${config.pods} generator pod(s), ${config.hosts} synthetic hosts. Check status for actual progress. Run: ${run}`);
  console.log(`Status: node testing/loadgen/fleet.mjs status --run ${run} --namespace ${namespace}`);
  console.log(`Stop: node testing/loadgen/fleet.mjs stop --run ${run} --namespace ${namespace}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
