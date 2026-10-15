// No dependencies: shared by the offline planner, deployment CLI and workers.
export const POINTS_PER_HOST = 10;
export const DEFAULTS = Object.freeze({
  hosts: 100, hostsPerPod: 100, durationSeconds: 600,
  metricIntervalSeconds: 15, maxMetricPointsPerSecond: 500,
  logsPerSecond: 5, rampSeconds: 30, maxPods: 10,
});

export function name(value, label = 'name') {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
    throw new Error(`${label}: use 1-40 lowercase letters, digits or hyphens`);
  }
  return value;
}

function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}: expected ${integer ? 'integer' : 'number'} in ${min}..${max}`);
  }
  return value;
}

export function configuration(input) {
  const c = { ...DEFAULTS, ...input };
  name(c.run, 'run');
  if (c.run.length > 32) throw new Error('run: maximum 32 characters (room for Kubernetes resource suffixes)');
  if (typeof c.tenant !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(c.tenant)) {
    throw new Error('tenant must be an existing MTCO tenant key');
  }
  number(c.hosts, 'hosts', 1, 100000, true);
  number(c.hostsPerPod, 'hostsPerPod', 1, 1000, true);
  number(c.durationSeconds, 'durationSeconds', 30, 86400, true);
  number(c.metricIntervalSeconds, 'metricIntervalSeconds', 1, 3600);
  number(c.maxMetricPointsPerSecond, 'maxMetricPointsPerSecond', 1, 1000000);
  number(c.logsPerSecond, 'logsPerSecond', 0, 100000);
  number(c.rampSeconds, 'rampSeconds', 0, 3600);
  number(c.maxPods, 'maxPods', 1, 1000, true);
  c.pods = Math.ceil(c.hosts / c.hostsPerPod);
  c.effectiveMetricInterval = Math.max(c.metricIntervalSeconds, c.hosts * POINTS_PER_HOST / c.maxMetricPointsPerSecond);
  return c;
}

export function partition(c, ordinal) {
  number(ordinal, 'worker ordinal', 0, c.pods - 1, true);
  const start = ordinal * c.hostsPerPod;
  const count = Math.min(c.hostsPerPod, c.hosts - start);
  return {
    start, count,
    metricPointsPerSecond: count * POINTS_PER_HOST / c.effectiveMetricInterval,
    logsPerSecond: c.logsPerSecond * count / c.hosts,
  };
}

export function endpoint(value, allowHttp = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid endpoint URL'); }
  if ((!allowHttp && url.protocol !== 'https:') || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Endpoints require HTTPS, no userinfo/query/fragment; development HTTP needs --allow-http');
  }
  return url.href.replace(/\/$/, '');
}

export function plan(c) {
  return {
    run: c.run, tenant: c.tenant, hosts: c.hosts, pods: c.pods,
    hostsPerPod: c.hostsPerPod, durationSeconds: c.durationSeconds,
    effectiveMetricIntervalSeconds: c.effectiveMetricInterval,
    metricPointsPerSecond: c.hosts * POINTS_PER_HOST / c.effectiveMetricInterval,
    logsPerSecond: c.logsPerSecond,
    estimatedMetricSeries: c.hosts * POINTS_PER_HOST,
    requests: { cpuMillicores: c.pods * 50, memoryMi: c.pods * 64 },
    limits: { cpuMillicores: c.pods * 250, memoryMi: c.pods * 128 },
    deployAllowed: c.pods <= c.maxPods && c.durationSeconds >= c.effectiveMetricInterval,
    warnings: [
      ...(c.pods > c.maxPods ? [`${c.pods} pods exceeds maxPods=${c.maxPods}; review capacity before raising the limit`] : []),
      ...(c.durationSeconds < c.effectiveMetricInterval ? ['Duration is shorter than one full metric cycle; increase duration or rate budget'] : []),
      'Rates are fleet-wide targets; slow receivers reduce actual throughput. No catch-up queue.',
      'Resource limits constrain generators, not the load they impose on storage.',
    ],
  };
}
