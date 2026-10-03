-- B-TRIALS-3 (agent 115) — free-trial truth and durable trial side effects.
-- Follows 20270228000000_package_free_trials (same PR, #656). Additive only:
-- one nullable column + one index on ClientPurchase, new nullable/defaulted
-- columns on PackageTrialNotice, one new server-only table. No shipped
-- migration is altered. Reverse: down.sql (drops only what this file adds).
--
-- 1. ClientPurchase.card_on_file — does the Stripe subscription itself hold a
--    payment method (default_payment_method or default_source), as of the
--    latest subscription event. NULL = never observed (every row before this
--    migration, and every non-subscription purchase). Read together with the
--    customer default (ConnectCustomer.default_payment_method_id) it decides
--    whether the trial end will really charge a card (B-656-5): a client who
--    removes the card mid-trial keeps the trial they started, is told
--    truthfully that nothing will be charged, and still gets the notice.
--    Index (status, trial_ends_at) serves the notice reconciler, which looks
--    for started trials ending within three days that have no notice yet.
-- 2. PackageTrialNotice:
--    * source / nullable stripe_event_id — a notice is now also recorded when
--      the trial starts inside the warning window ('trial_start') or by the
--      reconciler ('sweep'), not only by customer.subscription.trial_will_end
--      (B-656-3: a one-day trial's only trial_will_end event can arrive
--      before the card is saved).
--    * per-channel lease (token + expiry) — exclusive delivery claim and
--      fenced completion (B-656-2).
--    * push_status 'suppressed' — the client muted notifications (B-656-4).
-- 3. PackageTrialConflict — durable obligation to cancel a subscription that
--    tried to start a second free trial with the same coach (B-656-1). Written
--    in the webhook transaction, settled after commit and by a sweep until
--    Stripe confirms the cancel. alerted_at is the receipt of the "cancel
--    still failing" alert; billed_alerted_at the separate receipt of the
--    "billed before cancel" alert (one never suppresses the other). Holds no
--    user id (purchase + subscription
--    ids only), so it needs no erasure-manifest entry; it is server-only:
--    service_role all, anon restrictive deny + REVOKE, no other policy.

SET lock_timeout = '5s';

-- =====================================================================
-- 1) ClientPurchase.card_on_file
-- =====================================================================
ALTER TABLE "ClientPurchase" ADD COLUMN "card_on_file" BOOLEAN;
CREATE INDEX "ClientPurchase_status_trial_ends_at_idx" ON "ClientPurchase"("status", "trial_ends_at");

-- =====================================================================
-- 2) PackageTrialNotice: source, leases, suppressed
-- =====================================================================
ALTER TABLE "PackageTrialNotice" ALTER COLUMN "stripe_event_id" DROP NOT NULL;
ALTER TABLE "PackageTrialNotice" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'trial_will_end';
ALTER TABLE "PackageTrialNotice" ADD COLUMN "push_lease_token" TEXT;
ALTER TABLE "PackageTrialNotice" ADD COLUMN "push_lease_until" TIMESTAMP(3);
ALTER TABLE "PackageTrialNotice" ADD COLUMN "email_lease_token" TEXT;
ALTER TABLE "PackageTrialNotice" ADD COLUMN "email_lease_until" TIMESTAMP(3);

ALTER TABLE "PackageTrialNotice"
    ADD CONSTRAINT "PackageTrialNotice_source_check"
    CHECK ("source" IN ('trial_will_end', 'trial_start', 'sweep'));

ALTER TABLE "PackageTrialNotice" DROP CONSTRAINT "PackageTrialNotice_push_status_check";
ALTER TABLE "PackageTrialNotice"
    ADD CONSTRAINT "PackageTrialNotice_push_status_check"
    CHECK ("push_status" IN ('pending', 'delivered', 'no_token', 'suppressed', 'failed'));

-- =====================================================================
-- 3) PackageTrialConflict
-- =====================================================================
CREATE TABLE "PackageTrialConflict" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'owed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "last_error" TEXT,
    "alerted_at" TIMESTAMP(3),
    "billed_alerted_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageTrialConflict_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PackageTrialConflict_status_check" CHECK ("status" IN ('owed', 'cancelled', 'superseded')),
    CONSTRAINT "PackageTrialConflict_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "PackageTrialConflict_purchase_id_key" ON "PackageTrialConflict"("purchase_id");
CREATE INDEX "PackageTrialConflict_stripe_subscription_id_idx" ON "PackageTrialConflict"("stripe_subscription_id");
CREATE INDEX "PackageTrialConflict_status_next_attempt_at_idx" ON "PackageTrialConflict"("status", "next_attempt_at");

ALTER TABLE "PackageTrialConflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PackageTrialConflict" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PackageTrialConflict" FROM anon;

CREATE POLICY "p_packagetrialconflict_service_role_all" ON "PackageTrialConflict"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_packagetrialconflict_service_role_all" ON "PackageTrialConflict" IS
  'Primitive A: service_role access for the webhook writer and the cancellation sweep. Server-only: no policy for any other principal.';

CREATE POLICY "deny_all_anon_packagetrialconflict" ON "PackageTrialConflict"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

RESET lock_timeout;
