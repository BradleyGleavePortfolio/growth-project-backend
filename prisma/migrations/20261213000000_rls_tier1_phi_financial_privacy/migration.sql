-- PR-RLS-01 — Tier 1 PHI, financial, and privacy/compliance containment
--
-- Highest-risk RLS PR in the remediation: a leaky policy here is a HIPAA-shaped
-- PHI exposure or a financial/ledger leak. This migration enables AND forces
-- Row Level Security on the 11 Tier 1 tables and installs SELECT/INSERT/UPDATE/
-- DELETE policies built ONLY from the four canonical primitives defined in
-- RLS_REMEDIATION_PLAN.md section 3:
--   * Primitive A — service_role bypass (server-side jobs / migrations).
--   * Primitive C — direct self access on a TEXT user/coach/client column.
--   * Primitive D — client self OR current coach (app.is_current_coach_of).
--   * Primitive E — child-table access through a parent row (EXISTS).
--
-- Conventions (do NOT change):
--   * Ownership context is the backend TEXT GUC app.current_user_id() — NOT
--     auth.uid(). Prisma stores application UUIDs as TEXT, so every comparison
--     stays TEXT-to-TEXT.
--   * app.is_owner() is the authenticated-owner escalation helper.
--   * app.is_current_coach_of(client) is the coach-of-client relationship check.
--   * service_role on managed Supabase has BYPASSRLS; the explicit
--     "<table>_service_role_all" policy is defense-in-depth for any future
--     non-bypassing service path and documents intent.
--   * FORCE ROW LEVEL SECURITY is set on every table so the table owner is ALSO
--     subject to these policies (defense in depth) — only true BYPASSRLS roles
--     (service_role) skip them.
--
-- SAFE TO RE-RUN: every statement is idempotent (ENABLE/FORCE are no-ops when
-- already set; DROP POLICY IF EXISTS precedes each CREATE POLICY).
--
-- Rollback: drop the policies created here and run
-- `ALTER TABLE <table> DISABLE ROW LEVEL SECURITY` ONLY on a confirmed P0
-- production outage; otherwise fix forward with a policy patch.

BEGIN;

-- Idempotent guard: the `app` schema and its helpers ship in prior migrations
-- (rls_fitness_backend + PR-RLS-FN 20261212000000). This is a no-op when they
-- already exist and keeps the policy bodies self-documenting about their deps.
CREATE SCHEMA IF NOT EXISTS app;

-- ============================================================================
-- PHI / MEDICAL (4 tables)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- BloodworkResult — PHI lab marker rows. Ownership flows through the parent
-- BloodworkPanel (panel_id -> client_id / coach_id). Child-via-parent (E).
-- SELECT/INSERT: panel client, panel coach, current coach of the panel client,
-- or owner. UPDATE/DELETE: service role only (lab records are immutable
-- client-side; corrections go through server-side jobs).
-- ---------------------------------------------------------------------------
ALTER TABLE "BloodworkResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BloodworkResult" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_bloodworkresult_service_role_all" ON "BloodworkResult";
CREATE POLICY "p_bloodworkresult_service_role_all" ON "BloodworkResult" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_bloodworkresult_service_role_all" ON "BloodworkResult" IS 'Service role bypass for server-side PHI jobs and migrations.';

DROP POLICY IF EXISTS "p_bloodworkresult_select" ON "BloodworkResult";
CREATE POLICY "p_bloodworkresult_select" ON "BloodworkResult" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkresult_select" ON "BloodworkResult" IS 'Read PHI lab markers only for the panel client, panel coach, the current coach of that client, or an owner.';

DROP POLICY IF EXISTS "p_bloodworkresult_insert" ON "BloodworkResult";
CREATE POLICY "p_bloodworkresult_insert" ON "BloodworkResult" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkResult"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkresult_insert" ON "BloodworkResult" IS 'Insert lab markers only into panels the caller owns, coaches, or is an owner of.';

