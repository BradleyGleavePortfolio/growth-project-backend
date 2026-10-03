-- B-TRIALS (OR-113-2, owner 2026-10-02 16:34 "Real free trials on packages: yes").
--
-- Additive only: new defaulted columns on CoachPackage and ClientPurchase,
-- two new tables, CHECK constraints, and RLS on the two new tables. No
-- shipped migration is altered.
-- Reverse: down.sql (drops only what this file creates).
--
-- 1. CoachPackage.trial_days — free trial length for a recurring package.
--    0 (no trial) on every existing row. CHECK: 0..30 days, and a trial only
--    on a paid recurring package (PackagesService refuses the same shapes
--    first with coded 400s; the CHECK is the last line of defence).
--    CoachPackage RLS is unchanged: its policies are row-level and cover
--    every column.
-- 2. ClientPurchase.trial_days / trial_ends_at — the trial snapshot of a
--    purchase and the Stripe trial_end mirror. ClientPurchase RLS unchanged.
-- 3. PackageTrialUsage — one free trial per client per coach. The unique
--    (client_user_id, coach_user_id) index is the race guard.
-- 4. PackageTrialNotice — the trial-ending notice ledger, unique per
--    (purchase_id, trial_ends_at) so a notice is sent once per trial end.
--
-- RLS on the two new tables (server-only writers, self-only reads):
--   * service_role: full access (Primitive A; the serving role is BYPASSRLS);
--   * SELECT for other principals: the client's own rows only
--     (client_user_id = app.current_user_id()); no coach branch, no write
--     policy for non-service principals;
--   * anon: RESTRICTIVE deny-all plus REVOKE of table privileges.

SET lock_timeout = '5s';

-- =====================================================================
-- 1) CoachPackage.trial_days
-- =====================================================================
ALTER TABLE "CoachPackage" ADD COLUMN "trial_days" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CoachPackage"
    ADD CONSTRAINT "CoachPackage_trial_days_check"
    CHECK (
        "trial_days" BETWEEN 0 AND 30
        AND (
            "trial_days" = 0
            OR (
                "billing_type" = 'recurring'
                AND "amount_cents" > 0
                AND "recurring_amount_cents" IS NULL
            )
        )
    );

-- =====================================================================
-- 2) ClientPurchase trial snapshot
-- =====================================================================
ALTER TABLE "ClientPurchase" ADD COLUMN "trial_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "trial_ends_at" TIMESTAMP(3);

ALTER TABLE "ClientPurchase"
    ADD CONSTRAINT "ClientPurchase_trial_days_check"
    CHECK ("trial_days" BETWEEN 0 AND 30);

-- =====================================================================
-- 3) PackageTrialUsage
-- =====================================================================
CREATE TABLE "PackageTrialUsage" (
    "id" TEXT NOT NULL,
    "client_user_id" TEXT NOT NULL,
    "coach_user_id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "trial_days" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reserved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "trial_ends_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageTrialUsage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PackageTrialUsage_status_check" CHECK ("status" IN ('reserved', 'started', 'released')),
    CONSTRAINT "PackageTrialUsage_trial_days_check" CHECK ("trial_days" BETWEEN 1 AND 30)
);

CREATE UNIQUE INDEX "PackageTrialUsage_purchase_id_key" ON "PackageTrialUsage"("purchase_id");
CREATE INDEX "PackageTrialUsage_coach_user_id_idx" ON "PackageTrialUsage"("coach_user_id");
CREATE INDEX "PackageTrialUsage_status_reserved_at_idx" ON "PackageTrialUsage"("status", "reserved_at");
CREATE UNIQUE INDEX "PackageTrialUsage_client_user_id_coach_user_id_key" ON "PackageTrialUsage"("client_user_id", "coach_user_id");

ALTER TABLE "PackageTrialUsage" ADD CONSTRAINT "PackageTrialUsage_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PackageTrialUsage" ADD CONSTRAINT "PackageTrialUsage_coach_user_id_fkey" FOREIGN KEY ("coach_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 4) PackageTrialNotice
-- =====================================================================
CREATE TABLE "PackageTrialNotice" (
    "id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "client_user_id" TEXT NOT NULL,
    "trial_ends_at" TIMESTAMP(3) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "push_status" TEXT NOT NULL DEFAULT 'pending',
    "push_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_status" TEXT NOT NULL DEFAULT 'pending',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageTrialNotice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PackageTrialNotice_push_status_check" CHECK ("push_status" IN ('pending', 'delivered', 'no_token', 'failed')),
    CONSTRAINT "PackageTrialNotice_email_status_check" CHECK ("email_status" IN ('pending', 'sent', 'no_email', 'failed')),
    CONSTRAINT "PackageTrialNotice_amount_check" CHECK ("amount_cents" >= 0)
);

CREATE INDEX "PackageTrialNotice_client_user_id_idx" ON "PackageTrialNotice"("client_user_id");
CREATE INDEX "PackageTrialNotice_push_status_email_status_trial_ends_at_idx" ON "PackageTrialNotice"("push_status", "email_status", "trial_ends_at");
CREATE UNIQUE INDEX "PackageTrialNotice_purchase_id_trial_ends_at_key" ON "PackageTrialNotice"("purchase_id", "trial_ends_at");

ALTER TABLE "PackageTrialNotice" ADD CONSTRAINT "PackageTrialNotice_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================================
-- 5) RLS on the two new tables
-- =====================================================================
ALTER TABLE "PackageTrialUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PackageTrialUsage" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PackageTrialUsage" FROM anon;

CREATE POLICY "p_packagetrialusage_service_role_all" ON "PackageTrialUsage"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_packagetrialusage_service_role_all" ON "PackageTrialUsage" IS
  'Primitive A: service_role access for the server-side trial reservation writer and account erasure.';

CREATE POLICY "p_packagetrialusage_select_self" ON "PackageTrialUsage"
    AS PERMISSIVE FOR SELECT TO public
    USING (app.current_user_id() IS NOT NULL AND "client_user_id" = app.current_user_id());
COMMENT ON POLICY "p_packagetrialusage_select_self" ON "PackageTrialUsage" IS
  'Self-only read: a client reads only their own trial rows. No coach branch. No INSERT/UPDATE/DELETE policy for non-service principals.';

CREATE POLICY "deny_all_anon_packagetrialusage" ON "PackageTrialUsage"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

ALTER TABLE "PackageTrialNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PackageTrialNotice" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PackageTrialNotice" FROM anon;

CREATE POLICY "p_packagetrialnotice_service_role_all" ON "PackageTrialNotice"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_packagetrialnotice_service_role_all" ON "PackageTrialNotice" IS
  'Primitive A: service_role access for the webhook notice writer, the delivery sweeper and account erasure.';

CREATE POLICY "p_packagetrialnotice_select_self" ON "PackageTrialNotice"
    AS PERMISSIVE FOR SELECT TO public
    USING (app.current_user_id() IS NOT NULL AND "client_user_id" = app.current_user_id());
COMMENT ON POLICY "p_packagetrialnotice_select_self" ON "PackageTrialNotice" IS
  'Self-only read: a client reads only their own trial notices. No write policy for non-service principals.';

CREATE POLICY "deny_all_anon_packagetrialnotice" ON "PackageTrialNotice"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

RESET lock_timeout;
