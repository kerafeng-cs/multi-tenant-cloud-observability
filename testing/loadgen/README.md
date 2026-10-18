# Synthetic host fleet (TODO-20)

Default: **100 hosts per pod**, 100 hosts per run, 10 minutes. An Indexed Job splits the hosts by pod index; every host has its own `host.name` and its own numbers. The load is real OTLP/HTTP JSON going through Keycloak → otel-gateway → VictoriaMetrics/OpenSearch. It does not copy a node's CPU/RAM into many fake machines.

A run enrolls **one real agent for one tenant**; all workers share that agent's credential. So 10,000 hosts does not mean 10,000 agents or 10,000 OAuth sessions (Keycloak token load is measured separately by `testing/bench`, phase 3). Several tenants means several runs with different names. This tool does not replace an enrollment benchmark, the VMware agent, a real collector, or read load on query-gateway.

The code lives only in `testing/loadgen/` and is not part of the platform overlay. It changes no claims, issuer, bootstrap, gateway, database or dashboard, and does not replace the drafts in `testing/fleet/` and `testing/telemetrygen/`.

## Deploying

The operator machine needs Node **22 or later** and kubectl pointed at the right cluster. There is no npm package, build step or custom image. Pods use `node:22.19.0-alpine`; the cluster needs registry access, or pass `--image` with a Node 22+ image from an internal registry (for long-term use, an approved image pinned by digest). The tool installs nothing on the operator machine.

The examples run from the repository root in WSL/Bash. The password is prompted without echo; it is never passed as an argument, environment variable or file. The account must be a platform-admin, or tenant-admin of an existing tenant. (Automation such as `testing/bench` may pass an already obtained operator token in `MTCO_LOADGEN_BEARER` to skip the prompt.)

1. Test and look at the plan, without touching the cluster:

```bash
node --version
node --test testing/loadgen/loadgen.test.mjs
node testing/loadgen/fleet.mjs plan --run smoke --tenant alpha-tenant --hosts 100
```

If Node is older than 22, stop here and provide a suitable runtime first; nothing installs it for you. The tests use a fake HTTP loopback and a fake Kubernetes adapter; they never call kubectl or the cluster.

2. With dev access through port-forward, open two WSL terminals, one command each (skip if these ports are already forwarded):

```bash
kubectl -n observability port-forward --address 0.0.0.0 svc/keycloak 8080:8080
```

```bash
kubectl -n observability port-forward --address 0.0.0.0 svc/control-plane 18081:8080
```

To stop exactly these port-forwards:

```bash
pkill -f "port-forward.*svc/keycloak"
pkill -f "port-forward.*svc/control-plane"
```

3. In the CLI terminal, enter a real tenant and the **full token URL reachable from the pods**, then deploy a canary:

```bash
read -r -p 'Existing tenant: ' MTCO_LOAD_TENANT
read -r -p 'Keycloak token URL reachable from pods: ' MTCO_LOAD_TOKEN_URL
node testing/loadgen/fleet.mjs deploy --run smoke \
  --tenant "$MTCO_LOAD_TENANT" --hosts 100 --hosts-per-pod 100 \
  --token-url "$MTCO_LOAD_TOKEN_URL" \
  --gateway-url http://otel-gateway.observability.svc.cluster.local:4318 \
  --allow-http
```

The token URL ends in `/realms/observability/protocol/openid-connect/token`, and must return tokens whose `iss` is **exactly** `platform-endpoints.KEYCLOAK_ISSUER` (with the fixed Keycloak hostname of TODO-04, the in-cluster address `keycloak.observability.svc.cluster.local:8080` does). Never use `localhost` as the pods' token URL, override Host, or edit JWTs to pass the check; the tool cannot fix a network path or an inconsistent issuer. The issuer (no secrets) can be checked with:

```bash
kubectl -n observability get "$(kubectl -n observability get configmap -o name | grep platform-endpoints | head -1)" -o jsonpath='{.data.KEYCLOAK_ISSUER}{"\n"}'
```

`--api-url` and `--keycloak-url` are for the operator machine, defaulting to `http://localhost:18081` and `http://localhost:8080`. `--token-url` and `--gateway-url` are for the **pods**, defaulting to the enrollment response. `--issuer` only changes the value the probe expects (it reconfigures neither Keycloak nor the gateway); normally let the tool read the ConfigMap. `--namespace` defaults to `observability`; a separate namespace such as `mtco-loadtest` also tests cross-namespace access (TODO-27).

HTTPS is verified with Node's trust store; plain HTTP must be enabled explicitly with `--allow-http` for dev. There is no flag to mount an internal CA: use an image that already contains the organisation's CA if needed; never disable TLS verification. Where NetworkPolicy restricts traffic, workers need DNS, Keycloak and OTLP; the tool does not loosen policies.

Deploy flow:

