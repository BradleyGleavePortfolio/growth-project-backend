-- Hybrid pricing: introduce tier column on CoachSubscription.
-- Decacorn-quality migration: additive only, no DROP, idempotent backfill.
-- Target: FITNESS DB (rpyfdsgxxltzutgqeouk) via fly-deploy.

-- 1. Create CoachTier enum type.
--    'enterprise' is reserved for future use — column exists, no logic enforces it today.
CREATE TYPE "CoachTier" AS ENUM ('free', 'pro', 'enterprise');

-- 2. Add tier column with default.
--    Existing rows get 'free' from the column default (step 3 upgrades paying coaches).
--    New rows created between migration run and code deploy also get 'free' safely.
ALTER TABLE "CoachSubscription"
  ADD COLUMN "tier" "CoachTier" NOT NULL DEFAULT 'free';

-- 3. Backfill: coaches with an active subscription → pro.
--    Criteria: status IN ('active', 'trialing', 'grandfathered').
--    Everyone else stays 'free'.
--    This is idempotent: running twice produces the same result.
UPDATE "CoachSubscription"
  SET "tier" = 'pro'
  WHERE "status" IN ('active', 'trialing', 'grandfathered');

-- 4. Analytics index: enables efficient count(tier) queries for funnel analysis.
CREATE INDEX "CoachSubscription_tier_idx" ON "CoachSubscription" ("tier");
