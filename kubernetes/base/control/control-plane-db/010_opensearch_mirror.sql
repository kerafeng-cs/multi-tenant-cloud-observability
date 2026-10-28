-- TODO-15: control-plane also mirrors each tenant into the OpenSearch
-- security config of its logs store (role + internal user mtco-tenant-<key>
-- that query-gateway impersonates). New outbox target "opensearch".
BEGIN;

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_target_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_target_check
  CHECK (target IN ('keycloak', 'grafana', 'opensearch'));

COMMIT;
