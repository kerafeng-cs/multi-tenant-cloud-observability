import { createInterface } from 'node:readline/promises';
import { requestJson } from './transport.mjs';
import { assertOwned, labels } from './kubernetes.mjs';

export async function passwordPrompt(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !input.setRawMode) throw new Error('Interactive terminal required for password entry');
  output.write('Keycloak password (hidden): ');
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', onData); input.setRawMode(wasRaw); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const onData = (data) => {
      for (const char of data.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')) {
        if (char === '\u0003') return finish(new Error('Cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}

export async function login(tokenUrl, username) {
  if (!username) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { username = (await prompt.question('Keycloak username: ')).trim(); }
    finally { prompt.close(); }
  }
  if (!username) throw new Error('Username is required');
  let password = await passwordPrompt();
  try {
    const result = await requestJson(tokenUrl, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'mtco-cli', username, password }),
    }, 'operator sign-in');
    if (typeof result.access_token !== 'string') throw new Error('Sign-in returned no access token');
    return result.access_token;
  } finally { password = ''; }
}

export function apiClient(apiUrl, bearer) {
  return (method, path, body) => requestJson(`${apiUrl}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 'control-plane');
}

export function secretValue(secret) {
  try { return JSON.parse(Buffer.from(secret.data['credentials.json'], 'base64').toString('utf8')); }
  catch { throw new Error('Managed credential Secret is invalid; refusing to overwrite it'); }
}

export function validateCredentials(value, tenant) {
  if (value.tenantKey !== tenant || ![value.clientId, value.clientSecret, value.agentId, value.tokenUrl, value.gatewayEndpoint].every((v) => typeof v === 'string' && v.length > 0)) {
    throw new Error('Enrolled credentials do not match the requested tenant or contract');
  }
  return value;
}

export async function ensureCredentials(kube, run, tenant, apiUrl, getApi) {
  const resourceName = `mtco-load-${run}-credentials`;
  let secret = kube.get('secret', resourceName);
  if (secret) {
    assertOwned(secret, run);
    if (secret.metadata.annotations?.['mtco.test/api'] !== apiUrl || secret.metadata.annotations?.['mtco.test/tenant'] !== tenant) {
      throw new Error('Run already belongs to another API endpoint or tenant');
    }
    const value = secretValue(secret);
    if (value.clientSecret) return validateCredentials(value, tenant);
  }
  const api = await getApi();
  if (!secret) {
    const enrollment = await api('POST', `/tenants/${tenant}/agent-enrollments`);
    if (typeof enrollment.enrollmentToken !== 'string' || typeof enrollment.id !== 'string') throw new Error('Invalid enrollment response');
    secret = {
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: resourceName, namespace: kube.namespace, labels: labels(run), annotations: { 'mtco.test/api': apiUrl, 'mtco.test/tenant': tenant } },
      data: { 'credentials.json': Buffer.from(JSON.stringify({ tenantKey: tenant, enrollmentId: enrollment.id, enrollmentToken: enrollment.enrollmentToken })).toString('base64') },
    };
    // Persist the one-time token BEFORE exchanging. Never put credentials in a file or command argument.
    kube.create(secret);
    secret = kube.get('secret', resourceName);
  }
  const pending = secretValue(secret);
  if (!pending.enrollmentToken) throw new Error('Incomplete enrollment journal; inspect this run before retrying');
  let value;
  try { value = validateCredentials(await api('POST', '/agent-enrollments/exchange', { token: pending.enrollmentToken }), tenant); }
  catch (error) {
    if (error.status === 410) throw new Error('Enrollment already used/expired/revoked. Credentials are not replayable by the API; run cleanup, then use a new run name. No new agent was automatically created.');
    throw error;
  }
  secret.data = { 'credentials.json': Buffer.from(JSON.stringify({ ...value, enrollmentId: pending.enrollmentId })).toString('base64') };
  // A failed write may have succeeded remotely; retry saving the SAME credentials, never re-enroll.
  for (let attempt = 0; ; attempt++) {
    try { kube.replace(secret); break; }
    catch (error) {
      if (attempt === 2) throw new Error(`Credential persistence failed for agent ${value.agentId}; retain the run Secret for recovery and revoke this agent before starting a new run`);
      const latest = kube.get('secret', resourceName);
      if (latest) { assertOwned(latest, run); secret.metadata.resourceVersion = latest.metadata.resourceVersion; }
    }
  }
  return value;
}

export async function revokeCredentials(kube, run, getApi) {
  const secret = kube.get('secret', `mtco-load-${run}-credentials`);
  if (!secret) return;
  assertOwned(secret, run);
  const value = secretValue(secret);
  const tenant = secret.metadata.annotations['mtco.test/tenant'];
  if (!value.agentId && !value.enrollmentId) throw new Error('Incomplete enrollment journal; refusing cleanup without a known agent or enrollment');
  const api = await getApi(secret.metadata.annotations['mtco.test/api']);
  let agentId = value.agentId;
  if (!agentId && value.enrollmentId) {
    const { items } = await api('GET', `/tenants/${tenant}/agent-enrollments`);
    const entry = items?.find((item) => item.id === value.enrollmentId);
    if (!entry) throw new Error('Enrollment no longer in the API recent list; inspect/revoke its agent manually before deleting the journal');
    agentId = entry.agentId;
    if (!agentId) await api('DELETE', `/tenants/${tenant}/agent-enrollments/${value.enrollmentId}`);
  }
  if (agentId) {
    try { await api('DELETE', `/tenants/${tenant}/agents/${agentId}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      // A previous cleanup may have revoked the agent before being interrupted.
      // Confirm the collection still exists; never swallow a wrong API route's 404.
      const { items } = await api('GET', `/tenants/${tenant}/agents`);
      if (!Array.isArray(items) || items.some((item) => item.id === agentId)) throw error;
    }
  }
}