1. Validate arguments, pod budget, run name and issuer.
2. Sign in with `mtco-cli`; create an enrollment through `/api/v1/tenants/.../agent-enrollments` and exchange it through the current API.
3. Keep the enrollment token in an owner-labelled Secret before the exchange, then replace it with the agent credential. Admin passwords/tokens stay in the CLI's memory and never reach a pod. Secrets go through kubectl's stdin, never through arguments, temp files or the last-applied annotation.
4. Create an immutable ConfigMap with the worker code and configuration; run a probe pod that sends one host's metrics and one log. The probe uses real OAuth and checks issuer/tenant/agent/audience/VM-account claims; the gateway still verifies the JWT signature.
5. The load Job is created only after the probe Job succeeds. If the probe fails there is no load Job; the Secret is kept for debugging or cleanup. The probe writes a little real data.

A successful probe only proves the gateway **accepts requests**, not that the exporter stored them or that Grafana can read them. The checklist at the end is mandatory before increasing load.

## Limits and scaling up

| Hosts | Pods (100 hosts/pod) | Generator CPU/RAM requests | Total CPU/RAM limits | Default metric points/s | Per-host interval |
|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 50m / 64Mi | 250m / 128Mi | 66.7 | 15 s |
| 1,000 | 10 | 500m / 640Mi | 2,500m / 1,280Mi | 500 | 20 s |
| 10,000 | 100 | 5,000m / 6,400Mi | 25,000m / 12,800Mi | 500 | 200 s |

The lab cluster (2026-10-13): 2 nodes, 8 CPUs and about 15.5 GiB RAM in total. These are **reserved resources**, not measured load. 100 pods as in the last row exceed the remaining CPU requests; use more hosts per pod instead (`testing/bench` stress mode runs 20 pods of up to 1,000 hosts).

Independent parameters:

- `--hosts`: total hosts; `--hosts-per-pod`: density, default 100, maximum 1,000.
- `--metric-interval`: target interval per host, default 15 s. Each host sends 10 data points per interval, about 10 series before exporter-generated ones.
- `--metric-points-per-second`: budget for the **whole run**, default 500. The interval used is the larger of the requested interval and total points divided by the budget.
- `--logs-per-second`: logs/s for the **whole run**, default 5; 0 = metrics only. The probe still checks both pipelines.
- `--duration`: sending time per worker, default 600 s; `--ramp`: spreads worker start times, default 30 s.
- `--max-pods`: pre-deploy guard, default 10. Raising it is an operator decision after checking capacity; it does not scale the cluster.

Rates are average targets with small per-batch bursts, not a hard per-second cap. Each pod has at most one metrics and one logs request in flight; metric batches hold at most 10 hosts/100 points, log batches at most 10 records. A slow receiver lowers the actual rate; there is no catch-up queue. Transient errors drop the batch with bounded backoff; a worker stops after 5 consecutive errors in one pipeline; auth/claims errors and partial success stop it at once. A timed-out batch may have reached the server, so it is counted as uncertain or dropped and never resent.

Tokens are cached and refreshed before expiry, with concurrent refreshes merged per pod. There is no fleet-wide OAuth coordination; each pod has its own cache. The Indexed Job uses `backoffLimit: 0` and does not recover failed load. Kubernetes can still duplicate a pod of an index in some failures: this is not an exactly-once meter.

Step up 100 → 300 → 1,000 after the checklist and with platform metrics (TODO-25). Stop the previous run first; use a new run name with the same endpoints that passed the probe. To preview 10,000 hosts without deploying:

```bash
node testing/loadgen/fleet.mjs plan --run capacity --tenant alpha-tenant --hosts 10000
```

That plan reports `deployAllowed: false` because it exceeds 10 pods. When raising the limit, consider gateway/storage load, disk space and historical series, not only generator resources. Concurrent runs add up. A new run name creates new hosts/series; cleanup never deletes stored telemetry. At a 200-second interval, CPU/network need a long enough `rate()` window (e.g. 10 minutes); dashboards with short windows may look empty although data was written. With 5 logs/s and 10,000 hosts, a 10-minute run does not give every host a log.

## Watching, stopping and cleanup

Commands for the operator:

```bash
node testing/loadgen/fleet.mjs status --run smoke
kubectl -n observability get pods -l 'app.kubernetes.io/managed-by=mtco-loadgen,mtco.test/run=smoke' -o wide
kubectl -n observability logs -l 'app.kubernetes.io/managed-by=mtco-loadgen,mtco.test/run=smoke' --all-containers=true --prefix=true --tail=30 --max-log-requests=10
node testing/loadgen/fleet.mjs stop --run smoke
```

Workers print statistics every 30 seconds and at the end: `metricsAccepted`, `logsAccepted`, `failedBatches`, `uncertainOrDroppedItems`. "Accepted" means the gateway acknowledged. Payloads, tokens, credentials and error bodies are never logged. `stop` suspends the run's Jobs; Kubernetes terminates the pods, so requests in flight may still finish. It keeps the agent, Secret and resources for investigation. Never reuse a run name that already has a load Job.

