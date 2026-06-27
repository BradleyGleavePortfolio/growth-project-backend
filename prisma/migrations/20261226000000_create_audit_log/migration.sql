-- H6 (Wave H, lane gamma) — audit_log substrate.
--
-- Implements operator decision D-H6-1 (LOCKED 2026-06-26): the canonical
-- 13-column append-only audit_log table, with database-level REVOKE
-- UPDATE/DELETE so no runtime principal can ever mutate a row, plus RLS
-- (R125 tier 1) tenant isolation and an admin read policy.
--
-- This table is the substrate that BL-DATA-CAPTURE PR1 extends — the
-- 13-column shape is contractual and must be reused, not redesigned.
--
-- Distinct from the legacy "AuditLog" event table (created in
-- 20260427120000_add_audit_log_and_gdpr_lifecycle). That table is the
-- forensic event log (action strings + metadata). This snake_case
-- audit_log table is the structured before/after-state capture substrate.
--
-- Naming/role note: D-H6-1 names roles admin_role and app_runtime. This
-- codebase runs on Supabase roles (service_role / anon / authenticated).
-- We honor the LOCKED intent: append-only at the DB level (REVOKE
-- UPDATE/DELETE from PUBLIC and from the runtime role), tenant-isolated
-- SELECT, and an admin read path. The named roles are created defensively
-- with IF NOT EXISTS guards so the migration is portable across the local
-- shadow DB (which has no Supabase roles) and the deployed environment.
-- Additive DDL only — no shipped migration is altered.

-- =====================================================================
-- 0) Roles (defensive — D-H6-1 names admin_role + app_runtime).
--    NOLOGIN group roles; grants below reference them. On Supabase the
--    runtime principal is service_role, granted into app_runtime so the
--    REVOKE semantics apply transitively.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role') THEN
    CREATE ROLE admin_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
END
$$;

-- =====================================================================
-- 1) Table — the LOCKED 13-column shape (D-H6-1 verbatim).
-- =====================================================================
CREATE TABLE audit_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL,
  actor_id        uuid        NULL,
  actor_type      text        NOT NULL,         -- 'user' | 'coach' | 'system' | 'admin'
  action          text        NOT NULL,         -- 'create' | 'update' | 'delete' | 'read' | custom
  resource_type   text        NOT NULL,         -- 'User' | 'Coach' | 'Message' | ...
  resource_id     text        NULL,             -- string because polymorphic
  before_state    jsonb       NULL,             -- R98: no raw PII; redact via erasure-token helper
  after_state     jsonb       NULL,             -- R98: no raw PII; redact via erasure-token helper
  reason          text        NULL,             -- per D-H6-1: ship with reason text null
  request_id      text        NULL,             -- correlation id
  ip_address      inet        NULL,             -- nullable; redactable via erasure token
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2) Indexes (D-H6-1 verbatim).
-- =====================================================================
CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at DESC);
CREATE INDEX audit_log_actor_idx          ON audit_log (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_log_resource_idx       ON audit_log (resource_type, resource_id);

-- =====================================================================
-- 3) RLS — R125 tier 1. Tenant-isolated SELECT + admin read. Service-role
--    writes only; no UPDATE/DELETE policies = nobody can update/delete via
--    a policy path. RESTRICTIVE deny-all to anon/authenticated matches the
--    codebase idiom (see 20261220000020_marketplace_abuse_signal_rls).
-- =====================================================================
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Tenant isolation: a principal may read only rows for its current tenant.
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
COMMENT ON POLICY audit_log_tenant_isolation ON audit_log IS 'R125 tier 1: SELECT limited to the caller current tenant (app.tenant_id GUC).';

-- Admin read: admin_role reads across tenants for compliance review.
CREATE POLICY audit_log_admin_read ON audit_log
  FOR SELECT TO admin_role USING (true);
COMMENT ON POLICY audit_log_admin_read ON audit_log IS 'D-H6-1: admin_role may read across all tenants for compliance/forensic review.';

-- Service-role bypass (Primitive A): the server-side write path runs as
-- service_role and is the only INSERT path. No UPDATE/DELETE policy exists.
DROP POLICY IF EXISTS audit_log_service_role_write ON audit_log;
CREATE POLICY audit_log_service_role_write ON audit_log AS PERMISSIVE FOR INSERT TO service_role WITH CHECK (true);
COMMENT ON POLICY audit_log_service_role_write ON audit_log IS 'Service-role INSERT only. Append-only: no UPDATE/DELETE policy exists for any role.';

DROP POLICY IF EXISTS audit_log_service_role_read ON audit_log;
CREATE POLICY audit_log_service_role_read ON audit_log AS PERMISSIVE FOR SELECT TO service_role USING (true);
COMMENT ON POLICY audit_log_service_role_read ON audit_log IS 'Service-role read for the in-process AuditLog reader/erasure paths.';

DROP POLICY IF EXISTS deny_all_anon_audit_log ON audit_log;
CREATE POLICY deny_all_anon_audit_log ON audit_log AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY deny_all_anon_audit_log ON audit_log IS 'RESTRICTIVE deny-all: anon can never touch a row regardless of any permissive policy.';

-- =====================================================================
-- 4) DB-level append-only (D-H6-1 LOCKED). No runtime principal may
--    UPDATE or DELETE. Only the privileged retention-rotation role may
--    DELETE, and only AFTER archiving rows older than 7 years.
-- =====================================================================
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_log FROM app_runtime;