DROP POLICY IF EXISTS "p_bloodworkresult_update" ON "BloodworkResult";
CREATE POLICY "p_bloodworkresult_update" ON "BloodworkResult" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_bloodworkresult_update" ON "BloodworkResult" IS 'PHI lab rows are immutable client-side; only service role / owner may amend them.';

DROP POLICY IF EXISTS "p_bloodworkresult_delete" ON "BloodworkResult";
CREATE POLICY "p_bloodworkresult_delete" ON "BloodworkResult" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_bloodworkresult_delete" ON "BloodworkResult" IS 'PHI lab rows are immutable client-side; only service role / owner may delete them.';

-- ---------------------------------------------------------------------------
-- BloodworkAttachment — PHI file pointers. Same child-via-BloodworkPanel (E)
-- ownership as BloodworkResult.
-- ---------------------------------------------------------------------------
ALTER TABLE "BloodworkAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BloodworkAttachment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_bloodworkattachment_service_role_all" ON "BloodworkAttachment";
CREATE POLICY "p_bloodworkattachment_service_role_all" ON "BloodworkAttachment" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_bloodworkattachment_service_role_all" ON "BloodworkAttachment" IS 'Service role bypass for server-side PHI attachment jobs and migrations.';

DROP POLICY IF EXISTS "p_bloodworkattachment_select" ON "BloodworkAttachment";
CREATE POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkattachment_select" ON "BloodworkAttachment" IS 'Read PHI attachment pointers only for the panel client, panel coach, the current coach of that client, or an owner.';

DROP POLICY IF EXISTS "p_bloodworkattachment_insert" ON "BloodworkAttachment";
CREATE POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BloodworkPanel" bp WHERE bp."id" = "BloodworkAttachment"."panel_id" AND (bp."client_id" = app.current_user_id() OR bp."coach_id" = app.current_user_id() OR app.is_current_coach_of(bp."client_id"))))));
COMMENT ON POLICY "p_bloodworkattachment_insert" ON "BloodworkAttachment" IS 'Insert attachment pointers only into panels the caller owns, coaches, or is an owner of.';

DROP POLICY IF EXISTS "p_bloodworkattachment_update" ON "BloodworkAttachment";
CREATE POLICY "p_bloodworkattachment_update" ON "BloodworkAttachment" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_bloodworkattachment_update" ON "BloodworkAttachment" IS 'PHI attachment metadata (scan state) is server-managed; only service role / owner may amend it.';

DROP POLICY IF EXISTS "p_bloodworkattachment_delete" ON "BloodworkAttachment";
CREATE POLICY "p_bloodworkattachment_delete" ON "BloodworkAttachment" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_bloodworkattachment_delete" ON "BloodworkAttachment" IS 'PHI attachment pointers are server-managed; only service role / owner may delete them.';

-- ---------------------------------------------------------------------------
-- DiagnosticSubmission — medical intake / diagnostic questionnaire. user_id is
-- nullable (anonymous lead funnel). Self access on user_id (C) with an
-- anonymous-INSERT carve-out so the public lead funnel can submit (user_id NULL).
-- UPDATE/DELETE: service role only (intake is immutable once captured).
-- ---------------------------------------------------------------------------
ALTER TABLE "DiagnosticSubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiagnosticSubmission" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_diagnosticsubmission_service_role_all" ON "DiagnosticSubmission";
CREATE POLICY "p_diagnosticsubmission_service_role_all" ON "DiagnosticSubmission" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_diagnosticsubmission_service_role_all" ON "DiagnosticSubmission" IS 'Service role bypass for server-side diagnostic scoring and migrations.';

DROP POLICY IF EXISTS "p_diagnosticsubmission_select" ON "DiagnosticSubmission";
CREATE POLICY "p_diagnosticsubmission_select" ON "DiagnosticSubmission" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_diagnosticsubmission_select" ON "DiagnosticSubmission" IS 'Read diagnostic intake only as the attributed user or an owner; anonymous rows (user_id NULL) are not readable by the public role.';

