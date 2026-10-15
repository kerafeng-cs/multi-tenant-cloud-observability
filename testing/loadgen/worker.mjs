import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, endpoint, partition, POINTS_PER_HOST } from './config.mjs';
import { metricsPayload, logsPayload } from './model.mjs';
import { AgentToken, exportPayload, RequestError } from './transport.mjs';

export async function generate(config, credentials, ordinal, mode, { signal, send, report = console.log } = {}) {
  const c = configuration(config);
  const shard = partition(c, ordinal);
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  const token = new AgentToken(credentials, endpoint(c.tokenUrl, c.allowHttp), c.expectedIssuer, combined);
  const target = endpoint(c.gatewayEndpoint, c.allowHttp);
  const transmit = send ?? ((kind, payload) => exportPayload(target, kind, payload, token, combined));
  const stats = { metricsAccepted: 0, logsAccepted: 0, failedBatches: 0, uncertainOrDroppedItems: 0 };
  const emit = (event) => report(JSON.stringify({ event, worker: ordinal, ...stats }));
  const started = Date.now();
  if (mode === 'probe') {
    await transmit('metrics', metricsPayload(c.run, [0], Date.now(), started));
    await transmit('logs', logsPayload(c.run, [0], Date.now()));
    emit('probe_accepted');
    return stats;
  }
  if (mode !== 'load') throw new Error('Unknown worker mode');
  const deadline = setTimeout(() => abort.abort(), (c.durationSeconds + c.rampSeconds) * 1000);
  const reporter = setInterval(() => emit('progress'), 30000);
  let fatal;
  async function loop(kind, rate, size, units) {
    if (rate === 0) return;
    let cursor = 0, sequence = 0, failures = 0;
    const beginDelay = c.rampSeconds * 1000 * ordinal / Math.max(1, c.pods);
    await delay(beginDelay, undefined, { signal: combined });
    const end = Date.now() + c.durationSeconds * 1000;
    while (!combined.aborted && Date.now() < end) {
      const count = Math.min(size, shard.count - cursor);
      const ids = Array.from({ length: count }, (_, i) => shard.start + cursor + i);
      const payload = kind === 'metrics'
        ? metricsPayload(c.run, ids, Date.now(), started)
        : logsPayload(c.run, ids, Date.now(), sequence);
      const sentAt = performance.now();
      let backoff = 0;
      try {
        await transmit(kind, payload);
        stats[kind === 'metrics' ? 'metricsAccepted' : 'logsAccepted'] += count * units;
        failures = 0;
      } catch (error) {
        if (combined.aborted) break;
        stats.failedBatches++;
        stats.uncertainOrDroppedItems += count * units;
        failures++;
        if (!(error instanceof RequestError) || ![0, 429, 502, 503, 504].includes(error.status) || failures >= 5) {
          throw error;
        }
        // Drop this batch. Bounded backoff, no backlog and no catch-up bursts.
        backoff = Math.min(30000, 1000 * 2 ** (failures - 1)) * (1 + ordinal % 7 / 10);
      }
      cursor = (cursor + count) % shard.count;
      sequence += count;
      const spacing = count * units / rate * 1000;
      await delay(Math.max(backoff, spacing - (performance.now() - sentAt), 1), undefined, { signal: combined });
    }
  }
  try {
    await Promise.all([
      loop('metrics', shard.metricPointsPerSecond, 10, POINTS_PER_HOST),
      loop('logs', shard.logsPerSecond, Math.min(10, Math.max(1, Math.floor(shard.logsPerSecond))), 1),
    ].map((promise) => promise.catch((error) => {
      if (!combined.aborted) { fatal = error; abort.abort(); }
    })));
  } finally {
    clearTimeout(deadline); clearInterval(reporter); abort.abort();
    emit(fatal ? 'failed' : 'finished');
  }
  if (fatal) throw fatal;
  return stats;
}

async function main() {
  let config, credentials;
  try {
    config = JSON.parse(await readFile('/config/scenario.json', 'utf8'));
    credentials = JSON.parse(await readFile('/credentials/credentials.json', 'utf8'));
  } catch {
    // JSON parse errors can include the input, which would expose a malformed Secret.
    throw new Error('Unable to read generator configuration or credentials');
  }
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  await generate(config, credentials, Number(process.env.WORKER_INDEX ?? 0), process.env.MODE ?? 'load', { signal: abort.signal });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
