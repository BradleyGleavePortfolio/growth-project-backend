-- B5 — Digital Contracts RLS enablement (HECTACORN security gate).
--
-- Additive-only migration. No destructive operations performed. This migration
-- adds RLS enforcement + policies to the three B5 contract tables created in
-- 20261215000000_b5_digital_contracts; it makes NO schema changes (no tables,
-- columns, types, indexes, or constraints are added/altered/removed here).
--
-- Tables (verified against the B5 schema migration):
--   ContractTemplate    -> coach-self owner (coach_id) + platform-template read
--                          (is_platform = true readable by any authenticated).
--   ContractEnvelope     -> coach owner (coach_id) full; client (client_id)
--                          SELECT own; head coach SELECT on envelopes whose
--                          owning coach is a non-archived sub-coach in their
--                          team (TeamSubCoachAssignment).
--   ContractAuditEvent   -> owner-of-envelope SELECT only; writes are
--                          service_role / owner only (the webhook handler runs
--                          as service_role; tests bypass via service_role).
--
-- Helper convention (PR-RLS-FN): app.is_owner(), app.current_user_id(). The
-- sub-coach scope reuses the same TeamSubCoachAssignment predicate the Tier-2
-- coach-team policies use (non-archived assignment, head_coach_id = caller).
-- service_role bypass is Primitive A. anon (no GUCs) resolves to zero rows.
--
-- Rollback: DROP the policies created here and, only on a confirmed P0 outage,
-- ALTER TABLE <t> DISABLE ROW LEVEL SECURITY. Otherwise fix forward.

BEGIN;

-- =====================================================================
-- 1) ContractTemplate — coach-self owner (coach_id) + platform-template read.
-- =====================================================================
ALTER TABLE "ContractTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContractTemplate" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_contracttemplate_service_role_all" ON "ContractTemplate";
CREATE POLICY "p_contracttemplate_service_role_all" ON "ContractTemplate" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_contracttemplate_service_role_all" ON "ContractTemplate" IS 'Primitive A: service_role bypass for server-side jobs/migrations/seeds.';

DROP POLICY IF EXISTS "p_contracttemplate_select" ON "ContractTemplate";
CREATE POLICY "p_contracttemplate_select" ON "ContractTemplate" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "is_platform" = true))));
COMMENT ON POLICY "p_contracttemplate_select" ON "ContractTemplate" IS 'Owner-coach reads own templates; any authenticated user may read platform/system templates (is_platform = true). anon (NULL current_user_id) sees zero.';

DROP POLICY IF EXISTS "p_contracttemplate_insert" ON "ContractTemplate";
CREATE POLICY "p_contracttemplate_insert" ON "ContractTemplate" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contracttemplate_insert" ON "ContractTemplate" IS 'Owner-coach write: a coach may INSERT only templates they own (coach_id = self). Platform templates are seeded via service_role.';

DROP POLICY IF EXISTS "p_contracttemplate_update" ON "ContractTemplate";
CREATE POLICY "p_contracttemplate_update" ON "ContractTemplate" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contracttemplate_update" ON "ContractTemplate" IS 'Owner-coach update: only owner or the row''s coach_id may UPDATE; CHECK prevents re-owning to another coach_id.';

-- =====================================================================
-- 2) ContractEnvelope — coach owner full; client SELECT own; head-coach
--    SELECT on sub-coach-owned envelopes (TeamSubCoachAssignment).
-- =====================================================================
ALTER TABLE "ContractEnvelope" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContractEnvelope" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_contractenvelope_service_role_all" ON "ContractEnvelope";
CREATE POLICY "p_contractenvelope_service_role_all" ON "ContractEnvelope" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_contractenvelope_service_role_all" ON "ContractEnvelope" IS 'Primitive A: service_role bypass for the webhook handler + server-side jobs.';

DROP POLICY IF EXISTS "p_contractenvelope_select" ON "ContractEnvelope";
CREATE POLICY "p_contractenvelope_select" ON "ContractEnvelope" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR EXISTS (SELECT 1 FROM public."TeamSubCoachAssignment" tsca WHERE tsca."sub_coach_id" = "ContractEnvelope"."coach_id" AND tsca."head_coach_id" = app.current_user_id() AND tsca."archived_at" IS NULL)))));
COMMENT ON POLICY "p_contractenvelope_select" ON "ContractEnvelope" IS 'Read: owner-coach (coach_id), the signing client (client_id), or the head coach of the owning sub-coach (non-archived TeamSubCoachAssignment) may SELECT. anon sees zero. Cross-coach reads are denied (IDOR).';

DROP POLICY IF EXISTS "p_contractenvelope_insert" ON "ContractEnvelope";
CREATE POLICY "p_contractenvelope_insert" ON "ContractEnvelope" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contractenvelope_insert" ON "ContractEnvelope" IS 'Write: only owner or the owning coach (coach_id = self) may INSERT an envelope. Clients never create envelopes directly; sub-coaches get SELECT only.';

DROP POLICY IF EXISTS "p_contractenvelope_update" ON "ContractEnvelope";
CREATE POLICY "p_contractenvelope_update" ON "ContractEnvelope" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_contractenvelope_update" ON "ContractEnvelope" IS 'Update: owner or owning coach (coach_id) may UPDATE; CHECK prevents re-owning to another coach_id. Status advances from provider events run as service_role.';

-- =====================================================================
-- 3) ContractAuditEvent — owner-of-envelope SELECT only; writes restricted to
--    service_role / owner (webhook handler runs as service_role).
-- =====================================================================
ALTER TABLE "ContractAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContractAuditEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_contractauditevent_service_role_all" ON "ContractAuditEvent";
CREATE POLICY "p_contractauditevent_service_role_all" ON "ContractAuditEvent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_contractauditevent_service_role_all" ON "ContractAuditEvent" IS 'Primitive A: service_role bypass. Audit rows are written by the webhook handler / server jobs running as service_role (the SECURITY DEFINER write path).';

DROP POLICY IF EXISTS "p_contractauditevent_select" ON "ContractAuditEvent";
CREATE POLICY "p_contractauditevent_select" ON "ContractAuditEvent" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ContractEnvelope" ce WHERE ce."id" = "ContractAuditEvent"."envelope_id" AND (ce."coach_id" = app.current_user_id() OR ce."client_id" = app.current_user_id())))));
COMMENT ON POLICY "p_contractauditevent_select" ON "ContractAuditEvent" IS 'Owner-of-envelope read: owner, or the owning coach/signing client of the parent ContractEnvelope, may SELECT its audit events. anon sees zero. Foreign principals are blocked through the parent predicate (IDOR).';

DROP POLICY IF EXISTS "p_contractauditevent_insert" ON "ContractAuditEvent";
CREATE POLICY "p_contractauditevent_insert" ON "ContractAuditEvent" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_contractauditevent_insert" ON "ContractAuditEvent" IS 'Write-restricted: only owner (or service_role via Primitive A) may INSERT audit rows. Normal authenticated principals (coach/client/sub-coach/anon) cannot forge audit-trail entries; the webhook handler inserts as service_role.';

COMMIT;