DROP POLICY IF EXISTS "p_diagnosticsubmission_insert" ON "DiagnosticSubmission";
CREATE POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR "user_id" IS NULL OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_diagnosticsubmission_insert" ON "DiagnosticSubmission" IS 'Allow anonymous lead-funnel intake (user_id NULL) plus self-attributed and owner inserts.';

DROP POLICY IF EXISTS "p_diagnosticsubmission_update" ON "DiagnosticSubmission";
CREATE POLICY "p_diagnosticsubmission_update" ON "DiagnosticSubmission" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_diagnosticsubmission_update" ON "DiagnosticSubmission" IS 'UPDATE restricted to the owner escalation role (app.is_owner()). The two production lifecycle paths run as the Supabase service_role (BYPASSRLS): anonymous-row attach in DiagnosticService.attachUser() (src/diagnostic/diagnostic.service.ts:190-195) and user_id nullification during account deletion (src/account-deletion/account-deletion.service.ts:646-648). This policy is the defense-in-depth path for any non-bypass connection and intentionally denies tenant-side mutation, including a tenant attaching themselves to a user_id-NULL row.';

DROP POLICY IF EXISTS "p_diagnosticsubmission_delete" ON "DiagnosticSubmission";
CREATE POLICY "p_diagnosticsubmission_delete" ON "DiagnosticSubmission" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_diagnosticsubmission_delete" ON "DiagnosticSubmission" IS 'Diagnostic intake is retained for funnel attribution; only service role / owner may delete it.';

-- ---------------------------------------------------------------------------
-- ClientCoachConsent — legal consent records. Both parties (client_id,
-- coach_id) plus current-coach-of-client may read. Client-self-or-coach (D).
-- INSERT: either party (a client grants / a coach records). UPDATE/DELETE:
-- service role only (consent lifecycle transitions are server-controlled).
-- ---------------------------------------------------------------------------
ALTER TABLE "ClientCoachConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientCoachConsent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_clientcoachconsent_service_role_all" ON "ClientCoachConsent";
CREATE POLICY "p_clientcoachconsent_service_role_all" ON "ClientCoachConsent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_clientcoachconsent_service_role_all" ON "ClientCoachConsent" IS 'Service role bypass for server-side consent lifecycle jobs and migrations.';

DROP POLICY IF EXISTS "p_clientcoachconsent_select" ON "ClientCoachConsent";
CREATE POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_clientcoachconsent_select" ON "ClientCoachConsent" IS 'Read consent rows only as the consenting client, the named coach, the current coach of that client, or an owner.';

