-- Phase 1A: OWNER role + CoachProfile + SubscriptionStatus enum.
--
-- Additive only: existing rows untouched, existing FKs untouched. The
-- bootstrap-owners.ts script (run separately by an operator) flips
-- specific accounts to role=owner and backfills CoachProfile rows.
--
-- This file is deliberately idempotent so it can be safely re-applied
-- on environments that may have a partial state (the prior release.sh
-- still falls back to db push for un-migration-managed DBs).

-- ---- Role enum: add `owner` if missing -----------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'Role' AND e.enumlabel = 'owner'
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'owner';
  END IF;
END $$;

-- ---- SubscriptionStatus enum (new) --------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus') THEN
    CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'paused');
  END IF;
END $$;

-- ---- CoachProfile table -------------------------------------------
CREATE TABLE IF NOT EXISTS "CoachProfile" (
  "id"                          TEXT PRIMARY KEY,
  "user_id"                     TEXT NOT NULL UNIQUE,
  "business_name"               TEXT,
  "bio"                         TEXT,
  "timezone"                    TEXT,
  "branding_accent_color"       TEXT,
  "branding_logo_url"           TEXT,
  "invite_code"                 TEXT NOT NULL UNIQUE,
  "stripe_customer_id"          TEXT,
  "stripe_subscription_id"      TEXT,
  "subscription_status"         "SubscriptionStatus",
  "plan_tier"                   TEXT NOT NULL DEFAULT 'flat_300',
  "current_period_end"          TIMESTAMP(3),
  "trial_end"                   TIMESTAMP(3),
  "ai_monthly_spend_cap_cents"  INTEGER NOT NULL DEFAULT 5000,
  "created_by_owner_id"         TEXT,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "CoachProfile_invite_code_idx" ON "CoachProfile"("invite_code");
CREATE INDEX IF NOT EXISTS "CoachProfile_subscription_status_idx" ON "CoachProfile"("subscription_status");
CREATE INDEX IF NOT EXISTS "CoachProfile_created_by_owner_id_idx" ON "CoachProfile"("created_by_owner_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CoachProfile_user_id_fkey'
  ) THEN
    ALTER TABLE "CoachProfile"
      ADD CONSTRAINT "CoachProfile_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CoachProfile_created_by_owner_id_fkey'
  ) THEN
    ALTER TABLE "CoachProfile"
      ADD CONSTRAINT "CoachProfile_created_by_owner_id_fkey"
      FOREIGN KEY ("created_by_owner_id") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
