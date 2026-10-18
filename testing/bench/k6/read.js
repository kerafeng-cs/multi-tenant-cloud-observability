// Phase 4: dashboard-like reads through query-gateway, like Grafana does:
// operator token (refreshed by each VU before it expires) + the tenant
// scope headers of a tenant org datasource (TODO-19), so every query is
// narrowed to the bench tenant exactly as in the product.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import exec from 'k6/execution';

const RATE = Number(__ENV.RATE);
// The first WARMUP seconds (VUs signing in, cold caches, first JWKS/TCP
// setup) are tagged phase:warmup and reported apart from steady state.
const WARMUP_S = Number(__ENV.WARMUP || 30);
const NAMES = ['vm_range_1h_cpu', 'vm_range_1h_mem', 'vm_range_6h_net', 'vm_instant_hosts', 'os_search_15m'];
const DURATION = __ENV.DURATION;
const QG = 'http://query-gateway:8080';
const TOKEN_URL = 'http://keycloak:8080/realms/observability/protocol/openid-connect/token';
const SCOPE = {
  'X-MTCO-Scope-Tenant': __ENV.TENANT,
  'X-MTCO-Scope-Account': __ENV.VM_ACCOUNT,
};

export const errors = new Rate('errors');

export const options = {
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  // Exposes the query-only latencies (token refreshes excluded) in the
  // summary; the threshold itself always passes.
  thresholds: Object.fromEntries([
    'http_req_duration{kind:query,phase:main}',
    'http_req_duration{kind:query,phase:warmup}',
    ...NAMES.map((n) => `http_req_duration{name:${n},phase:main}`),
  ].map((m) => [m, ['max>=0']])),
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.min(20 + RATE * 2, 400),
      maxVUs: Math.min(50 + RATE * 6, 1200),
    },
  },
};

let token = null;
let expiresAt = 0;

function bearer() {
  if (token && Date.now() < expiresAt) return token;
  const res = http.post(TOKEN_URL, {
    grant_type: 'password',
    client_id: 'mtco-bench-reader',
    username: __ENV.OPERATOR_USERNAME,
    password: __ENV.OPERATOR_PASSWORD,
  }, { tags: { name: 'token' } });
  if (res.status !== 200) throw new Error(`token request failed: ${res.status}`);
  const body = res.json();
  token = body.access_token;
  expiresAt = Date.now() + Math.max(10, body.expires_in - 20) * 1000;
  return token;
}

const now = () => Math.floor(Date.now() / 1000);

const QUERIES = [
  () => ['vm_range_1h_cpu', `${QG}/query/victoriametrics/api/v1/query_range`,
    { query: 'sum by (host_name) (rate(system_cpu_time_seconds_total{state!="idle"}[5m]))', start: now() - 3600, end: now(), step: 30 }],
  () => ['vm_range_1h_mem', `${QG}/query/victoriametrics/api/v1/query_range`,
    { query: 'avg by (host_name) (system_memory_usage_bytes{state="used"})', start: now() - 3600, end: now(), step: 30 }],
  () => ['vm_range_6h_net', `${QG}/query/victoriametrics/api/v1/query_range`,
    { query: 'sum(rate(system_network_io_bytes_total[5m]))', start: now() - 21600, end: now(), step: 120 }],
  () => ['vm_instant_hosts', `${QG}/query/victoriametrics/api/v1/query`,
    { query: 'count(count by (host_name) (system_memory_usage_bytes))', time: now() }],
];

const LOG_SEARCH = JSON.stringify({
  size: 50,
  sort: [{ '@timestamp': 'desc' }],
  query: { range: { '@timestamp': { gte: 'now-15m' } } },
});

export default function () {
  const headers = { Authorization: `Bearer ${bearer()}`, ...SCOPE };
  const phase = Date.now() - exec.scenario.startTime < WARMUP_S * 1000 ? 'warmup' : 'main';
  // 4 of 5 requests are metrics, 1 of 5 is a log search (like a dashboard
  // with several graphs and one log panel).
  let res;
  // Test-wide iteration number, so the 5-query mix is exact (per-VU
  // __ITER skews it when each VU runs only a few iterations).
  const i = exec.scenario.iterationInTest;
  if (i % 5 === 4) {
    res = http.post(`${QG}/query/opensearch/otel-logs*/_search`, LOG_SEARCH, {
      headers: { ...headers, 'Content-Type': 'application/json' }, tags: { name: 'os_search_15m', kind: 'query', phase },
    });
  } else {
    const [name, url, params] = QUERIES[i % 5]();
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    res = http.get(`${url}?${qs}`, { headers, tags: { name, kind: 'query', phase } });
  }
  errors.add(res.status !== 200);
  check(res, { 'status 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const v = data.metrics['http_req_duration{kind:query,phase:main}']?.values ?? {};
  const w = data.metrics['http_req_duration{kind:query,phase:warmup}']?.values ?? {};
  const by_query = Object.fromEntries(NAMES.map((n) => {
    const q = data.metrics[`http_req_duration{name:${n},phase:main}`]?.values ?? {};
    return [n, { p50_ms: q.med ?? 0, p99_ms: q['p(99)'] ?? 0, max_ms: q.max ?? 0 }];
  }));
  return { stdout: `\nBENCH_SUMMARY_BEGIN\n${JSON.stringify({
    target_rps: RATE,
    achieved_rps: data.metrics.iterations?.values?.rate ?? 0,
    requests: data.metrics.iterations?.values?.count ?? 0,
    error_rate: data.metrics.errors?.values?.rate ?? 0,
    dropped: data.metrics.dropped_iterations?.values?.count ?? 0,
    p50_ms: v.med ?? 0, p95_ms: v['p(95)'] ?? 0, p99_ms: v['p(99)'] ?? 0, max_ms: v.max ?? 0,
    warmup_s: WARMUP_S, warmup_p99_ms: w['p(99)'] ?? 0, warmup_max_ms: w.max ?? 0,
    by_query,
  })}\nBENCH_SUMMARY_END\n` };
}