DROP POLICY IF EXISTS "p_clientcoachconsent_insert" ON "ClientCoachConsent";
CREATE POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("client_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_clientcoachconsent_insert" ON "ClientCoachConsent" IS 'A client may record their own consent and a coach may record consent for their client; owner is also allowed.';

DROP POLICY IF EXISTS "p_clientcoachconsent_update" ON "ClientCoachConsent";
CREATE POLICY "p_clientcoachconsent_update" ON "ClientCoachConsent" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_clientcoachconsent_update" ON "ClientCoachConsent" IS 'UPDATE restricted to the owner escalation role (app.is_owner()). Consent lifecycle transitions (grant re-issue, revoke) flow through the backend ConsentService (src/consent/consent.service.ts:171-253: upsert/re-grant at :171-190, revoke at :250-253) which runs as the Supabase service_role (BYPASSRLS); this policy is the defense-in-depth path for any non-bypass connection and intentionally denies tenant-side mutation.';

DROP POLICY IF EXISTS "p_clientcoachconsent_delete" ON "ClientCoachConsent";
CREATE POLICY "p_clientcoachconsent_delete" ON "ClientCoachConsent" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_clientcoachconsent_delete" ON "ClientCoachConsent" IS 'DELETE restricted to the owner escalation role (app.is_owner()). Consent records are legal evidence; account-deletion cleanup (src/account-deletion/account-deletion.service.ts:816-819 clientCoachConsent.deleteMany) runs as the Supabase service_role (BYPASSRLS). This policy is the defense-in-depth path for any non-bypass connection and intentionally denies tenant-side deletion.';

-- ============================================================================
-- FINANCIAL / STRIPE (5 tables)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ChargeDispute — Stripe dispute mirror. Read flows through the parent
-- ClientPurchase (purchase_id -> client_user_id / coach_user_id): both parties
-- to the purchase may read (E). Writes are service-role only (the dispute
-- lifecycle is driven entirely by Stripe webhooks). is_owner() retained as the
-- only non-service write escalation.
-- ---------------------------------------------------------------------------
ALTER TABLE "ChargeDispute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChargeDispute" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_chargedispute_service_role_all" ON "ChargeDispute";
CREATE POLICY "p_chargedispute_service_role_all" ON "ChargeDispute" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_chargedispute_service_role_all" ON "ChargeDispute" IS 'Service role bypass: Stripe dispute rows are written exclusively by webhook handlers.';

DROP POLICY IF EXISTS "p_chargedispute_select" ON "ChargeDispute";
CREATE POLICY "p_chargedispute_select" ON "ChargeDispute" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeDispute"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargedispute_select" ON "ChargeDispute" IS 'Read a dispute only as a party (client or coach) to the underlying purchase, or as an owner.';

DROP POLICY IF EXISTS "p_chargedispute_insert" ON "ChargeDispute";
CREATE POLICY "p_chargedispute_insert" ON "ChargeDispute" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_chargedispute_insert" ON "ChargeDispute" IS 'Dispute rows originate from Stripe webhooks (service role); only owner may insert otherwise.';

DROP POLICY IF EXISTS "p_chargedispute_update" ON "ChargeDispute";
CREATE POLICY "p_chargedispute_update" ON "ChargeDispute" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_chargedispute_update" ON "ChargeDispute" IS 'Dispute state transitions are webhook-driven (service role); only owner may update otherwise.';

DROP POLICY IF EXISTS "p_chargedispute_delete" ON "ChargeDispute";
CREATE POLICY "p_chargedispute_delete" ON "ChargeDispute" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_chargedispute_delete" ON "ChargeDispute" IS 'Financial dispute records are retained; only service role / owner may delete them.';

-- ---------------------------------------------------------------------------
-- ChargeRefund — Stripe refund mirror. Read flows through the parent
-- ClientPurchase (E): both purchase parties may read. Per the plan's
-- purchase-party-read-coach-insert primitive, a purchase party (client or
-- coach) may also write so the coach can initiate a refund; service role
-- covers webhook-driven rows.
-- ---------------------------------------------------------------------------
ALTER TABLE "ChargeRefund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChargeRefund" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_chargerefund_service_role_all" ON "ChargeRefund";
CREATE POLICY "p_chargerefund_service_role_all" ON "ChargeRefund" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_chargerefund_service_role_all" ON "ChargeRefund" IS 'Service role bypass: refund rows are written by webhook handlers and admin tooling.';

DROP POLICY IF EXISTS "p_chargerefund_select" ON "ChargeRefund";
CREATE POLICY "p_chargerefund_select" ON "ChargeRefund" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_select" ON "ChargeRefund" IS 'Read a refund only as a party (client or coach) to the underlying purchase, or as an owner.';

DROP POLICY IF EXISTS "p_chargerefund_insert" ON "ChargeRefund";
CREATE POLICY "p_chargerefund_insert" ON "ChargeRefund" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_insert" ON "ChargeRefund" IS 'A party to the purchase (coach-initiated refund) or an owner may record a refund; service role covers webhook rows.';

DROP POLICY IF EXISTS "p_chargerefund_update" ON "ChargeRefund";
CREATE POLICY "p_chargerefund_update" ON "ChargeRefund" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id()))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_update" ON "ChargeRefund" IS 'A party to the purchase or an owner may amend a refund row; service role covers webhook updates.';

