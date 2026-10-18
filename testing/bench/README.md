# Whole-system benchmark (TODO-30)

One command, from the repository root:

```bash
./testing/bench/bench.sh --quick       # ~1 h: short steps, fewer levels
./testing/bench/bench.sh               # ~2 h 40: phases 0-4, up to the 2,000-agent target and beyond
./testing/bench/bench-stress.sh        # ~2 h 30: 10x-20x the target, to find where each path breaks
./testing/bench/bench.sh 3             # a single phase (here: Keycloak)
./testing/bench/bench.sh 6             # "a real day": writes + tokens + reads together (30 min)
./testing/bench/bench.sh 7             # soak, 2 h (BENCH_SOAK_MINUTES to change)
./testing/bench/bench.sh cleanup       # remove everything the benchmark created
```

The script port-forwards Keycloak, control-plane and vmselect; signs in once (asks for a
platform-admin password, user `dat` by default, `BENCH_USER` to change); creates the test
tenant `bench-tenant` if missing (`BENCH_TENANT`); runs each level; reads the numbers from
the platform's self-monitoring (VictoriaMetrics account 1); stops a phase at its first
failing level; and cleans up.

| Phase | What it measures | How |
|---|---|---|
| 0 | Baseline: CPU/RAM of every component with no load | — |
| 1 | Metrics writes: synthetic hosts (100 → 2,000; stress 2,000 → 20,000) | loadgen in namespace `mtco-loadtest`, the same path as a real agent |
| 2 | Log writes: logs/s (50 → 1,000; stress 1,000 → 10,000) | loadgen |
| 3 | Keycloak issuing agent tokens (client_credentials): 10 → 600/s (stress 100 → 1,500/s) | k6, throw-away realm `mtco-bench` (20 clients) |
| 4 | Reads through query-gateway, like Grafana with tenant scope headers, while 100 hosts write | k6, temporary client `mtco-bench-reader` |
| 6 / 7 | Everything together / for hours | loadgen + k6 |

A level fails ("limit reached") when errors > 1%, p99 > 1 s (writes, tokens) or > 2 s
(reads), CPU is throttled > 25% of the time, less than 95% of the target rate is achieved,
or (logs) OpenSearch writes < 90% of the rate or the exporter queue is over half full.
Phase 3's "k6 dropped" > 0 means k6 itself ran short of CPU.

Results: `testing/bench/results/<date-time>/summary.md` (tables, plus "Summary for slides"
at the end), `raw.csv`, and the k6 summaries `*.json`. Grafana → Platform → Benchmark over
the same time range gives the graphs.

Notes:
- The load generators run inside the same cluster as MTCO, so they take part of its CPU:
  the ceilings found are lower bounds, especially in stress mode (20 loadgen pods + k6).
- Read cost grows with the number of hosts a dashboard covers. Phase 4 prints how many
  hosts of the test tenant wrote in the last 1 h / 6 h; earlier phases leave many.
- The password lives only in memory and in the Secret `mtco-bench` (deleted at exit).
- Ctrl-C stops the load and removes Jobs/Secrets. The realm `mtco-bench`, the client
  `mtco-bench-reader` and the namespace `mtco-loadtest` are kept for the next run
  (client secrets are reset on every run); remove them with `cleanup`.
- The tenant `bench-tenant` and the data written are kept (a tenant key cannot be reused
  after deletion).
- Phase 3 with 2-3 Keycloak replicas needs clustering configured first (TODO-30).