When done with the results, the following signs in again, suspends the Jobs, revokes the agent, and deletes exactly the Job/ConfigMap/Secret labelled as owned by the run. It never deletes repository files, namespaces, PVCs, indices, tenants or stored data:

```bash
node testing/loadgen/fleet.mjs cleanup --run smoke --allow-http
```

If you signed in through a URL other than localhost, pass `--keycloak-url` again; the run's API URL is stored in an annotation without credentials. Secrets need restricted RBAC and the cluster's Secret encryption; base64 alone is not encryption. Never run `get secret -o yaml`, enable shell tracing, or paste credentials into a chat.

The exchange returns the credential only once. If the server committed but the response was lost, a new deploy may get 410; the tool **does not enroll a new agent by itself**. Cleanup uses the journal to find the agent among the 100 most recent enrollments and revoke it. If it has scrolled out of that list, the tool keeps the journal and asks an administrator to check and revoke first; it never guesses or deletes blindly. A cleanup interrupted after revoking can be rerun. Agent deletion still has the current JWT revocation delay (I-06); the tool stops the pods before revoking.

## E2E checklist

- [ ] Run all of `node --test testing/loadgen/loadgen.test.mjs`: all 18 tests pass. They use fake credentials only; no sign-in or kubectl needed.
- [ ] Record a baseline: Grafana sign-in, `tools/mtco`, the VMware agent sending, and query-gateway reading normally. Note the VMware host for comparison afterwards.
- [ ] Confirm cluster resources and free disk, and that gateway/storage errors/CPU/RAM are visible (TODO-25 dashboards).
- [ ] Wrong-issuer canary: run name `badissuer`, the same deploy command plus `--issuer http://invalid.invalid/realms/observability`. The probe must fail, **with no load Job `mtco-load-badissuer`**, and the logs contain no token/secret. Then clean up `badissuer` on its own.
- [ ] Correct canary: deploy `smoke` with 100 hosts; the probe completes before the load Job appears. A load pod stays within 250m/128Mi, with no OOM or restart. It ends after about 10 minutes plus ramp/scheduling; nothing restarts the load.
- [ ] Grafana in the right tenant → Explore VictoriaMetrics: `count(count by (host_name) (system_memory_usage_bytes{host_name=~"smoke-host-.*"}))` returns 100 while the run is active and at least one interval has passed. If the exporter keeps unsuffixed names, use `system_memory_usage` instead (the dashboard accepts both).
- [ ] Hosts overview dashboard: the dropdown lists `smoke-host-000001` to `smoke-host-000100`; CPU, RAM, load, network and filesystem have data (wait at least two intervals for `rate()`). The metrics do not depend on a real node's CPU/RAM.
- [ ] Explore OpenSearch through the existing datasource: search `resource.host.name.keyword:smoke-host-*`, check INFO/ERROR logs and that `resource.tenant.id`, `resource.agent.id` were set by the gateway. A probe ACK does not replace this step.
- [ ] Sign in to another tenant: `smoke`'s metrics/logs are not visible. Check through Grafana/query-gateway; do not conclude isolation from queries made with an admin account directly against storage.
- [ ] Run longer than the access-token TTL (a new run with a larger `--duration` if needed): data keeps flowing across refreshes, with no 401s or large bursts. The token keeps the same identity contract.
- [ ] Run `stop`: Jobs suspended, pods stopped; counters and timestamps stop growing after in-flight requests/exports finish. The real VMware host still has fresh data.
- [ ] Clean up `smoke`: the test agent is revoked; only resources labelled for the run are deleted; real agents/tenants, the database and stored data remain. Rerunning cleanup does not create a new agent.
- [ ] After the canary, re-check Grafana sign-in, `tools/mtco`, VMware and query-gateway. Only go to 300/1,000 hosts when ingest/exporters report no errors and latency and capacity are fine. Record measurements before each step.

## Development-machine checks

2026-10-13: **14 offline tests passed** (splitting 10,003 hosts, budget, OTLP model, cache/claims/token, errors/partial responses, backoff, stop, ownership, Secret via stdin, enrollment journal, probe gate, cleanup). 2026-10-14: all **18/18** passed on Node 22.22, including the 4 HTTP loopback tests.

Offline-only tests, if the environment blocks loopback:

```bash
node --test --test-skip-pattern='^\[http\]' testing/loadgen/loadgen.test.mjs
node testing/loadgen/benchmark.mjs
```

Offline encoder benchmark on Node 22.19.0 (Windows): one round of 10,000 hosts produces 100,000 points (~30 MB JSON) in batches in about 233 ms, peak RSS ~43 MiB. This only checks the encoder and memory; it is **not** a measurement of a pod under its CPU limit or of gateway/storage capacity (see `testing/bench`).

Protocol references: [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [OpenTelemetry metrics protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/metrics/v1/metrics.proto). Cumulative sums, string-number timestamps and metric names were checked against the dashboard and the gateway configuration in this repository.
