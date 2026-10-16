BEGIN;

-- ---------------------------------------------------------------
-- 2026-10-16 (TODO-19): a support-access grant may give the platform
-- admin the Admin role in the tenant's Grafana org, so they can see and
-- manage that org's data sources during the grant. Tenant admins remain
-- Editor in their own org; platform admins are NOT Grafana server admins.
-- ---------------------------------------------------------------
ALTER TABLE support_access DROP CONSTRAINT IF EXISTS support_access_role_check;

ALTER TABLE support_access
  ADD CONSTRAINT support_access_role_check
  CHECK (role IN ('Viewer', 'Editor', 'Admin'));

COMMIT;