DROP POLICY IF EXISTS "p_chargerefund_delete" ON "ChargeRefund";
CREATE POLICY "p_chargerefund_delete" ON "ChargeRefund" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ChargeRefund"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_chargerefund_delete" ON "ChargeRefund" IS 'Only a party to the purchase, an owner, or service role may delete a refund record.';

-- ---------------------------------------------------------------------------
-- StripeProcessedEvent — webhook idempotency ledger. No ownership column; this
-- is pure service-role-only state used for idempotency. service-role-only (A)
-- plus owner escalation; public never reads webhook event IDs.
-- ---------------------------------------------------------------------------
ALTER TABLE "StripeProcessedEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeProcessedEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_stripeprocessedevent_service_role_all" ON "StripeProcessedEvent";
CREATE POLICY "p_stripeprocessedevent_service_role_all" ON "StripeProcessedEvent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_stripeprocessedevent_service_role_all" ON "StripeProcessedEvent" IS 'Service role bypass: the webhook idempotency ledger is written and read only by webhook handlers.';

DROP POLICY IF EXISTS "p_stripeprocessedevent_select" ON "StripeProcessedEvent";
CREATE POLICY "p_stripeprocessedevent_select" ON "StripeProcessedEvent" AS PERMISSIVE FOR SELECT TO public USING (app.is_owner());
COMMENT ON POLICY "p_stripeprocessedevent_select" ON "StripeProcessedEvent" IS 'Webhook event IDs are not tenant data; only service role / owner may read them.';

DROP POLICY IF EXISTS "p_stripeprocessedevent_insert" ON "StripeProcessedEvent";
CREATE POLICY "p_stripeprocessedevent_insert" ON "StripeProcessedEvent" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_stripeprocessedevent_insert" ON "StripeProcessedEvent" IS 'Idempotency ledger rows are written by webhook handlers (service role); only owner may insert otherwise.';

DROP POLICY IF EXISTS "p_stripeprocessedevent_update" ON "StripeProcessedEvent";
CREATE POLICY "p_stripeprocessedevent_update" ON "StripeProcessedEvent" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_stripeprocessedevent_update" ON "StripeProcessedEvent" IS 'Idempotency ledger rows are service-managed; only service role / owner may update them.';

DROP POLICY IF EXISTS "p_stripeprocessedevent_delete" ON "StripeProcessedEvent";
CREATE POLICY "p_stripeprocessedevent_delete" ON "StripeProcessedEvent" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_stripeprocessedevent_delete" ON "StripeProcessedEvent" IS 'Idempotency ledger rows are service-managed; only service role / owner may delete them.';

-- ---------------------------------------------------------------------------
-- PayoutSnapshot — coach payout/balance state. Direct self access on
-- coach_user_id (C): a coach reads their own payout snapshot. Writes are
-- service-role / owner only (snapshots are minted from Stripe balance pulls).
-- ---------------------------------------------------------------------------
ALTER TABLE "PayoutSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutSnapshot" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_payoutsnapshot_service_role_all" ON "PayoutSnapshot";
CREATE POLICY "p_payoutsnapshot_service_role_all" ON "PayoutSnapshot" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_payoutsnapshot_service_role_all" ON "PayoutSnapshot" IS 'Service role bypass: payout snapshots are minted from server-side Stripe balance pulls.';

DROP POLICY IF EXISTS "p_payoutsnapshot_select" ON "PayoutSnapshot";
CREATE POLICY "p_payoutsnapshot_select" ON "PayoutSnapshot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_user_id" = app.current_user_id())));
COMMENT ON POLICY "p_payoutsnapshot_select" ON "PayoutSnapshot" IS 'A coach reads only their own payout/balance snapshot; owner may read any.';

