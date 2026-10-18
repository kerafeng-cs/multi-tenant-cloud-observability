#!/usr/bin/env bash
# MTCO stress benchmark: the same suite as bench.sh, pushed 10x-20x past
# the 2,000-agent target to find where each path breaks. Run from the
# repository root:
#
#   ./testing/bench/bench-stress.sh          phases 0-4 (about 3h)
#   ./testing/bench/bench-stress.sh 1 3      only phases 1 and 3
#
# Levels: metrics 2,000 -> 20,000 hosts | logs 1,000 -> 10,000/s |
#         tokens 100 -> 1,500/s (20,000 agents need 333/s) |
#         reads 10 -> 50/s. Load generators run inside the same cluster,
#         so the ceilings found are lower bounds.
exec "$(dirname "${BASH_SOURCE[0]}")/bench.sh" --stress "$@"
