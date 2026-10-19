#!/usr/bin/env bash
# MTCO end-to-end benchmark (TODO-30). Run from the repository root:
#
#   ./testing/bench/bench.sh            all phases 0-4 (about 2h40)
#   ./testing/bench/bench.sh --quick    shorter steps, fewer levels (about 1h)
#   ./testing/bench/bench.sh --stress   push far past the target (about 3h),
#                                       same as ./testing/bench/bench-stress.sh
#   ./testing/bench/bench.sh 1 3        only phases 1 and 3
#   ./testing/bench/bench.sh 6          mixed "real day" (30 min)
#   ./testing/bench/bench.sh 7          soak (2 h)
#   ./testing/bench/bench.sh cleanup    remove everything the benchmark created
#
# Phases: 0 baseline | 1 metrics write path | 2 logs write path |
#         3 Keycloak tokens (agents) | 4 read path (query-gateway) |
#         6 mixed | 7 soak
#
# Needs: kubectl (current context = the MTCO cluster), node 22, curl, jq.
# Asks once for an MTCO platform-admin password; it stays in memory and in
# a short-lived Kubernetes Secret, never on disk or in the output.
# Results: testing/bench/results/<date-time>/summary.md (+ raw.csv).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH="$ROOT/testing/bench"
NS=observability
LOAD_NS=mtco-loadtest
TENANT="${BENCH_TENANT:-bench-tenant}"
OPERATOR="${BENCH_USER:-dat}"
KC_PORT=18080 CP_PORT=18081 VM_PORT=18481
K6_IMAGE=grafana/k6:0.54.0
KC_IMAGE=quay.io/keycloak/keycloak:26.7.3
ISSUER_INTERNAL_TOKEN="http://keycloak.observability.svc.cluster.local:8080/realms/observability/protocol/openid-connect/token"
GATEWAY_INTERNAL="http://otel-gateway.observability.svc.cluster.local:4318"

QUICK=0
PHASES=()
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --stress) QUICK=2 ;;
    cleanup|0|1|2|3|4|6|7) PHASES+=("$arg") ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done