DROP POLICY IF EXISTS "p_payoutsnapshot_insert" ON "PayoutSnapshot";
CREATE POLICY "p_payoutsnapshot_insert" ON "PayoutSnapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_payoutsnapshot_insert" ON "PayoutSnapshot" IS 'Payout snapshots are server-minted (service role); only owner may insert otherwise.';

DROP POLICY IF EXISTS "p_payoutsnapshot_update" ON "PayoutSnapshot";
CREATE POLICY "p_payoutsnapshot_update" ON "PayoutSnapshot" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_payoutsnapshot_update" ON "PayoutSnapshot" IS 'Payout snapshots are server-refreshed; only service role / owner may update them.';

DROP POLICY IF EXISTS "p_payoutsnapshot_delete" ON "PayoutSnapshot";
CREATE POLICY "p_payoutsnapshot_delete" ON "PayoutSnapshot" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_payoutsnapshot_delete" ON "PayoutSnapshot" IS 'Payout snapshots are server-managed; only service role / owner may delete them.';

-- ---------------------------------------------------------------------------
-- ReconciliationSnapshot — per-purchase ledger reconciliation. Read flows
-- through the parent ClientPurchase (E): both purchase parties may read.
-- Writes are service-role / owner only (snapshots are produced by the
-- reconciliation sweeper).
-- ---------------------------------------------------------------------------
ALTER TABLE "ReconciliationSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationSnapshot" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_reconciliationsnapshot_service_role_all" ON "ReconciliationSnapshot";
CREATE POLICY "p_reconciliationsnapshot_service_role_all" ON "ReconciliationSnapshot" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_reconciliationsnapshot_service_role_all" ON "ReconciliationSnapshot" IS 'Service role bypass: reconciliation snapshots are produced by the server-side reconciliation sweeper.';

DROP POLICY IF EXISTS "p_reconciliationsnapshot_select" ON "ReconciliationSnapshot";
CREATE POLICY "p_reconciliationsnapshot_select" ON "ReconciliationSnapshot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientPurchase" cp WHERE cp."id" = "ReconciliationSnapshot"."purchase_id" AND (cp."client_user_id" = app.current_user_id() OR cp."coach_user_id" = app.current_user_id())))));
COMMENT ON POLICY "p_reconciliationsnapshot_select" ON "ReconciliationSnapshot" IS 'Read a reconciliation snapshot only as a party (client or coach) to the underlying purchase, or as an owner.';

DROP POLICY IF EXISTS "p_reconciliationsnapshot_insert" ON "ReconciliationSnapshot";
CREATE POLICY "p_reconciliationsnapshot_insert" ON "ReconciliationSnapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_reconciliationsnapshot_insert" ON "ReconciliationSnapshot" IS 'Reconciliation snapshots are server-produced (service role); only owner may insert otherwise.';

DROP POLICY IF EXISTS "p_reconciliationsnapshot_update" ON "ReconciliationSnapshot";
CREATE POLICY "p_reconciliationsnapshot_update" ON "ReconciliationSnapshot" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_reconciliationsnapshot_update" ON "ReconciliationSnapshot" IS 'Reconciliation snapshots are server-managed; only service role / owner may update them.';

DROP POLICY IF EXISTS "p_reconciliationsnapshot_delete" ON "ReconciliationSnapshot";
CREATE POLICY "p_reconciliationsnapshot_delete" ON "ReconciliationSnapshot" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_reconciliationsnapshot_delete" ON "ReconciliationSnapshot" IS 'Reconciliation snapshots are server-managed; only service role / owner may delete them.';

-- ============================================================================
-- PRIVACY / COMPLIANCE (2 tables)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- data_export_request (Prisma model DataExportRequest, @@map) — GDPR export
-- artifact. Direct self access on user_id (C): the requesting user reads/creates
-- their own export. UPDATE/DELETE: service role / owner only (status lifecycle
-- and signed-URL minting are server-driven). NOTE: a prior migration already
-- enabled RLS on this table under its mapped physical name "data_export_request";
-- re-asserting ENABLE/FORCE here is idempotent.
-- ---------------------------------------------------------------------------
ALTER TABLE "data_export_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_export_request" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_data_export_request_service_role_all" ON "data_export_request";
CREATE POLICY "p_data_export_request_service_role_all" ON "data_export_request" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_data_export_request_service_role_all" ON "data_export_request" IS 'Service role bypass for the GDPR export worker that runs and expires export jobs.';

