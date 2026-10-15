// Synthetic hosts, not node scrapers. Names/labels match the existing MTCO dashboard.
import { POINTS_PER_HOST } from './config.mjs';
export { POINTS_PER_HOST };
const attributes = (values) => Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
const nanos = (ms) => (BigInt(Math.trunc(ms)) * 1000000n).toString();
const scope = { name: 'mtco.loadgen', version: '1.0.0' };

export function resource(run, id) {
  return { attributes: attributes({
    'host.name': `${run}-host-${String(id + 1).padStart(6, '0')}`,
    'host.arch': 'amd64', 'os.type': 'linux', 'mtco.testing': 'true', 'mtco.test.run': run,
  }) };
}

export function hostMetrics(run, id, now, started) {
  const elapsed = Math.max(0, (now - started) / 1000);
  const phase = ((id * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
  const load = 0.4 + 0.2 * Math.sin(elapsed / 60 + phase);
  const memory = (4 + id % 5) * 1024 ** 3;
  const disk = (40 + id % 8 * 10) * 1024 ** 3;
  // Integral of a positive rate: monotonic counters despite changing utilization.
  const userTime = 0.3 * elapsed + 6 * (Math.cos(phase) - Math.cos(elapsed / 60 + phase));
  const point = (value, attrs = {}) => ({
    attributes: attributes(attrs), timeUnixNano: nanos(now), startTimeUnixNano: nanos(started), asDouble: value,
  });
  const gauge = (name, unit, dataPoints) => ({ name, unit, gauge: { dataPoints } });
  const sum = (name, unit, monotonic, dataPoints) => ({
    name, unit, sum: { aggregationTemporality: 2, isMonotonic: monotonic, dataPoints },
  });
  return { resource: resource(run, id), scopeMetrics: [{ scope, metrics: [
    sum('system.cpu.time', 's', true, [
      point(elapsed - userTime - elapsed * 0.1, { cpu: '0', state: 'idle' }),
      point(userTime, { cpu: '0', state: 'user' }), point(elapsed * 0.1, { cpu: '0', state: 'system' }),
    ]),
    sum('system.memory.usage', 'By', false, [point(memory * load, { state: 'used' }), point(memory * (1 - load), { state: 'free' })]),
    gauge('system.cpu.load_average.1m', '1', [point(load * 2)]),
    sum('system.network.io', 'By', true, [
      point(elapsed * (10000 + id % 100 * 100), { device: 'eth0', direction: 'receive' }),
      point(elapsed * (5000 + id % 100 * 50), { device: 'eth0', direction: 'transmit' }),
    ]),
    sum('system.filesystem.usage', 'By', false, [
      point(disk * 0.6, { mountpoint: '/', device: '/dev/sda1', state: 'used' }),
      point(disk * 0.4, { mountpoint: '/', device: '/dev/sda1', state: 'free' }),
    ]),
  ] }] };
}

export function metricsPayload(run, ids, now, started) {
  return { resourceMetrics: ids.map((id) => hostMetrics(run, id, now, started)) };
}

export function logsPayload(run, ids, now, sequence = 0) {
  return { resourceLogs: ids.map((id, i) => {
    const error = (id * 31 + sequence + i) % 23 === 0;
    return { resource: resource(run, id), scopeLogs: [{ scope, logRecords: [{
      timeUnixNano: nanos(now), observedTimeUnixNano: nanos(now),
      severityNumber: error ? 17 : 9, severityText: error ? 'ERROR' : 'INFO',
      body: { stringValue: error ? 'Synthetic upstream timeout' : 'Synthetic request completed' },
      attributes: attributes({ 'service.name': `synthetic-service-${id % 4}`, 'mtco.sequence': sequence + i }),
    }] }] };
  }) };
}