[ ${#PHASES[@]} -gt 0 ] || PHASES=(0 1 2 3 4)

LOAD_PODS=10   # loadgen pods sharing the synthetic hosts / log rate
if [ "$QUICK" = 2 ]; then
  # Stress: 10x-20x the 2,000-agent target. The generators run in the same
  # 8-CPU cluster as MTCO (20 loadgen pods + k6), so ceilings found here are
  # lower bounds: part of the CPU goes to the load itself.
  PROFILE=stress
  STEP=600 BASELINE=180
  WRITE_HOSTS=(2000 5000 10000 20000)
  LOG_RATES=(1000 2000 5000 10000)
  TOKEN_RATES=(100 333 600 1000 1500)
  READ_RATES=(10 20 30 50)
  MIXED_MIN=30
  LOAD_PODS=20
elif [ "$QUICK" = 1 ]; then
  PROFILE=quick
  STEP=300 BASELINE=180
  WRITE_HOSTS=(100 300 1000)
  LOG_RATES=(50 200)
  TOKEN_RATES=(10 33 100)
  READ_RATES=(5 20 50)
  MIXED_MIN=10
else
  PROFILE=full
  STEP=600 BASELINE=600
  WRITE_HOSTS=(100 300 1000 2000)
  LOG_RATES=(50 200 500 1000)
  TOKEN_RATES=(10 33 100 300 600)
  READ_RATES=(5 20 50 100)
  MIXED_MIN=30
fi
# Optional overrides, e.g. BENCH_WRITE_HOSTS="50000" BENCH_LOAD_PODS=50
[ -n "${BENCH_WRITE_HOSTS:-}" ] && read -r -a WRITE_HOSTS <<<"$BENCH_WRITE_HOSTS"
[ -n "${BENCH_LOG_RATES:-}" ]   && read -r -a LOG_RATES <<<"$BENCH_LOG_RATES"
[ -n "${BENCH_TOKEN_RATES:-}" ] && read -r -a TOKEN_RATES <<<"$BENCH_TOKEN_RATES"
[ -n "${BENCH_READ_RATES:-}" ]  && read -r -a READ_RATES <<<"$BENCH_READ_RATES"
LOAD_PODS="${BENCH_LOAD_PODS:-$LOAD_PODS}"
SOAK_MIN="${BENCH_SOAK_MINUTES:-120}"
SHORT=$((STEP / 2))   # k6 steps (tokens, reads)
READ_WARMUP=30        # seconds of each read step reported apart (cold start)

# ---------------------------------------------------------------- output
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$BENCH/results/$STAMP"
mkdir -p "$OUT"
CSV="$OUT/raw.csv"
MD="$OUT/summary.md"

c_blue=$'\e[1;34m' c_green=$'\e[1;32m' c_yellow=$'\e[1;33m' c_red=$'\e[1;31m' c_off=$'\e[0m'
say()  { printf '%s[bench %s]%s %s\n' "$c_blue" "$(date +%H:%M:%S)" "$c_off" "$*" >&2; }
ok()   { printf '%s  ✔ %s%s\n' "$c_green" "$*" "$c_off" >&2; }
warn() { printf '%s  ! %s%s\n' "$c_yellow" "$*" "$c_off" >&2; }
die()  { printf '%s  ✘ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
md()   { printf '%s\n' "$*" >> "$MD"; }
rec()  { printf '%s,%s,%s,%s\n' "$1" "$2" "$3" "$4" >> "$CSV"; }

# ---------------------------------------------------------------- cleanup
PF_PIDS=()
ACTIVE_RUNS=()
cleanup_runtime() {
  set +e
  # Refresh the operator token first: with an expired one, fleet.mjs would
  # fall back to an interactive password prompt (hidden by the redirect)
  # and the exit would hang. stdin from /dev/null makes that impossible.
  [ ${#ACTIVE_RUNS[@]} -gt 0 ] && token_grant refresh >/dev/null 2>&1
  for run in "${ACTIVE_RUNS[@]:-}"; do
    [ -n "$run" ] && loadgen cleanup --run "$run" </dev/null >/dev/null 2>&1
  done
  kubectl -n "$NS" delete job -l app=mtco-bench --ignore-not-found >/dev/null 2>&1
  kubectl -n "$NS" delete secret mtco-bench configmap mtco-bench-k6 --ignore-not-found >/dev/null 2>&1
  for pid in "${PF_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  OPERATOR_PASSWORD=""
}
trap 'cleanup_runtime' EXIT
trap 'warn "interrupted: stopping load and cleaning up"; exit 130' INT TERM

# ---------------------------------------------------------------- checks
preflight() {
  for cmd in kubectl node curl jq awk; do
    command -v "$cmd" >/dev/null || die "missing command: $cmd"
  done
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "node 22+ required"
  kubectl get ns "$NS" >/dev/null 2>&1 || die "namespace $NS not found (kubectl context?)"
  for d in vmagent query-gateway otel-gateway keycloak control-plane vmselect; do
    kubectl -n "$NS" get deploy "$d" >/dev/null 2>&1 || die "deployment $d missing: deploy MTCO (with self-monitoring) first"
  done
  ok "cluster: $(kubectl config current-context)"
}

port_forward() {   # svc local remote
  kubectl -n "$NS" port-forward "svc/$1" "$2:$3" >"$OUT/port-forward-$1.log" 2>&1 &
  PF_PIDS+=($!)
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$2/" && return 0
    sleep 1
  done
  die "port-forward to $1 did not come up (see $OUT/port-forward-$1.log)"
}

# ---------------------------------------------------------------- auth
ACCESS="" REFRESH="" OPERATOR_PASSWORD="" API_STATUS="" API_BODY="" KC_ADMIN_SECRET=""
login() {
  read -r -s -p "MTCO password for $OPERATOR (platform admin): " OPERATOR_PASSWORD; echo
  token_grant password || die "sign-in failed for $OPERATOR"
  ok "signed in as $OPERATOR"
}
token_grant() {   # password | refresh
  local response
  if [ "$1" = refresh ] && [ -n "$REFRESH" ]; then
    response=$(curl -sS -X POST "http://127.0.0.1:$KC_PORT/realms/observability/protocol/openid-connect/token" \
      --data-urlencode grant_type=refresh_token --data-urlencode client_id=mtco-cli \
      --data-urlencode "refresh_token=$REFRESH") || return 1
  else
    response=$(printf '%s' "$OPERATOR_PASSWORD" | curl -sS -X POST \
      "http://127.0.0.1:$KC_PORT/realms/observability/protocol/openid-connect/token" \
      --data-urlencode grant_type=password --data-urlencode client_id=mtco-cli \
      --data-urlencode "username=$OPERATOR" --data-urlencode 'password@-') || return 1
  fi
  ACCESS=$(jq -r '.access_token // empty' <<<"$response")
  REFRESH=$(jq -r '.refresh_token // empty' <<<"$response")
  [ -n "$ACCESS" ]
}
fresh_token() { token_grant refresh || token_grant password || die "could not refresh the operator token"; }

api() {   # METHOD PATH [BODY] -> sets API_STATUS and API_BODY (no subshell, so both survive)
  local body_file="$OUT/.api"
  API_STATUS=$(curl -sS -o "$body_file" -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "http://127.0.0.1:$CP_PORT/api/v1$2") || API_STATUS=000
  API_BODY=$(cat "$body_file" 2>/dev/null); rm -f "$body_file"
}

ensure_tenant() {
  fresh_token
  api GET "/tenants/$TENANT"
  if [ "$API_STATUS" = 404 ]; then
    api POST /tenants "$(jq -cn --arg k "$TENANT" '{tenantKey: $k}')"
    [ "$API_STATUS" = 201 ] || die "cannot create tenant $TENANT (HTTP $API_STATUS): $API_BODY"
    ok "tenant $TENANT created"
    sleep 20   # Keycloak group + Grafana org are created by the outbox
  else
    [ "$API_STATUS" = 200 ] || die "cannot read tenant $TENANT (HTTP $API_STATUS): $API_BODY"
  fi
  [ "$(jq -r .status <<<"$API_BODY")" = active ] || die "tenant $TENANT is not active: $API_BODY"
  VM_ACCOUNT=$(jq -r .vmAccountId <<<"$API_BODY")
  ok "tenant $TENANT (VictoriaMetrics account $VM_ACCOUNT)"
}

# ---------------------------------------------------------------- metrics
# Self-monitoring lives in VictoriaMetrics account 1 (admin-tenant).
vmq() {   # expr time -> number (NaN when empty)
  curl -fsS -G "http://127.0.0.1:$VM_PORT/select/1/prometheus/api/v1/query" \
    --data-urlencode "query=$1" --data-urlencode "time=$2" 2>/dev/null \
    | jq -r '[.data.result[]?.value[1] | select(. != "NaN" and . != "+Inf" and . != "-Inf") | tonumber] | if length == 0 then "NaN" else add end'
}
vmq_tenant() {   # expr -> number, in the bench tenant's own account (now)
  curl -fsS -G "http://127.0.0.1:$VM_PORT/select/$VM_ACCOUNT/prometheus/api/v1/query" \
    --data-urlencode "query=$1" 2>/dev/null \
    | jq -r '[.data.result[]?.value[1] | tonumber] | if length == 0 then "NaN" else add end'
}
S='mtco_source="platform"'
C="namespace=\"observability\",container!=\"\",container!=\"POD\",$S"
avg_cpu()  { vmq "sum(increase(container_cpu_usage_seconds_total{$C,pod=~\"$1\"}[$2s])) / $2" "$3"; }
peak_mem() { vmq "max_over_time(sum(container_memory_working_set_bytes{$C,pod=~\"$1\"})[$2s:30s])" "$3"; }
throttle() { vmq "max(sum by (pod) (increase(container_cpu_cfs_throttled_periods_total{$C,pod=~\"$1\"}[$2s])) / sum by (pod) (increase(container_cpu_cfs_periods_total{$C,pod=~\"$1\"}[$2s])))" "$3"; }
otel_rate(){ vmq "sum(increase({__name__=~\"otelcol_$1(_total)?\",$S}[$2s])) / $2" "$3"; }
hq()       { vmq "histogram_quantile($1, sum by (le) (increase($2[$3s])))" "$4"; }

P_OTEL='otel-gateway-.*' P_VMI='vminsert-.*' P_VMS='vmstorage-.*' P_VMSEL='vmselect-.*'
P_QG='query-gateway-.*' P_KC='keycloak-[a-z0-9]{6,10}-[a-z0-9]{5}' P_KCPG='keycloak-postgres-.*'
P_OS='opensearch-[0-9]+' P_GRAF='grafana-[a-z0-9]{6,10}-[a-z0-9]{5}' P_CP='control-plane-[a-z0-9]{6,10}-[a-z0-9]{5}'

f()   { awk -v v="$1" -v d="${2:-1}" 'BEGIN{ if (v=="NaN" || v=="") print "–"; else printf "%.*f", d, v }'; }
ms()  { awk -v v="$1" 'BEGIN{ if (v=="NaN" || v=="") print "–"; else printf "%.0f", v*1000 }'; }
mib() { awk -v v="$1" 'BEGIN{ if (v=="NaN" || v=="") print "–"; else printf "%.0f", v/1048576 }'; }
pct() { awk -v v="$1" 'BEGIN{ if (v=="NaN" || v=="") print "–"; else printf "%.1f%%", v*100 }'; }
gt()  { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a!="NaN" && a+0 > b+0) }'; }

# Waits until a Job succeeded (0) or failed / timed out (1).
wait_job() {   # namespace job timeout_seconds
  local deadline=$(( $(date +%s) + $3 )) succeeded failed
  while [ "$(date +%s)" -lt "$deadline" ]; do
    succeeded=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    failed=$(kubectl -n "$1" get job "$2" -o jsonpath='{.status.failed}' 2>/dev/null || true)
    [ "${succeeded:-0}" -ge 1 ] 2>/dev/null && return 0
    if [ "${failed:-0}" -ge 1 ] 2>/dev/null; then
      [ "$(kubectl -n "$1" get job "$2" -o jsonpath='{.spec.backoffLimit}')" -lt "${failed:-0}" ] && return 1
    fi
    sleep 10
  done
  return 1
}

# ---------------------------------------------------------------- loadgen
loadgen() {
  MTCO_LOADGEN_BEARER="$ACCESS" node "$ROOT/testing/loadgen/fleet.mjs" "$@" \
    --namespace "$LOAD_NS" --api-url "http://127.0.0.1:$CP_PORT" \
    --keycloak-url "http://127.0.0.1:$KC_PORT" --allow-http
}
start_load() {   # hosts logs_per_second duration [metric_points_per_second]
  local hosts=$1 logs=$2 duration=$3 per_pod points
  per_pod=$(( (hosts + LOAD_PODS - 1) / LOAD_PODS )); [ "$per_pod" -lt 100 ] && per_pod=100
  points=${4:-$(( hosts * 10 / 15 + 1 ))}
  fresh_token
  loadgen deploy --run "$RUN" --tenant "$TENANT" --hosts "$hosts" --hosts-per-pod "$per_pod" \
    --duration "$duration" --metric-points-per-second "$points" --logs-per-second "$logs" --max-pods "$LOAD_PODS" \
    --token-url "$ISSUER_INTERNAL_TOKEN" --gateway-url "$GATEWAY_INTERNAL" --issuer "$ISSUER" >"$OUT/loadgen-$RUN.log" 2>&1 \
    || { cat "$OUT/loadgen-$RUN.log" >&2; die "loadgen deploy failed ($RUN)"; }
  ACTIVE_RUNS+=("$RUN")
}
wait_load() {   # run duration
  # Wait until no generator pod is running. A Job is marked failed as soon
  # as ONE worker gives up (backoffLimit 0) while the others keep sending,
  # so "failed" is not "finished": keep waiting for the rest.
  local deadline=$(( $(date +%s) + $2 + 300 )) active done_ total
  total=$(kubectl -n "$LOAD_NS" get job "mtco-load-$1" -o jsonpath='{.spec.completions}' 2>/dev/null || echo 1)
  while [ "$(date +%s)" -lt "$deadline" ]; do
    active=$(kubectl -n "$LOAD_NS" get job "mtco-load-$1" -o jsonpath='{.status.active}' 2>/dev/null || true)
    done_=$(kubectl -n "$LOAD_NS" get job "mtco-load-$1" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    [ "${done_:-0}" -ge "${total:-1}" ] 2>/dev/null && return 0
    if [ "${active:-0}" = 0 ] && [ -n "$(kubectl -n "$LOAD_NS" get job "mtco-load-$1" -o jsonpath='{.status.failed}' 2>/dev/null || true)" ]; then
      warn "load $1: some generator workers gave up (see the 'Workers stopped' column)"; return 0
    fi
    sleep 10
  done
  warn "load job $1 did not complete in time"
}
load_stats() {   # run -> "accepted_points accepted_logs failed_batches dropped workers_stopped"
  # A worker ends with "finished", or with "failed" when the gateway kept
  # refusing it (e.g. HTTP 503 under memory pressure). Never fail the
  # script when there is no such line (set -e + pipefail).
  { kubectl -n "$LOAD_NS" logs -l "job-name=mtco-load-$1" --tail=-1 --max-log-requests=50 2>/dev/null || true; } \
    | { grep -E '"event":"(finished|failed)"' || true; } \
    | jq -rs '[ (map(.metricsAccepted)|add // 0), (map(.logsAccepted)|add // 0), (map(.failedBatches)|add // 0), (map(.uncertainOrDroppedItems)|add // 0), (map(select(.event == "failed"))|length) ] | @tsv'
}
end_load() {   # run
  fresh_token
  loadgen cleanup --run "$1" </dev/null >/dev/null 2>&1 || warn "loadgen cleanup of $1 failed"
  ACTIVE_RUNS=("${ACTIVE_RUNS[@]/$1}")
}

# ---------------------------------------------------------------- k6
bench_secret() {
  kubectl -n "$NS" delete secret mtco-bench --ignore-not-found >/dev/null
  kubectl -n "$NS" create secret generic mtco-bench \
    --from-env-file=<(printf 'CLIENT_SECRET=%s\nOPERATOR_USERNAME=%s\nOPERATOR_PASSWORD=%s\n' \
      "$CLIENT_SECRET" "$OPERATOR" "$OPERATOR_PASSWORD") >/dev/null
  kubectl -n "$NS" create configmap mtco-bench-k6 --from-file="$BENCH/k6/token.js" \
    --from-file="$BENCH/k6/read.js" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}
k6_job() {   # name script rate duration -> JSON summary
  local name=$1 script=$2 rate=$3 duration=$4
  kubectl -n "$NS" delete job "$name" --ignore-not-found >/dev/null
  cat <<YAML | kubectl -n "$NS" apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  labels: { app: mtco-bench }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: { app: mtco-bench }
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: $K6_IMAGE
          args: ["run", "--quiet", "--no-color", "/scripts/$script"]
          env:
            - { name: RATE, value: "$rate" }
            - { name: DURATION, value: "${duration}s" }
            - { name: TENANT, value: "$TENANT" }
            - { name: VM_ACCOUNT, value: "${VM_ACCOUNT:-0}" }
            - { name: WARMUP, value: "$READ_WARMUP" }
          envFrom:
            - secretRef: { name: mtco-bench }
          volumeMounts:
            - { name: scripts, mountPath: /scripts }
          resources:
            requests: { cpu: 200m, memory: 128Mi }
            limits: { cpu: "2", memory: 1Gi }
      volumes:
        - name: scripts
          configMap: { name: mtco-bench-k6 }
YAML
  wait_job "$NS" "$name" "$(( duration + 240 ))" || { job_debug "$NS" "$name"; warn "k6 job $name did not complete cleanly"; }
  kubectl -n "$NS" logs "job/$name" 2>/dev/null | sed -n '/BENCH_SUMMARY_BEGIN/,/BENCH_SUMMARY_END/p' \
    | sed '1d;$d' | tee "$OUT/$name.json"
}

# kustomize appends a content hash to Secret names; read the real one from
# the bootstrap Job that kustomize itself rewrote.
resolve_kc_admin() {
  KC_ADMIN_SECRET=$(kubectl -n "$NS" get job keycloak-bootstrap -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="KEYCLOAK_ADMIN_USERNAME")].valueFrom.secretKeyRef.name}')
  [ -n "$KC_ADMIN_SECRET" ] && kubectl -n "$NS" get secret "$KC_ADMIN_SECRET" >/dev/null 2>&1 \
    || die "cannot find the Keycloak admin Secret (job keycloak-bootstrap)"
}
job_debug() {   # namespace job: show why a Job failed before the trap deletes it
  kubectl -n "$1" get pods -l "job-name=$2" -o wide >&2 2>/dev/null
  kubectl -n "$1" describe pods -l "job-name=$2" 2>/dev/null | sed -n '/^Events:/,$p' | tail -12 >&2
  kubectl -n "$1" logs "job/$2" --tail=30 >&2 2>/dev/null
}

ensure_bench_realm() {
  say "creating throw-away Keycloak realm mtco-bench (20 clients)"
  kubectl -n "$NS" delete job mtco-bench-realm --ignore-not-found >/dev/null
  cat <<YAML | kubectl -n "$NS" apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: mtco-bench-realm
  labels: { app: mtco-bench }
spec:
  backoffLimit: 2
  template:
    metadata:
      labels: { app: mtco-bench }
    spec:
      restartPolicy: OnFailure
      containers:
        - name: kcadm
          image: $KC_IMAGE
          command: ["/bin/bash", "-ec"]
          args:
            - |
              K=/opt/keycloak/bin/kcadm.sh
              \$K config credentials --server http://keycloak:8080 --realm master --user "\$KC_USER" --password "\$KC_PASSWORD" >/dev/null
              \$K get realms/mtco-bench >/dev/null 2>&1 || \$K create realms -s realm=mtco-bench -s enabled=true
              # The secret is new on every run: create missing clients, and
              # set the current secret on clients kept from an earlier run.
              for i in \$(seq -w 1 20); do
                ID=\$(\$K get clients -r mtco-bench -q clientId=bench-\$i --fields id --format csv --noquotes)
                if [ -z "\$ID" ]; then
                  \$K create clients -r mtco-bench -s clientId=bench-\$i -s enabled=true -s publicClient=false \
                    -s serviceAccountsEnabled=true -s standardFlowEnabled=false -s directAccessGrantsEnabled=false \
                    -s "secret=\$CLIENT_SECRET" >/dev/null
                else
                  \$K update "clients/\$ID" -r mtco-bench -s "secret=\$CLIENT_SECRET"
                fi
              done
              # Phase 4: a public client in the REAL realm whose tokens carry
              # the query-gateway audience (like Grafana's), for k6 reads.
              # Removed by "bench.sh cleanup". control-plane's GC ignores it
              # (no MTCO marker).
              if ! \$K get clients -r observability -q clientId=mtco-bench-reader --fields clientId | grep -q bench; then
                \$K create clients -r observability -s clientId=mtco-bench-reader -s enabled=true -s publicClient=true \
                  -s directAccessGrantsEnabled=true -s standardFlowEnabled=false >/dev/null
                CID=\$(\$K get clients -r observability -q clientId=mtco-bench-reader --fields id --format csv --noquotes)
                \$K create "clients/\$CID/protocol-mappers/models" -r observability -f - >/dev/null <<'JSON'
              {"name":"query-gateway-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","config":{"included.client.audience":"query-gateway","access.token.claim":"true","id.token.claim":"false"}}
              JSON
              fi
              echo "realm mtco-bench ready"
          env:
            - name: KC_USER
              valueFrom: { secretKeyRef: { name: $KC_ADMIN_SECRET, key: username } }
            - name: KC_PASSWORD
              valueFrom: { secretKeyRef: { name: $KC_ADMIN_SECRET, key: password } }
            - name: CLIENT_SECRET
              valueFrom: { secretKeyRef: { name: mtco-bench, key: CLIENT_SECRET } }
YAML
  wait_job "$NS" mtco-bench-realm 300 \
    || { job_debug "$NS" mtco-bench-realm; die "could not create the bench realm (details above)"; }
  ok "realm mtco-bench ready"
}
delete_bench_realm() {
  kubectl -n "$NS" delete job mtco-bench-realm-delete --ignore-not-found >/dev/null
  cat <<YAML | kubectl -n "$NS" apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: mtco-bench-realm-delete
  labels: { app: mtco-bench-cleanup }
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: kcadm
          image: $KC_IMAGE
          command: ["/bin/bash", "-ec"]
          args:
            - |
              K=/opt/keycloak/bin/kcadm.sh
              \$K config credentials --server http://keycloak:8080 --realm master --user "\$KC_USER" --password "\$KC_PASSWORD" >/dev/null
              \$K delete realms/mtco-bench 2>/dev/null || true
              CID=\$(\$K get clients -r observability -q clientId=mtco-bench-reader --fields id --format csv --noquotes)
              [ -n "\$CID" ] && \$K delete "clients/\$CID" -r observability || true
              echo "realm mtco-bench removed"
          env:
            - name: KC_USER
              valueFrom: { secretKeyRef: { name: $KC_ADMIN_SECRET, key: username } }
            - name: KC_PASSWORD
              valueFrom: { secretKeyRef: { name: $KC_ADMIN_SECRET, key: password } }
YAML
  wait_job "$NS" mtco-bench-realm-delete 180 || warn "realm cleanup job did not finish (kubectl -n $NS logs job/mtco-bench-realm-delete)"
}

# ---------------------------------------------------------------- phases
phase0() {
  say "PHASE 0 — baseline, no load (${BASELINE}s)"
  local t0 t1
  t0=$(date +%s); sleep "$BASELINE"; t1=$(( $(date +%s) - 40 ))
  local w=$(( t1 - t0 ))
  md ""; md "## Phase 0 — Baseline (no load, ${BASELINE}s)"; md ""
  md "| Component | Avg CPU (cores) | Peak RAM (MiB) |"; md "|---|---|---|"
  for pair in "otel-gateway:$P_OTEL" "vminsert:$P_VMI" "vmstorage:$P_VMS" "vmselect:$P_VMSEL" "query-gateway:$P_QG" \
              "keycloak:$P_KC" "keycloak-postgres:$P_KCPG" "opensearch:$P_OS" "grafana:$P_GRAF" "control-plane:$P_CP"; do
    local n=${pair%%:*} p=${pair#*:} cpu mem
    cpu=$(avg_cpu "$p" "$w" "$t1"); mem=$(peak_mem "$p" "$w" "$t1")
    md "| $n | $(f "$cpu" 3) | $(mib "$mem") |"; rec 0 idle "cpu_$n" "$cpu"; rec 0 idle "mem_$n" "$mem"
  done
  local all; all=$(vmq "sum(increase(container_cpu_usage_seconds_total{$C}[${w}s])) / $w" "$t1")
  md ""; md "Total CPU of namespace observability at rest: **$(f "$all" 2) cores**."
  ok "baseline recorded"
}

phase1() {
  say "PHASE 1 — metrics write path: ${WRITE_HOSTS[*]} synthetic hosts, ${STEP}s each"
  md ""; md "## Phase 1 — Metrics write path (agent → Keycloak token → otel-gateway → VictoriaMetrics)"; md ""
  md "| Synthetic hosts | Points/s target | Points/s accepted | Points/s sent to VM | Max VM queue (batches) | Hosts found in VM | Rows/s into VM (all tenants) | Refused + failed | p99 otel-gateway (ms) | CPU otel-gw (cores) | CPU vminsert+vmstorage | RAM otel-gw (MiB) | Max CPU throttling | Verdict |"
  md "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  local best=0 hosts
  for hosts in "${WRITE_HOSTS[@]}"; do
    RUN="bm-$hosts-$(date +%H%M%S)"
    say "  step: $hosts hosts"
    start_load "$hosts" 0 "$STEP"
    local t_start=$(( $(date +%s) + 90 ))
    wait_load "$RUN" "$STEP"
    local t_end; t_end=$(( $(date +%s) - 40 )); local w=$(( t_end - t_start )); [ "$w" -lt 60 ] && w=60
    local target acc sent queue found ref fail rows p99 cpu_o cpu_v mem_o thr stats
    target=$(awk -v h="$hosts" 'BEGIN{printf "%.0f", h*10/15}')
    acc=$(otel_rate receiver_accepted_metric_points "$w" "$t_end")
    ref=$(otel_rate receiver_refused_metric_points "$w" "$t_end")
    fail=$(otel_rate exporter_send_failed_metric_points "$w" "$t_end")
    # End-to-end proof, not just the gateway's "accepted": what left the
    # exporter, whether its queue built up, and how many of this run's
    # hosts VictoriaMetrics actually returns for the test tenant.
    sent=$(otel_rate exporter_sent_metric_points "$w" "$t_end")
    queue=$(vmq "max_over_time(max(otelcol_exporter_queue_size{exporter=~\"prometheus_remote_write.*\",$S})[${w}s:15s])" "$t_end")
    found=$(vmq_tenant "count(count by (host_name) (last_over_time(system_memory_usage_bytes{host_name=~\"$RUN-host-.*\"}[10m])))")
    rows=$(vmq "sum(increase(vm_rows_inserted_total{job=\"vminsert\",$S}[${w}s])) / $w" "$t_end")
    p99=$(hq 0.99 "http_server_request_duration_bucket{job=\"otel-gateway\",$S}" "$w" "$t_end")
    cpu_o=$(avg_cpu "$P_OTEL" "$w" "$t_end")
    cpu_v=$(vmq "sum(increase(container_cpu_usage_seconds_total{$C,pod=~\"$P_VMI|$P_VMS\"}[${w}s])) / $w" "$t_end")
    mem_o=$(peak_mem "$P_OTEL" "$w" "$t_end")
    thr=$(throttle "$P_OTEL|$P_VMI|$P_VMS" "$w" "$t_end")
    stats=$(load_stats "$RUN"); end_load "$RUN"
    local lost; lost=$(awk -v r="$ref" -v f="$fail" 'BEGIN{ if (r=="NaN") r=0; if (f=="NaN") f=0; printf "%.2f", r+f }')
    local verdict="✅ ok"
    if gt "$lost" 0 || gt "$p99" 1 || gt "$thr" 0.25 || [ "$(cut -f3 <<<"$stats")" != 0 ] || [ "$(cut -f5 <<<"$stats")" != 0 ] \
       || gt "$queue" 5000 || awk -v a="$found" -v h="$hosts" 'BEGIN{exit !(a=="NaN" || a+0 < h*0.99)}'; then verdict="⚠️ limit reached"; fi
    md "| $hosts | $target | $(f "$acc" 0) | $(f "$sent" 0) | $(f "$queue" 0) | $(f "$found" 0) | $(f "$rows" 0) | $lost/s | $(ms "$p99") | $(f "$cpu_o" 2) | $(f "$cpu_v" 2) | $(mib "$mem_o") | $(pct "$thr") | $verdict |"
    for kv in "target:$target" "accepted:$acc" "sent_vm:$sent" "queue_max:$queue" "hosts_in_vm:$found" "refused:$ref" "export_failed:$fail" "vm_rows:$rows" "p99_s:$p99" \
              "cpu_otel:$cpu_o" "cpu_vm:$cpu_v" "mem_otel:$mem_o" "throttle:$thr" "loadgen:$(tr '\t' ' ' <<<"$stats")"; do
      rec 1 "$hosts" "${kv%%:*}" "${kv#*:}"
    done
    ok "$hosts hosts: accepted $(f "$acc" 0) points/s, p99 $(ms "$p99") ms — $verdict"
    if [[ "$verdict" == ✅* ]]; then best=$hosts; else warn "stopping phase 1 at $hosts hosts"; break; fi
  done
  BEST_HOSTS=$best
  [[ $best == 0 ]] && md "" && md "**Limit reached at the first step: check the cluster before reading the numbers above.**"
  if [[ $best == 0 ]]; then md ""; md "**Highest stable level: below ${WRITE_HOSTS[0]} synthetic hosts** (the first step already failed)."
  else md ""; md "**Highest stable level: $best synthetic hosts** (10 series per host, sent every 15 s)."; fi
}

phase2() {
  say "PHASE 2 — logs write path: ${LOG_RATES[*]} logs/s, ${STEP}s each"
  md ""; md "## Phase 2 — Logs write path (otel-gateway → OpenSearch)"; md ""
  md "| Logs/s target | Logs/s accepted | Written to OpenSearch/s | OpenSearch reply per batch (s) | Send failures/s | Max queue fill | Queue trend (end - middle) | p99 reply to agent (ms) | Refused by gateway/s | Workers stopped | CPU OpenSearch (cores) | RAM OpenSearch (MiB) | CPU otel-gw | Peak RAM, busiest otel-gw pod (MiB) | Verdict |"
  md "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  local best=0 rate
  for rate in "${LOG_RATES[@]}"; do
    RUN="bl-$rate-$(date +%H%M%S)"
    say "  step: $rate logs/s"
    # LOAD_PODS x 100 hosts = every generator pod shares the log rate;
    # metrics kept tiny.
    start_load $(( LOAD_PODS * 100 )) "$rate" "$STEP" 50
    local t_start=$(( $(date +%s) + 90 ))
    wait_load "$RUN" "$STEP"
    local t_end; t_end=$(( $(date +%s) - 40 )); local w=$(( t_end - t_start )); [ "$w" -lt 60 ] && w=60
    local acc sent queue fail refused p99 cpu_os mem_os cpu_o mem_o stats
    acc=$(otel_rate receiver_accepted_log_records "$w" "$t_end")
    sent=$(otel_rate exporter_sent_log_records "$w" "$t_end")
    refused=$(otel_rate receiver_refused_log_records "$w" "$t_end")
    # Average time OpenSearch takes to answer one bulk request. With a fixed
    # number of senders, writes/s = senders x batch size / this time.
    local bulk_s
    bulk_s=$(vmq "sum(increase(http_client_request_duration_sum{server_address=\"opensearch\",pod=~\"$P_OTEL\",$S}[${w}s])) / sum(increase(http_client_request_duration_count{server_address=\"opensearch\",pod=~\"$P_OTEL\",$S}[${w}s]))" "$t_end")
    # Highest single pod, which is what memory_limiter compares to its limit.
    mem_o=$(vmq "max_over_time(max(container_memory_working_set_bytes{$C,pod=~\"$P_OTEL\"})[${w}s:30s])" "$t_end")
    # Fill ratio (0-1), whatever the queue unit (batches or bytes).
    local fill_expr="max(otelcol_exporter_queue_size{exporter=\"opensearch\",$S}) / max(otelcol_exporter_queue_capacity{exporter=\"opensearch\",$S})"
    queue=$(vmq "max_over_time(($fill_expr)[${w}s:15s])" "$t_end")
    # Trend: average fill over the last 2 minutes minus the 2 minutes in
    # the middle of the window. A queue that settles (even at 40%) means
    # OpenSearch keeps up; one that keeps growing means it does not.
    local q_mid q_end grow
    q_mid=$(vmq "avg_over_time(($fill_expr)[120s:15s])" "$(( t_end - w / 2 ))")
    q_end=$(vmq "avg_over_time(($fill_expr)[120s:15s])" "$t_end")
    grow=$(awk -v a="$q_end" -v b="$q_mid" 'BEGIN{ if (a=="NaN" || b=="NaN") print "NaN"; else printf "%.4f", a-b }')
    fail=$(otel_rate exporter_send_failed_log_records "$w" "$t_end")
    p99=$(hq 0.99 "http_server_request_duration_bucket{job=\"otel-gateway\",$S}" "$w" "$t_end")
    cpu_os=$(avg_cpu "$P_OS" "$w" "$t_end"); mem_os=$(peak_mem "$P_OS" "$w" "$t_end")
    cpu_o=$(avg_cpu "$P_OTEL" "$w" "$t_end")
    stats=$(load_stats "$RUN"); end_load "$RUN"
    local verdict="✅ ok"
    # The queue answers agents at once, so also require OpenSearch to keep
    # up: sent >= 90% of the rate and the queue never over half full.
    if gt "$fail" 0 || gt "$p99" 1 || [ "$(cut -f3 <<<"$stats")" != 0 ] || [ "$(cut -f5 <<<"$stats")" != 0 ] || gt "$queue" 0.8 || gt "$grow" 0.1 \
       || awk -v x="$refused" -v r="$rate" 'BEGIN{exit !(x!="NaN" && x+0 > r*0.01)}'  \
       || awk -v a="$sent" -v r="$rate" 'BEGIN{exit !(a=="NaN" || a+0 < r*0.9)}' \
       || awk -v a="$acc" -v r="$rate" 'BEGIN{exit !(a=="NaN" || a+0 < r*0.9)}'; then verdict="⚠️ limit reached"; fi
    md "| $rate | $(f "$acc" 0) | $(f "$sent" 0) | $(f "$bulk_s" 2) | $(f "$fail" 2) | $(pct "$queue") | $(pct "$grow") | $(ms "$p99") | $(f "$refused" 0) | $(cut -f5 <<<"$stats") / $LOAD_PODS | $(f "$cpu_os" 2) | $(mib "$mem_os") | $(f "$cpu_o" 2) | $(mib "$mem_o") | $verdict |"
    for kv in "accepted:$acc" "sent_opensearch:$sent" "bulk_reply_s:$bulk_s" "queue_max:$queue" "queue_trend:$grow" "export_failed:$fail" "p99_s:$p99" "cpu_opensearch:$cpu_os" "mem_opensearch:$mem_os" "cpu_otel:$cpu_o" "refused:$refused" "mem_otel:$mem_o" "workers_stopped:$(cut -f5 <<<"$stats")"; do
      rec 2 "$rate" "${kv%%:*}" "${kv#*:}"
    done
    ok "$rate logs/s: accepted $(f "$acc" 0)/s — $verdict"
    if [[ "$verdict" == ✅* ]]; then best=$rate; else warn "stopping phase 2 at $rate logs/s"; break; fi
  done
  [[ $best == 0 ]] && md "" && md "**Limit reached at the first step: check the cluster before reading the numbers above.**"
  BEST_LOGS=$best
  if [[ $best == 0 ]]; then md ""; md "**Highest stable level: below ${LOG_RATES[0]} logs/s** (the first step already failed)."
  else md ""; md "**Highest stable level: $best logs/s** (all written to OpenSearch, queue not building up)."; fi
}

phase3() {
  say "PHASE 3 — Keycloak tokens (client_credentials): ${TOKEN_RATES[*]} req/s, ${SHORT}s each"
  ensure_bench_realm
  md ""; md "## Phase 3 — Keycloak issuing agent tokens ($KC_REPLICAS replica(s))"; md ""
  md "33 tokens/s ≈ **2,000 agents** renewing a 60-second token (the project target)."; md ""
  md "| Tokens/s target | Achieved | Errors | p50 (ms) | p95 (ms) | p99 (ms) | CPU Keycloak (cores) | RAM Keycloak (MiB) | CPU Keycloak Postgres | Postgres connections | k6 dropped | Verdict |"
  md "|---|---|---|---|---|---|---|---|---|---|---|---|"
  local best=0 rate
  for rate in "${TOKEN_RATES[@]}"; do
    say "  step: $rate tokens/s"
    local js t_end w
    js=$(k6_job "mtco-bench-token-$rate" token.js "$rate" "$SHORT")
    t_end=$(( $(date +%s) - 40 )); w=$(( SHORT - 60 ))
    [ -n "$js" ] || { warn "no k6 summary for $rate/s"; break; }
    local got err p50 p95 p99 cpu_k mem_k cpu_p conns
    got=$(jq -r .achieved_rps <<<"$js"); err=$(jq -r .error_rate <<<"$js")
    p50=$(jq -r .p50_ms <<<"$js"); p95=$(jq -r .p95_ms <<<"$js"); p99=$(jq -r .p99_ms <<<"$js")
    cpu_k=$(avg_cpu "$P_KC" "$w" "$t_end"); mem_k=$(peak_mem "$P_KC" "$w" "$t_end")
    cpu_p=$(avg_cpu "$P_KCPG" "$w" "$t_end")
    conns=$(vmq "max_over_time(sum(pg_stat_database_numbackends{database=\"keycloak\",datname!~\"template.*|postgres\",$S})[${w}s:30s])" "$t_end")
    local verdict="✅ ok"
    if gt "$err" 0.01 || gt "$p99" 1000 || awk -v g="$got" -v r="$rate" 'BEGIN{exit !(g+0 < r*0.95)}'; then verdict="⚠️ limit reached"; fi
    md "| $rate | $(f "$got" 1) | $(pct "$err") | $(f "$p50" 0) | $(f "$p95" 0) | $(f "$p99" 0) | $(f "$cpu_k" 2) | $(mib "$mem_k") | $(f "$cpu_p" 2) | $(f "$conns" 0) | $(jq -r .dropped <<<"$js") | $verdict |"
    for kv in "achieved:$got" "error_rate:$err" "p50_ms:$p50" "p95_ms:$p95" "p99_ms:$p99" "cpu_keycloak:$cpu_k" "mem_keycloak:$mem_k" "cpu_kc_postgres:$cpu_p" "pg_conns:$conns"; do
      rec 3 "$rate" "${kv%%:*}" "${kv#*:}"
    done
    ok "$rate tokens/s: got $(f "$got" 1)/s, p99 $(f "$p99" 0) ms, errors $(pct "$err") — $verdict"
    if [[ "$verdict" == ✅* ]]; then best=$rate; else warn "stopping phase 3 at $rate tokens/s"; break; fi
  done
  BEST_TOKENS=$best
  local agents=$(( best * 60 ))
  [[ $best == 0 ]] && md "" && md "**Limit reached at the first step: check the cluster before reading the numbers above.**"
  if [[ $best == 0 ]]; then md ""; md "**Highest stable level: below ${TOKEN_RATES[0]} tokens/s** (the first step already failed)."
  else md ""; md "**Highest stable level: $best tokens/s ≈ $agents agents** (60-second tokens)."; fi
}

phase4() {
  say "PHASE 4 — read path through query-gateway: ${READ_RATES[*]} req/s, ${SHORT}s each (with 100 hosts writing)"
  ensure_bench_realm
  local total=$(( ${#READ_RATES[@]} * (SHORT + 90) + 120 ))
  RUN="br-$(date +%H%M%S)"; start_load 100 5 "$total"; sleep 120   # data to read
  # Dashboards cover every host of the tenant, so read cost grows with the
  # hosts that wrote in the queried window (earlier phases leave many).
  local seen1h seen6h
  seen1h=$(vmq_tenant 'count(count by (host_name) (last_over_time(system_memory_usage_bytes[1h])))')
  seen6h=$(vmq_tenant 'count(count by (host_name) (last_over_time(system_memory_usage_bytes[6h])))')
  md ""; md "## Phase 4 — Read path (Grafana-like → query-gateway → vmselect / OpenSearch), 100 hosts writing meanwhile"; md ""
  md "Hosts the dashboard queries cover: **$(f "$seen1h" 0)** in the last 1 h, **$(f "$seen6h" 0)** in the last 6 h."; md ""
  md "| Queries/s target | Achieved | Errors | p50 (ms) | p95 (ms) | p99 (ms) | p99 query-gateway (ms) | Storage wait p95 (ms) | CPU query-gateway | CPU vmselect | vmselect CPU throttled | Event-loop lag p99 (ms) | Verdict |"
  md "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  local best=0 rate details=()
  for rate in "${READ_RATES[@]}"; do
    say "  step: $rate queries/s"
    local js t_end w
    js=$(k6_job "mtco-bench-read-$rate" read.js "$rate" "$SHORT")
    t_end=$(( $(date +%s) - 40 )); w=$(( SHORT - 60 ))
    [ -n "$js" ] || { warn "no k6 summary for $rate/s"; break; }
    local got err p50 p95 p99 qp99 up95 cpu_q cpu_s lag
    got=$(jq -r .achieved_rps <<<"$js"); err=$(jq -r .error_rate <<<"$js")
    p50=$(jq -r .p50_ms <<<"$js"); p95=$(jq -r .p95_ms <<<"$js"); p99=$(jq -r .p99_ms <<<"$js")
    qp99=$(hq 0.99 "http_server_request_duration_seconds_bucket{job=\"query-gateway\",$S}" "$w" "$t_end")
    up95=$(hq 0.95 "query_gateway_upstream_duration_seconds_bucket{$S}" "$w" "$t_end")
    cpu_q=$(avg_cpu "$P_QG" "$w" "$t_end"); cpu_s=$(avg_cpu "$P_VMSEL" "$w" "$t_end")
    local thr_s; thr_s=$(throttle "$P_VMSEL" "$w" "$t_end")
    lag=$(vmq "max_over_time(max(nodejs_eventloop_lag_seconds{job=\"query-gateway\",quantile=\"0.99\",$S})[${w}s:30s])" "$t_end")
    local verdict="✅ ok"
    if gt "$err" 0.01 || gt "$p99" 2000 || awk -v g="$got" -v r="$rate" 'BEGIN{exit !(g+0 < r*0.95)}'; then verdict="⚠️ limit reached"; fi
    md "| $rate | $(f "$got" 1) | $(pct "$err") | $(f "$p50" 0) | $(f "$p95" 0) | $(f "$p99" 0) | $(ms "$qp99") | $(ms "$up95") | $(f "$cpu_q" 2) | $(f "$cpu_s" 2) | $(pct "$thr_s") | $(ms "$lag") | $verdict |"
    for kv in "achieved:$got" "error_rate:$err" "p50_ms:$p50" "p95_ms:$p95" "p99_ms:$p99" "qgw_p99_s:$qp99" "upstream_p95_s:$up95" "cpu_qgw:$cpu_q" "cpu_vmselect:$cpu_s" "throttle_vmselect:$thr_s" "hosts_1h:$seen1h" "hosts_6h:$seen6h" "loop_lag_p99_s:$lag"; do
      rec 4 "$rate" "${kv%%:*}" "${kv#*:}"
    done
    details+=("$(jq -r --arg r "$rate" '"| \($r) | \(.warmup_p99_ms|floor) / \(.warmup_max_ms|floor) | " + ([.by_query[] | "\(.p50_ms|floor) / \(.p99_ms|floor)"] | join(" | ")) + " |"' <<<"$js")")
    ok "$rate queries/s: got $(f "$got" 1)/s, p99 $(f "$p99" 0) ms, errors $(pct "$err") — $verdict"
    if [[ "$verdict" == ✅* ]]; then best=$rate; else warn "stopping phase 4 at $rate queries/s"; break; fi
  done
  end_load "$RUN"
  BEST_READS=$best
  md ""; md "Per query type (ms, p50 / p99 after the first ${READ_WARMUP}s; warm-up column: p99 / max during the first ${READ_WARMUP}s):"; md ""
  md "| Queries/s | Warm-up | CPU 1h | RAM 1h | Network 6h | Host count | Logs 15 min |"
  md "|---|---|---|---|---|---|---|"
  local d; for d in "${details[@]}"; do md "$d"; done
  [[ $best == 0 ]] && md "" && md "**Limit reached at the first step: check the cluster before reading the numbers above.**"
  if [[ $best == 0 ]]; then md ""; md "**Highest stable level: below ${READ_RATES[0]} queries/s** (the first step already failed)."
  else md ""; md "**Highest stable level: $best queries/s** (4 of 5 are metrics query_range/instant, 1 of 5 a 15-minute log search)."; fi
}

mixed() {   # minutes title phase-number
  local minutes=$1 title=$2 ph=$3
  local hosts=${BEST_HOSTS:-${BENCH_MIXED_HOSTS:-1000}} tokens=33 reads=${BENCH_MIXED_READS:-20}
  [ "$hosts" -gt 0 ] || hosts=100
  say "PHASE $ph — $title: $hosts hosts + $tokens tokens/s + $reads queries/s for ${minutes} min"
  ensure_bench_realm
  local secs=$(( minutes * 60 ))
  RUN="bx-$(date +%H%M%S)"; start_load "$hosts" 20 "$(( secs + 180 ))"; sleep 90
  local t_start; t_start=$(date +%s)
  k6_job "mtco-bench-mixed-token" token.js "$tokens" "$secs" > "$OUT/mixed-token.json" &
  local tok_pid=$!
  local read_js; read_js=$(k6_job "mtco-bench-mixed-read" read.js "$reads" "$secs")
  wait "$tok_pid" || true
  local t_end; t_end=$(( $(date +%s) - 40 )); local w=$(( t_end - t_start ))
  local tok_js; tok_js=$(cat "$OUT/mixed-token.json")
  local acc fail p99o all mem_all
  acc=$(otel_rate receiver_accepted_metric_points "$w" "$t_end")
  fail=$(otel_rate exporter_send_failed_metric_points "$w" "$t_end")
  p99o=$(hq 0.99 "http_server_request_duration_bucket{job=\"otel-gateway\",$S}" "$w" "$t_end")
  all=$(vmq "sum(increase(container_cpu_usage_seconds_total{$C}[${w}s])) / $w" "$t_end")
  mem_all=$(vmq "max_over_time(sum(container_memory_working_set_bytes{$C})[${w}s:60s])" "$t_end")
  wait_load "$RUN" 0; end_load "$RUN"
  md ""; md "## Phase $ph — $title (${minutes} min)"; md ""
  md "| Metric | Value |"; md "|---|---|"
  md "| Synthetic hosts writing | $hosts |"
  md "| Metric points accepted/s | $(f "$acc" 0) (send failures: $(f "$fail" 2)/s) |"
  md "| p99 otel-gateway | $(ms "$p99o") ms |"
  md "| Tokens/s (achieved / p99 / errors) | $(f "$(jq -r '.achieved_rps // "NaN"' <<<"$tok_js")" 1) / $(f "$(jq -r '.p99_ms // "NaN"' <<<"$tok_js")" 0) ms / $(pct "$(jq -r '.error_rate // "NaN"' <<<"$tok_js")") |"
  md "| Queries/s (achieved / p99 / errors) | $(f "$(jq -r '.achieved_rps // "NaN"' <<<"$read_js")" 1) / $(f "$(jq -r '.p99_ms // "NaN"' <<<"$read_js")" 0) ms / $(pct "$(jq -r '.error_rate // "NaN"' <<<"$read_js")") |"
  md "| Total CPU, namespace observability | $(f "$all" 2) cores |"
  md "| Total peak RAM, namespace observability | $(mib "$mem_all") MiB |"
  rec "$ph" mixed accepted "$acc"; rec "$ph" mixed p99_otel_s "$p99o"; rec "$ph" mixed cpu_total "$all"; rec "$ph" mixed mem_total "$mem_all"
  ok "$title done"
}

# ---------------------------------------------------------------- main
if [ "${PHASES[0]}" = cleanup ]; then
  say "cleanup"
  kubectl -n "$NS" delete job -l app=mtco-bench --ignore-not-found
  kubectl -n "$NS" delete secret mtco-bench --ignore-not-found
  kubectl -n "$NS" delete configmap mtco-bench-k6 --ignore-not-found
  resolve_kc_admin
  delete_bench_realm
  kubectl delete namespace "$LOAD_NS" --ignore-not-found
  rm -rf "$OUT"
  ok "benchmark resources removed (stored telemetry and tenant $TENANT are kept)"
  exit 0
fi

echo "phase,step,key,value" > "$CSV"
preflight
port_forward keycloak "$KC_PORT" 8080
port_forward control-plane "$CP_PORT" 8080
port_forward vmselect "$VM_PORT" 8481
login
resolve_kc_admin
KC_REPLICAS=$(kubectl -n "$NS" get deploy keycloak -o jsonpath='{.spec.replicas}')
ISSUER=$(curl -fsS "http://127.0.0.1:$KC_PORT/realms/observability/.well-known/openid-configuration" | jq -r .issuer)
[ -n "$ISSUER" ] && [ "$ISSUER" != null ] || die "cannot read the Keycloak issuer"
ok "issuer: $ISSUER"
ensure_tenant
kubectl get ns "$LOAD_NS" >/dev/null 2>&1 || kubectl create namespace "$LOAD_NS" >/dev/null
CLIENT_SECRET=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
bench_secret

NODES=$(kubectl get nodes --no-headers | wc -l)
CPUS=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.capacity.cpu}{"\n"}{end}' | awk '{s+=$1} END{print s}')
MEM=$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.capacity.memory}{"\n"}{end}' | awk '{gsub("Ki","",$1); s+=$1} END{printf "%.1f", s/1048576}')
{
  echo "# MTCO — Benchmark results ($(date '+%Y-%m-%d %H:%M'))"
  echo ""
  echo "- Cluster: **$NODES nodes, $CPUS CPUs, $MEM GiB RAM** (context \`$(kubectl config current-context)\`)"
  echo "- Versions: control-plane \`$(kubectl -n $NS get deploy control-plane -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's#.*:##')\`, query-gateway \`$(kubectl -n $NS get deploy query-gateway -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's#.*:##')\`, Keycloak $KC_REPLICAS replica(s)"
  echo "- Profile: $PROFILE, ${STEP}s per step (k6: ${SHORT}s), test tenant \`$TENANT\`"
  echo "- Stop rules: errors > 1%, p99 > 1 s (writes/tokens) or > 2 s (reads), CPU throttled > 25%, or < 95% of the target rate achieved"
} > "$MD"

BEST_HOSTS="" BEST_LOGS="" BEST_TOKENS="" BEST_READS=""
for ph in "${PHASES[@]}"; do
  case "$ph" in
    0) phase0 ;;
    1) phase1 ;;
    2) phase2 ;;
    3) phase3 ;;
    4) phase4 ;;
    6) mixed "$MIXED_MIN" "A real day (writes + tokens + reads together)" 6 ;;
    7) mixed "$SOAK_MIN" "Soak" 7 ;;
  esac
