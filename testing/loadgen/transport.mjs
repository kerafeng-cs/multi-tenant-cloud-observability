// OTLP/HTTP JSON; deliberately never include response bodies, headers or URLs in errors.
export class RequestError extends Error {
  constructor(stage, status = 0) {
    super(`${stage} failed (HTTP ${status || 'unavailable'})`);
    this.status = status;
  }
}

export async function requestJson(url, options = {}, stage = 'request') {
  const { signal, timeoutMs = 10000, expectedStatus, ...rest } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      ...rest, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || (expectedStatus !== undefined && response.status !== expectedStatus)) {
      await response.body?.cancel();
      throw new RequestError(stage, response.status);
    }
    if (expectedStatus !== undefined && !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new RequestError(`${stage}: expected JSON response`, response.status);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 65536) throw new RequestError(`${stage}: response too large`, response.status);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      const value = text ? JSON.parse(text) : (expectedStatus === undefined ? {} : null);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    }
    catch { throw new RequestError(`${stage}: invalid JSON`, response.status); }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(stage);
  }
}

export class AgentToken {
  constructor(credentials, tokenUrl, expectedIssuer, signal) {
    this.credentials = credentials;
    this.tokenUrl = tokenUrl;
    this.expectedIssuer = expectedIssuer;
    this.signal = signal;
    this.expires = 0;
  }

  async get() {
    if (this.value && Date.now() < this.expires) return this.value;
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async refresh() {
    const result = await requestJson(this.tokenUrl, {
      method: 'POST', signal: this.signal,
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }),
    }, 'agent token');
    let claims;
    try { claims = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new Error('Token endpoint returned an invalid token'); }
    // Diagnostic only. The actual signature/issuer/audience enforcement remains at otel-gateway.
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.expectedIssuer) throw new Error('Issuer mismatch; fix the token endpoint/issuer configuration before opening load');
    if (claims.tenant_id !== this.credentials.tenantKey || claims.agent_id !== this.credentials.agentId ||
      typeof claims.vm_account_id !== 'string' || !/^\d+$/.test(claims.vm_account_id) || !audiences.includes('otel-gateway')) {
      throw new Error('Agent token does not match the enrolled tenant/agent/audience');
    }
    const ttl = Math.min(Number(result.expires_in), Number(claims.exp) - Date.now() / 1000);
    if (!Number.isFinite(ttl) || ttl < 5) throw new Error('Agent token has no usable expiration');
    this.value = result.access_token;
    this.expires = Date.now() + (ttl - Math.min(10, ttl / 4)) * 1000;
    return this.value;
  }
}

export async function exportPayload(endpoint, signalName, payload, token, signal) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Generated batch exceeds 1 MiB');
  const result = await requestJson(`${endpoint}/v1/${signalName}`, {
    method: 'POST', signal, expectedStatus: 200,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token.get()}` }, body,
  }, `OTLP ${signalName}`);
  const partial = result.partialSuccess ?? result.partial_success;
  if (partial && (Number(partial.rejectedDataPoints ?? partial.rejected_data_points ?? 0) > 0 ||
    Number(partial.rejectedLogRecords ?? partial.rejected_log_records ?? 0) > 0 || partial.errorMessage || partial.error_message)) {
    // Never retry partial success; some records may already have been accepted.
    throw new Error(`OTLP ${signalName} returned partial success; stopping load`);
  }
}
