# Data stores (TODO-28)

A **data store** is one storage cluster: a VictoriaMetrics cluster for
metrics, or an OpenSearch cluster for logs. Every tenant has one store of
each kind, chosen when the tenant is created and **never changed** (moving
a tenant would leave its history behind; a DB trigger refuses the change).

- **N:1** — several tenants share a store (`shared`, the default).
  Tenants stay apart inside it: VictoriaMetrics account per tenant, one
  OpenSearch data stream per tenant.
- **1:1** — a store with `"exclusive": true` takes at most one tenant that
  is not deleted (control-plane answers `409 data_store_taken` otherwise).

## How a request finds its store

1. control-plane stores `tenants.metrics_store` / `tenants.logs_store`
   and writes them to Keycloak: tenant group attributes (people) and agent
   service-account attributes (agents).
2. Keycloak puts them in every token as the claims `metrics_store` and
   `logs_store` (mappers created by the keycloak-bootstrap Job).
3. **Write path** — otel-gateway copies the claims into resource
   attributes (anything the agent sent under those names is deleted
   first), the `routing/*` connectors pick the store's pipeline, and the
   attributes are removed before export. No claim → `shared`. A store the
   gateway does not know → the agent gets a retryable 503.
4. **Read path** — query-gateway reads the store named by the user's claim
   (tenant users) or by the `X-MTCO-Scope-Store` header of the tenant org
   datasource (platform admins; org 1 = `shared`). A store it does not
   know → 503.

## The catalog

`stores.json` here becomes the ConfigMap `data-stores`:

```json
{
  "metrics": {
    "shared": { "queryUrl": "http://vmselect:8481", "exclusive": false }
  },
  "logs": {
    "shared": {
      "queryUrl": "https://opensearch:9200",
      "credentials": "OPENSEARCH",
      "exclusive": false
    }
  }
}
```

- `queryUrl` — where query-gateway reads (vmselect / OpenSearch).
- `credentials` (logs only) — env prefix of that store's read account in
  query-gateway: `<PREFIX>_USERNAME` and `<PREFIX>_PASSWORD`.
- Names: 1-40 lowercase letters, digits or hyphens. `shared` must exist
  and cannot be exclusive.

## Adding a data store

Example: a dedicated VictoriaMetrics cluster `dedicated-1`.

1. **Deploy the cluster.** Its pods need their OWN `app` labels (for
   example `vminsert-dedicated-1`): the Services of the shared cluster
   select by `app`, so reusing `app: vminsert` would mix the two
   clusters. Add the new `app` values to the `internal-only`
   NetworkPolicy and to the vmagent scrape config.
2. **Catalog** — add it to `stores.json`:
   `"dedicated-1": { "queryUrl": "http://vmselect-dedicated-1:8481", "exclusive": true }`.
   For an OpenSearch store also give `credentials` and add the two env
   variables (from a Secret) to the query-gateway Deployment.
3. **otel-gateway** (`kubernetes/base/ingest/otel-gateway/config/collector.yaml`):
   - an exporter for the store (same settings as the shared one, new
     endpoint; for OpenSearch its own ingest account and queue);
   - a pipeline `metrics/dedicated-1` (receivers `[routing/metrics]`,
     processors `[resource/route-done]`; logs also `batch`, after it);
   - a route in `routing/metrics`:
     `condition: attributes["mtco.metrics.store"] == "dedicated-1"`;
   - add `and attributes["mtco.metrics.store"] != "dedicated-1"` to the
     unknown-store condition.
4. Apply. Then create the tenant with
   `tools/mtco tenants create gamma-tenant --metrics-store dedicated-1`.

Order matters: the gateways must know a store before any tenant is placed
in it; until then its agents get 503 (and retry) instead of losing data.
