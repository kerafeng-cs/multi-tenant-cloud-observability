// Phase 3: agents asking Keycloak for tokens (client_credentials), at a
// fixed arrival rate. Runs inside the cluster against http://keycloak:8080
// in the throw-away realm mtco-bench (20 confidential clients).
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const RATE = Number(__ENV.RATE);
const DURATION = __ENV.DURATION;
const CLIENTS = Number(__ENV.CLIENTS || 20);
const URL = 'http://keycloak:8080/realms/mtco-bench/protocol/openid-connect/token';

export const errors = new Rate('errors');

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    tokens: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.min(50 + RATE, 600),
      maxVUs: Math.min(100 + RATE * 4, 2000),
    },
  },
};

export default function () {
  const id = String((__ITER % CLIENTS) + 1).padStart(2, '0');
  const res = http.post(URL, {
    grant_type: 'client_credentials',
    client_id: `bench-${id}`,
    client_secret: __ENV.CLIENT_SECRET,
  });
  errors.add(res.status !== 200);
  check(res, { 'status 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return { stdout: `\nBENCH_SUMMARY_BEGIN\n${JSON.stringify(summary(data))}\nBENCH_SUMMARY_END\n` };
}

function summary(data) {
  const d = data.metrics.http_req_duration?.values ?? {};
  return {
    target_rps: RATE,
    achieved_rps: data.metrics.http_reqs?.values?.rate ?? 0,
    requests: data.metrics.http_reqs?.values?.count ?? 0,
    error_rate: data.metrics.errors?.values?.rate ?? 0,
    dropped: data.metrics.dropped_iterations?.values?.count ?? 0,
    p50_ms: d.med ?? 0, p95_ms: d['p(95)'] ?? 0, p99_ms: d['p(99)'] ?? 0, max_ms: d.max ?? 0,
  };
}
