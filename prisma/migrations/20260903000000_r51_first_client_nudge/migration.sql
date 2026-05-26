-- R51 First-Client Nudge — Phase 1: schema + RLS.
--
-- 1. Creates ENUM OnboardingMilestone.
-- 2. Creates CoachOnboardingState — one row per coach driving the
--    7-day onboarding-to-first-paid-client nudge sequence.
-- 3. Locks the table with ENABLE + FORCE RLS + restrictive deny-all
--    policies. The Prisma client connects as the service role and
--    bypasses RLS; coaches reach this state only via the
--    GET /v1/coaches/me/onboarding/state endpoint, which queries
--    Prisma (service role) gated on the JWT user id. This mirrors the
--    r46 + r47 landing-pages tables' posture.

-- ─── Step 1: ENUM type ───────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE "OnboardingMilestone" AS ENUM (
        'signed_up',
        'created_package',
        'shared_link',
        'first_lead',
        'first_client'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Step 2: CoachOnboardingState table ──────────────────────────────────────
--
-- One row per coach (unique on coach_id).  Lazily created by the
-- scheduler on first eligible tick so existing coaches who signed up
-- before this PR can be backfilled without a separate data migration.

CREATE TABLE IF NOT EXISTS "CoachOnboardingState" (
    "id"              TEXT                  NOT NULL PRIMARY KEY,
    "coach_id"        TEXT                  NOT NULL,
    "signup_at"       TIMESTAMP(3)          NOT NULL,
    "first_client_at" TIMESTAMP(3),
    "churned_at"      TIMESTAMP(3),
    "day_1_sent"      BOOLEAN               NOT NULL DEFAULT FALSE,
    "day_1_sent_at"   TIMESTAMP(3),
    "day_2_sent"      BOOLEAN               NOT NULL DEFAULT FALSE,
    "day_2_sent_at"   TIMESTAMP(3),
    "day_3_sent"      BOOLEAN               NOT NULL DEFAULT FALSE,
    "day_3_sent_at"   TIMESTAMP(3),
    "day_5_sent"      BOOLEAN               NOT NULL DEFAULT FALSE,
    "day_5_sent_at"   TIMESTAMP(3),
    "day_7_sent"      BOOLEAN               NOT NULL DEFAULT FALSE,
    "day_7_sent_at"   TIMESTAMP(3),
    "last_milestone"  "OnboardingMilestone" NOT NULL DEFAULT 'signed_up',
    "opted_out_at"    TIMESTAMP(3),
    "created_at"      TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachOnboardingState_coach_id_fkey"
        FOREIGN KEY ("coach_id") REFERENCES "User" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- One row per coach.
CREATE UNIQUE INDEX IF NOT EXISTS "CoachOnboardingState_coach_id_key"
    ON "CoachOnboardingState" ("coach_id");

-- Scheduler scan: filter by milestone to skip first_client coaches.
CREATE INDEX IF NOT EXISTS "CoachOnboardingState_last_milestone_idx"
    ON "CoachOnboardingState" ("last_milestone");

-- Cohort / retention queries: signup-window scans.
CREATE INDEX IF NOT EXISTS "CoachOnboardingState_signup_at_idx"
    ON "CoachOnboardingState" ("signup_at");

-- ─── Step 3: Row-Level Security ──────────────────────────────────────────────
--
-- Pattern mirrors r46 / r47.  Prisma service-role connection bypasses
-- RLS; no PostgREST / client-authed path reaches this table directly.
-- Coaches read their state via the dedicated endpoint, which queries
-- Prisma (service role) after gating on the JWT user id.

ALTER TABLE "CoachOnboardingState" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "CoachOnboardingState" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "onboarding_state_deny_all_select" ON "CoachOnboardingState";
DROP POLICY IF EXISTS "onboarding_state_deny_all_insert" ON "CoachOnboardingState";
DROP POLICY IF EXISTS "onboarding_state_deny_all_update" ON "CoachOnboardingState";
DROP POLICY IF EXISTS "onboarding_state_deny_all_delete" ON "CoachOnboardingState";

CREATE POLICY "onboarding_state_deny_all_select" ON "CoachOnboardingState"
    AS RESTRICTIVE FOR SELECT USING (false);

CREATE POLICY "onboarding_state_deny_all_insert" ON "CoachOnboardingState"
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY "onboarding_state_deny_all_update" ON "CoachOnboardingState"
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "onboarding_state_deny_all_delete" ON "CoachOnboardingState"
    AS RESTRICTIVE FOR DELETE USING (false);

-- ─── Reversibility (mirrors r46 P3 pattern) ──────────────────────────────────
-- Forward-only in production.  The block below is the rollback runbook for
-- dev/staging; statements are commented out so `prisma migrate deploy`
-- never executes them.
--
-- ROLLBACK:
-- DROP POLICY IF EXISTS "onboarding_state_deny_all_delete" ON "CoachOnboardingState";
-- DROP POLICY IF EXISTS "onboarding_state_deny_all_update" ON "CoachOnboardingState";
-- DROP POLICY IF EXISTS "onboarding_state_deny_all_insert" ON "CoachOnboardingState";
-- DROP POLICY IF EXISTS "onboarding_state_deny_all_select" ON "CoachOnboardingState";
-- ALTER TABLE "CoachOnboardingState" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "CoachOnboardingState" DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS "CoachOnboardingState_signup_at_idx";
-- DROP INDEX IF EXISTS "CoachOnboardingState_last_milestone_idx";
-- DROP INDEX IF EXISTS "CoachOnboardingState_coach_id_key";
-- DROP TABLE IF EXISTS "CoachOnboardingState";
-- DROP TYPE IF EXISTS "OnboardingMilestone";
