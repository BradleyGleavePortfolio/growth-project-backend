-- TM-14 — event-driven Stripe Connect `account.updated` ledger for the talent
-- marketplace (fixes P1-7: replaces polling with a webhook for the
-- onboarding-completed signal).
--
-- `stripe_event_id` is the PRIMARY KEY and the idempotency anchor: a redelivered
-- account.updated loses the unique-PK insert race and is processed exactly once
-- (mirrors StripeProcessedEvent). `onboarding_completed` persists the
-- event-driven completion state derived from the account payload via the TM-10
-- adapter mapping (charges_enabled && payouts_enabled).
--
-- Dated AFTER main's latest migration 20261220000020_marketplace_abuse_signal_rls.
-- Additive-only; touches no existing table, column, type, policy, or migration.
--
-- RLS: RESTRICTIVE deny-all (anon + authenticated) + service_role-only, the same
-- posture as MarketplaceMutationIdempotency / MarketplaceAbuseSignal. The webhook
-- handler runs as service_role; no client principal may ever read/write this
-- ledger.
--
-- NO RAW PAYLOAD COLUMN BY DESIGN: this ledger deliberately stores only the
-- derived `onboarding_completed` signal + minimal identifiers, never the raw
-- Stripe Account blob (which carries KYC/banking PII + secrets). Stripe is the
-- system of record for the full event body, re-fetchable by `stripe_event_id`.
-- Rationale + options considered: docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md
-- =====================================================================

BEGIN;

CREATE TABLE "MarketplaceConnectEvent" (
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stripe_account_id" TEXT NOT NULL,
    "coach_user_id" TEXT,
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceConnectEvent_pkey" PRIMARY KEY ("stripe_event_id")
);

CREATE INDEX "MarketplaceConnectEvent_stripe_account_id_idx" ON "MarketplaceConnectEvent"("stripe_account_id");
CREATE INDEX "MarketplaceConnectEvent_coach_user_id_idx" ON "MarketplaceConnectEvent"("coach_user_id");

-- RESTRICTIVE deny-all + service_role bypass (RLS floor). Mirrors
-- 20261220000020_marketplace_abuse_signal_rls.
ALTER TABLE "MarketplaceConnectEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketplaceConnectEvent" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_marketplace_connect_event_service_role_all" ON "MarketplaceConnectEvent";
CREATE POLICY "p_marketplace_connect_event_service_role_all" ON "MarketplaceConnectEvent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_marketplace_connect_event_service_role_all" ON "MarketplaceConnectEvent" IS 'Primitive A: service_role bypass. The Connect-event ledger is written/read only by the server-side TM-14 webhook handler running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_marketplace_connect_event" ON "MarketplaceConnectEvent";
CREATE POLICY "deny_all_anon_marketplace_connect_event" ON "MarketplaceConnectEvent" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_marketplace_connect_event" ON "MarketplaceConnectEvent" IS 'RESTRICTIVE deny-all: anon can never read/write the Connect-event ledger regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_marketplace_connect_event" ON "MarketplaceConnectEvent";
CREATE POLICY "deny_all_authenticated_marketplace_connect_event" ON "MarketplaceConnectEvent" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_marketplace_connect_event" ON "MarketplaceConnectEvent" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the Connect-event ledger; only service_role (Primitive A) may.';

COMMIT;
