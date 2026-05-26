-- Migration: subcoach_invite_token_hash
--
-- Fixes A1-C6-P1-2: Sub-coach invite tokens stored plaintext-at-rest.
--
-- Strategy (backwards-compatible transition window):
--   1. Add `token_hash` column (TEXT, nullable during rollout).
--   2. Add a UNIQUE index on `token_hash` so the hash is the authoritative
--      lookup key going forward.
--   3. Make the existing `token` column nullable so new writes can skip it.
--      The column is NOT dropped here — it acts as a fallback for legacy
--      unredeemed invites issued before this rollout. A follow-up migration
--      will drop `token` once all pre-rollout invites have expired (14 days
--      per INVITE_TTL_DAYS) or been revoked.
--
-- After this migration:
--   - New invite() and reissueInvite() calls store only token_hash (null token).
--   - accept() and previewByToken() hash the presented token and look up by
--     token_hash first; fall back to plaintext token lookup for legacy rows.
--   - DB dump no longer yields a list of consumable invite tokens.

-- Drop the NOT NULL constraint on `token` by altering the column to nullable.
ALTER TABLE "SubCoachInvite" ALTER COLUMN "token" DROP NOT NULL;

-- Add the new token_hash column (nullable during rollout; new writes always
-- populate it, but the column constraint stays nullable until the legacy
-- `token` column is dropped and a NOT NULL backfill can run safely).
ALTER TABLE "SubCoachInvite" ADD COLUMN "token_hash" TEXT;

-- Unique index on token_hash — this is the primary lookup key for all new
-- invites. Partial index excludes NULL so legacy rows with only `token` set
-- do not collide with new rows that have only `token_hash` set.
CREATE UNIQUE INDEX "SubCoachInvite_token_hash_key"
    ON "SubCoachInvite"("token_hash")
    WHERE "token_hash" IS NOT NULL;

-- token column: kept for legacy unredeemed invites; new writes populate token_hash only.
-- A separate backfill+drop migration will retire `token` once all pre-rollout
-- invites expire (7–14 days after this deploy, per INVITE_TTL_DAYS).
