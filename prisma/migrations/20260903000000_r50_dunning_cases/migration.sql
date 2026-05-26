-- r50 Dunning v1 — failed-payment recovery state machine.
--
-- Adds:
--   * DunningCaseState enum            — active / retry_N_scheduled / recovered / churned
--   * DunningCase table                — one row per open recovery cycle
--   * Two indexes                      — worker scan + coach-facing lookup
--   * RLS posture                      — FORCE + restrictive deny-all (service-role only)
--
-- Why service-role-only RLS rather than coach-scoped permissive policies:
--   The coach-facing endpoint (GET /v1/billing/dunning/me) goes through
--   NestJS guards + Prisma's pooled service role, identical to every
--   other coach-billing read path on this codebase. There is no direct
--   Supabase Realtime / PostgREST surface for dunning data, so a
--   permissive USING (coach_id = auth.uid()) policy would only widen
--   the attack surface without enabling a feature.
--
-- ─── Step 1: enum ────────────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE "DunningCaseState" AS ENUM (
        'active',
        'retry_1_scheduled',
        'retry_2_scheduled',
        'retry_3_scheduled',
        'recovered',
        'churned'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Step 2: table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "DunningCase" (
    "id"                     TEXT               NOT NULL PRIMARY KEY,
    "coach_id"               TEXT               NOT NULL,
    "stripe_subscription_id" TEXT               NOT NULL,
    "stripe_customer_id"     TEXT,
    "stripe_invoice_id"      TEXT,
    "state"                  "DunningCaseState" NOT NULL DEFAULT 'active',
    "amount_cents"           INTEGER            NOT NULL DEFAULT 0,
    "currency"               TEXT               NOT NULL DEFAULT 'usd',
    "failure_reason"         TEXT,
    "failure_code"           TEXT,
    "retry_1_at"             TIMESTAMP(3),
    "retry_2_at"             TIMESTAMP(3),
    "retry_3_at"             TIMESTAMP(3),
    "recovered_at"           TIMESTAMP(3),
    "churned_at"             TIMESTAMP(3),
    "opened_by_event_id"     TEXT,
    "created_at"             TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3)       NOT NULL,
    CONSTRAINT "DunningCase_coach_id_fkey"
        FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- One open case per subscription. Recovered/churned cases keep their
-- subscription_id, so a re-failure on the same subscription must reopen
-- the existing row rather than insert a duplicate (handled in service).
CREATE UNIQUE INDEX IF NOT EXISTS "DunningCase_stripe_subscription_id_key"
    ON "DunningCase" ("stripe_subscription_id");

-- Worker tick scans by (state, updated_at) — picks the oldest open case
-- in each state first to avoid starving early rows during a backlog.
CREATE INDEX IF NOT EXISTS "DunningCase_state_updated_at_idx"
    ON "DunningCase" ("state", "updated_at");

-- Coach inbox lookup: "do I have an open dunning case?"
CREATE INDEX IF NOT EXISTS "DunningCase_coach_id_state_idx"
    ON "DunningCase" ("coach_id", "state");

-- ─── Step 3: RLS ─────────────────────────────────────────────────────────────
--
-- Service role bypasses RLS in Supabase. Restrictive deny-all on anon /
-- authenticated mirrors r43 (GuestCheckout) and r46 (CoachLanding*).

ALTER TABLE "DunningCase" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "DunningCase" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dunning_case_deny_all_select" ON "DunningCase";
DROP POLICY IF EXISTS "dunning_case_deny_all_insert" ON "DunningCase";
DROP POLICY IF EXISTS "dunning_case_deny_all_update" ON "DunningCase";
DROP POLICY IF EXISTS "dunning_case_deny_all_delete" ON "DunningCase";

CREATE POLICY "dunning_case_deny_all_select" ON "DunningCase"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "dunning_case_deny_all_insert" ON "DunningCase"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "dunning_case_deny_all_update" ON "DunningCase"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "dunning_case_deny_all_delete" ON "DunningCase"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ─── Reversibility ───────────────────────────────────────────────────────────
-- Forward-only in production. The block below is the dev/staging rollback
-- order (commented out so `prisma migrate deploy` does not execute it):
--
--   DROP POLICY IF EXISTS "dunning_case_deny_all_delete" ON "DunningCase";
--   DROP POLICY IF EXISTS "dunning_case_deny_all_update" ON "DunningCase";
--   DROP POLICY IF EXISTS "dunning_case_deny_all_insert" ON "DunningCase";
--   DROP POLICY IF EXISTS "dunning_case_deny_all_select" ON "DunningCase";
--   ALTER TABLE "DunningCase" NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE "DunningCase" DISABLE ROW LEVEL SECURITY;
--   DROP INDEX IF EXISTS "DunningCase_coach_id_state_idx";
--   DROP INDEX IF EXISTS "DunningCase_state_updated_at_idx";
--   DROP INDEX IF EXISTS "DunningCase_stripe_subscription_id_key";
--   DROP TABLE IF EXISTS "DunningCase";
--   DROP TYPE  IF EXISTS "DunningCaseState";
