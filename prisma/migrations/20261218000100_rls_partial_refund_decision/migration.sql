-- R81 PR #401 F3 — PartialRefundDecision RLS enablement.
--
-- Additive-only migration. No destructive operations. This migration adds RLS
-- enforcement + policies to the PartialRefundDecision table created in
-- 20261214000000_named_regimes_and_partial_refund_decision; it makes NO schema
-- changes (no tables, columns, types, indexes, or constraints are
-- added/altered/removed here). The original migration is left untouched.
--
-- Posture (operator Decision 2 — coach-only, same as PR #398): the
-- PartialRefundDecision surface is coach-facing only. There is intentionally NO
-- client column and NO client SELECT policy — a buyer never sees the coach's
-- keep/unassign decision. The owning coach is derived through the parent
-- ClientPurchase (coach_user_id); the table itself carries no coach_id column,
-- mirroring the ContractAuditEvent child-via-parent pattern in
-- 20261215000200_contracts_rls.
--
-- Helper convention (PR-RLS-FN): app.is_owner(), app.current_user_id() — the
-- backend TEXT GUC ownership context. service_role bypass is Primitive A: the
-- partial-refund hook (PartialRefundDecisionService.onPartialRefund) and the
-- Stripe webhook handler write as the Supabase service_role (BYPASSRLS), and
-- the RLS suite bypasses via service_role. anon (no GUCs set) resolves to zero
-- rows.
--
-- Rollback: DROP the policies created here and, only on a confirmed P0 outage,
-- ALTER TABLE "PartialRefundDecision" DISABLE ROW LEVEL SECURITY. Otherwise fix
-- forward.

BEGIN;

ALTER TABLE "PartialRefundDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartialRefundDecision" FORCE ROW LEVEL SECURITY;

-- Primitive A — service_role bypass for the webhook-driven insert path and
-- server-side jobs/migrations. Defense-in-depth: service_role already has
-- BYPASSRLS on managed Supabase; this explicit policy guards any future
-- non-bypass connection used by the server role.
DROP POLICY IF EXISTS "p_partialrefunddecision_service_role_all" ON "PartialRefundDecision";
CREATE POLICY "p_partialrefunddecision_service_role_all" ON "PartialRefundDecision" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_partialrefunddecision_service_role_all" ON "PartialRefundDecision" IS 'Primitive A: service_role bypass for the partial-refund webhook insert path and server-side jobs/migrations.';

-- Coach SELECT — the owning coach (the coach_user_id on the parent
-- ClientPurchase = the current user) or an owner may read the decision. A
-- foreign coach is blocked through the parent predicate, so a cross-tenant
-- read resolves to zero rows (IDOR-safe). No client read.
DROP POLICY IF EXISTS "p_partialrefunddecision_select" ON "PartialRefundDecision";
CREATE POLICY "p_partialrefunddecision_select" ON "PartialRefundDecision" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "PartialRefundDecision"."client_purchase_id" AND cp."coach_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_partialrefunddecision_select" ON "PartialRefundDecision" IS 'Coach-of-purchase read: owner, or the coach who owns the parent ClientPurchase (coach_user_id = current user), may SELECT the decision. anon and foreign coaches see zero rows (cross-tenant resolves to not-found).';

-- Coach UPDATE — the owning coach (or owner) may decide (keep_drops /
-- unassign_drops). USING gates which rows are visible to update; WITH CHECK
-- pins the post-image to the same coach-of-purchase predicate so a decision
-- can never be re-pointed at another coach's purchase. INSERT/DELETE are NOT
-- granted to tenants: rows are created by the webhook path under service_role
-- (Primitive A) and are never tenant-deleted.
DROP POLICY IF EXISTS "p_partialrefunddecision_update" ON "PartialRefundDecision";
CREATE POLICY "p_partialrefunddecision_update" ON "PartialRefundDecision" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "PartialRefundDecision"."client_purchase_id" AND cp."coach_user_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "PartialRefundDecision"."client_purchase_id" AND cp."coach_user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_partialrefunddecision_update" ON "PartialRefundDecision" IS 'Coach-of-purchase decide: owner or the owning coach may UPDATE (keep_drops/unassign_drops). CHECK prevents re-pointing a decision at another coach''s purchase. INSERT/DELETE remain service_role-only (Primitive A) for the webhook insert path.';

COMMIT;
