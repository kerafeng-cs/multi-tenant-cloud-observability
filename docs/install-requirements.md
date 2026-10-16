# What the network around MTCO must provide

MTCO runs inside one Kubernetes namespace (`observability`). Everything
in this file lives **outside** the product: the enterprise network (or,
for the lab cluster, `environment/lab/`) provides it.

## Public names

One entry point (ingress controller / load balancer, internal network
only) must route these names to the Services of namespace
`observability`. The names are configured in ONE place: ConfigMap
`platform-endpoints` (`kubernetes/overlays/<env>/kustomization.yaml`).

| Name (development overlay) | Service:port | Used by |
|---|---|---|
| `keycloak.mtco.test` | `keycloak:8080` | browsers (login), agents (tokens) |
| `grafana.mtco.test` | `grafana:3000` | browsers (dashboards) |
| `mtco.test` | `control-plane-ui:8080` | browsers (web UI), `tools/mtco`, `client/bootstrap.sh` (API under `/api/v1`) |
| `otel.mtco.test` | `otel-gateway:4318` | agents (OTLP/HTTP telemetry) |

The enterprise DNS must resolve these names to the entry point for every
client: user machines and monitored hosts.

## Scheme

HTTP for now (decided 2026-10-15). The token issuer is
`<KEYCLOAK_PUBLIC_URL>/realms/observability`. Changing the scheme (e.g. to
HTTPS terminated at the entry point) or any name changes the issuer:
plan it as a fresh install.

## Inside the cluster

Nothing here needs the enterprise DNS: MTCO components talk to each other
through Kubernetes Service names, and validate tokens with keys fetched
from `http://keycloak:8080` inside the cluster.

Workloads in **other namespaces** may send telemetry directly:

- token: `http://keycloak.observability.svc.cluster.local:8080/realms/observability/protocol/openid-connect/token`
- telemetry: `http://otel-gateway.observability.svc.cluster.local:4318`

Tokens obtained there carry the same public issuer. NetworkPolicy
`internal-only` keeps databases, storage and query-gateway reachable from
the `observability` namespace only.
