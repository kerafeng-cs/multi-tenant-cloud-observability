BEGIN;

-- ---------------------------------------------------------------
-- 2026-10-19 (TODO-28): where each tenant's data lives.
-- A data store is one VictoriaMetrics cluster (metrics) or one OpenSearch
-- cluster (logs), named in the data-stores catalog (ConfigMap). Several
-- tenants may share a store (N:1) or a tenant may have one of its own
-- (1:1, "exclusive" in the catalog; enforced by control-plane).
-- Chosen when the tenant is created and never changed afterwards: moving
-- a tenant would leave its history in the old store.
-- Existing tenants stay in the shared stores.
-- ---------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS metrics_store TEXT NOT NULL DEFAULT 'shared';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logs_store TEXT NOT NULL DEFAULT 'shared';

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_metrics_store_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_metrics_store_check
  CHECK (metrics_store ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_logs_store_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_logs_store_check
  CHECK (logs_store ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');

CREATE OR REPLACE FUNCTION tenants_store_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.metrics_store IS DISTINCT FROM OLD.metrics_store
     OR NEW.logs_store IS DISTINCT FROM OLD.logs_store THEN
    RAISE EXCEPTION 'tenant data stores cannot be changed (tenant %)', OLD.tenant_key;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_store_immutable
  ON tenants;

CREATE TRIGGER tenants_store_immutable
BEFORE UPDATE ON tenants
FOR EACH ROW
EXECUTE FUNCTION tenants_store_immutable();

COMMIT;
