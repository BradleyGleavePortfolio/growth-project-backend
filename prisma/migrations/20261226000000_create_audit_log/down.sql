-- Reverse of 20261226000000_create_audit_log (R82 reversibility).
--
-- Mirrors the forward migration operation-for-operation: drop policies,
-- drop indexes, drop table. The defensively-created roles (admin_role,
-- app_runtime) are intentionally NOT dropped here — they may be shared by
-- other objects in a deployed environment, and dropping a role that owns
-- or is referenced by other grants would fail. Reversing the table is
-- sufficient for R82; role lifecycle is an ops concern.

-- 1) Policies (reverse of section 3).
DROP POLICY IF EXISTS deny_all_anon_audit_log ON audit_log;
DROP POLICY IF EXISTS audit_log_service_role_read ON audit_log;
DROP POLICY IF EXISTS audit_log_service_role_write ON audit_log;
DROP POLICY IF EXISTS audit_log_admin_read ON audit_log;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;

-- 2) Indexes (reverse of section 2).
DROP INDEX IF EXISTS audit_log_resource_idx;
DROP INDEX IF EXISTS audit_log_actor_idx;
DROP INDEX IF EXISTS audit_log_tenant_created_idx;

-- 3) Table (reverse of section 1). The REVOKE grants (section 4) and RLS
--    enablement are dropped implicitly with the table.
DROP TABLE IF EXISTS audit_log;
