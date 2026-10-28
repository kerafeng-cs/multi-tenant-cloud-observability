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
5. **Logs isolation in the store (TODO-15)** — control-plane keeps a role
   and internal user `mtco-tenant-<key>` per tenant in the tenant's logs
   store (read `otel-logs-<key>` only). Every tenant-scoped log request
   goes to that stream and runs AS that user (header
   `opendistro_security_impersonate_as`), so OpenSearch itself refuses
   other tenants' data. Only an unscoped platform admin (Grafana org 1)
   reads `otel-logs*` with the gateway account.

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

The base ships only `shared`. Extra stores belong to an environment
overlay; the development overlay's `dedicated-1` (TODO-28 phase B) is the
worked example:

| Piece | development overlay file |
|---|---|
| The cluster(s) | `cells/dedicated-1/` |
| Catalog (replaces this one) | `stores.json` + `configMapGenerator` `data-stores`, `behavior: replace` |
| Write side | `otel-gateway-stores.yaml`, added to ConfigMap `otel-gateway-config` (`behavior: merge`) and loaded as a second `--config` |
| Internal-only traffic | patch of NetworkPolicy `internal-only` |

1. **Deploy the cluster.** Its pods need their OWN `app` labels (for
   example `vminsert-dedicated-1`): the Services of the shared cluster
   select by `app`, so reusing `app: vminsert` would mix the two
   clusters. Add the new `app` values to the `internal-only`
   NetworkPolicy. vmagent already scrapes `vminsert|vmselect|vmstorage`
   with any `-<suffix>`. A new OpenSearch needs its own certificate from
   the `observability-ca` Issuer and the bootstrap Job pointed at it
   (`OPENSEARCH_URL`, `LOGS_SHARDS`, `LOGS_REPLICAS`; see
   `cells/dedicated-1/bootstrap`). It also needs the setting
   `plugins.security.authcz.rest_impersonation_user.query-gateway:
   mtco-tenant-*` (TODO-15, same env as the shared StatefulSet): the
   bootstrap Job creates the control-plane account there, and
   control-plane then creates each tenant's read role in that store.
2. **Catalog** — the overlay's `stores.json` lists `shared` plus the new
   store, e.g.
   `"dedicated-1": { "queryUrl": "http://vmselect-dedicated-1:8481", "exclusive": true }`.
   An OpenSearch store also names `credentials` (the shared read account
   `OPENSEARCH` works if the bootstrap Job created it there; another
   prefix needs its two env variables on the query-gateway Deployment).
3. **otel-gateway** — the overlay's extra collector file holds:
   - an exporter for the store (same settings as the shared one, new
     endpoint; for OpenSearch its own queue);
   - a pipeline `metrics/dedicated-1` (receivers `[routing/metrics]`,
     processors `[resource/route-done]`; logs also `batch`, after it);
   - the COMPLETE routing tables of `routing/metrics` and `routing/logs`
     (the collector merges maps but replaces lists): a route
     `attributes["mtco.metrics.store"] == "dedicated-1"`, and the
     unknown-store route extended with
     `and attributes["mtco.metrics.store"] != "dedicated-1"`.
4. Apply. Then create the tenant with
   `tools/mtco tenants create gamma-tenant --metrics-store dedicated-1 --logs-store dedicated-1`.

Order matters: the gateways must know a store before any tenant is placed
in it; until then its agents get 503 (and retry) instead of losing data.