done

{
  echo ""; echo "## Summary for slides"; echo ""
  [ -n "$BEST_HOSTS" ] && [ "$BEST_HOSTS" = 0 ] && echo "- **Metrics writes:** limit reached already at ${WRITE_HOSTS[0]} hosts (see phase 1)."
  [ -n "$BEST_HOSTS" ] && [ "$BEST_HOSTS" != 0 ] && echo "- **Metrics writes:** stable at **$BEST_HOSTS hosts** ($(( BEST_HOSTS * 10 / 15 )) points/s), no data lost."
  [ -n "$BEST_LOGS" ] && [ "$BEST_LOGS" = 0 ] && echo "- **Log writes:** limit reached already at ${LOG_RATES[0]} logs/s (see phase 2)."
  [ -n "$BEST_LOGS" ] && [ "$BEST_LOGS" != 0 ] && echo "- **Log writes:** **$BEST_LOGS logs/s**, agents answered within milliseconds thanks to the queue; OpenSearch keeps up."
  [ -n "$BEST_TOKENS" ] && [ "$BEST_TOKENS" = 0 ] && echo "- **Keycloak ($KC_REPLICAS replica(s)):** limit reached already at ${TOKEN_RATES[0]} tokens/s (see phase 3)."
  [ -n "$BEST_TOKENS" ] && [ "$BEST_TOKENS" != 0 ] && echo "- **Keycloak ($KC_REPLICAS replica(s)):** **$BEST_TOKENS tokens/s** ≈ **$(( BEST_TOKENS * 60 )) agents**; the 2,000-agent target needs 33/s."
  [ -n "$BEST_READS" ] && [ "$BEST_READS" = 0 ] && echo "- **Reads through query-gateway:** limit reached already at ${READ_RATES[0]} queries/s (see phase 4)."
  [ -n "$BEST_READS" ] && [ "$BEST_READS" != 0 ] && echo "- **Reads through query-gateway:** **$BEST_READS queries/s** while data is being written." || true
  echo "- Raw numbers: \`raw.csv\`; k6 summaries: \`*.json\`; dashboard: Grafana → Platform → Benchmark (same time range)."
} >> "$MD"

say "done"
echo
cat "$MD"
echo
ok "report: ${MD#$ROOT/}"
