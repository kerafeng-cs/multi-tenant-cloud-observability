BEGIN;

-- ---------------------------------------------------------------
-- 2026-10-14: platform admins belong to the platform tenant
-- (admin-tenant: Grafana org 1, VictoriaMetrics account 1, seeded by
-- 001_init.sql) instead of to no tenant. Every user now has a tenant.
-- Only the platform tenant holds platform admins: the API never creates
-- one, PlatformBootstrapService creates the initial one there.
-- Keycloak group membership and the Grafana org role follow through the
-- startup resync of control-plane.
-- ---------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_role_check;

UPDATE users
  SET tenant_id = (SELECT id FROM tenants WHERE tenant_key = 'admin-tenant')
  WHERE role = 'platform-admin' AND tenant_id IS NULL;

-- Fails loudly (and rolls back) if admin-tenant were missing.
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;

COMMIT;