DROP POLICY IF EXISTS "p_data_export_request_select" ON "data_export_request";
CREATE POLICY "p_data_export_request_select" ON "data_export_request" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_data_export_request_select" ON "data_export_request" IS 'A user polls only their own GDPR export status (and signed URL); owner may read any.';

DROP POLICY IF EXISTS "p_data_export_request_insert" ON "data_export_request";
CREATE POLICY "p_data_export_request_insert" ON "data_export_request" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_data_export_request_insert" ON "data_export_request" IS 'A user may request an export only for themselves; owner may request on behalf.';

DROP POLICY IF EXISTS "p_data_export_request_update" ON "data_export_request";
CREATE POLICY "p_data_export_request_update" ON "data_export_request" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_data_export_request_update" ON "data_export_request" IS 'Export status transitions and signed-URL minting are server-driven; only service role / owner may update.';

DROP POLICY IF EXISTS "p_data_export_request_delete" ON "data_export_request";
CREATE POLICY "p_data_export_request_delete" ON "data_export_request" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_data_export_request_delete" ON "data_export_request" IS 'DELETE restricted to the owner escalation role (app.is_owner()). Export artifacts are expired by the nightly cron and purged during account deletion (src/account-deletion/account-deletion.service.ts:816-819 dataExportRequest.deleteMany), both running as the Supabase service_role (BYPASSRLS). This policy is the defense-in-depth path for any non-bypass connection and intentionally denies tenant-side deletion.';

-- ---------------------------------------------------------------------------
-- deletion_audit — GDPR deletion-lifecycle audit trail (raw-SQL table, no
-- Prisma model). user_id is the subject; actor_id is the (nullable) initiator.
-- SELECT: the subject user OR the actor may read their own audit lines (privacy
-- evidence), plus owner. INSERT/UPDATE/DELETE: service role / owner only — audit
-- rows are append-only system events and must never be forged or mutated by a
-- tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "deletion_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deletion_audit" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_deletion_audit_service_role_all" ON "deletion_audit";
CREATE POLICY "p_deletion_audit_service_role_all" ON "deletion_audit" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_deletion_audit_service_role_all" ON "deletion_audit" IS 'Service role bypass: deletion-lifecycle audit lines are written by the deletion worker and cron.';

DROP POLICY IF EXISTS "p_deletion_audit_select" ON "deletion_audit";
CREATE POLICY "p_deletion_audit_select" ON "deletion_audit" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR "actor_id" = app.current_user_id()))));
COMMENT ON POLICY "p_deletion_audit_select" ON "deletion_audit" IS 'Read deletion-audit lines only as the subject user, the acting user, or an owner (privacy evidence).';

DROP POLICY IF EXISTS "p_deletion_audit_insert" ON "deletion_audit";
CREATE POLICY "p_deletion_audit_insert" ON "deletion_audit" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_deletion_audit_insert" ON "deletion_audit" IS 'Audit lines are append-only system events written by the deletion worker (service role); only owner may insert otherwise.';

DROP POLICY IF EXISTS "p_deletion_audit_update" ON "deletion_audit";
CREATE POLICY "p_deletion_audit_update" ON "deletion_audit" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_deletion_audit_update" ON "deletion_audit" IS 'Audit lines are immutable evidence; only service role / owner may amend them.';

DROP POLICY IF EXISTS "p_deletion_audit_delete" ON "deletion_audit";
CREATE POLICY "p_deletion_audit_delete" ON "deletion_audit" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_deletion_audit_delete" ON "deletion_audit" IS 'Audit lines are immutable evidence; only service role / owner may delete them.';

COMMIT;
