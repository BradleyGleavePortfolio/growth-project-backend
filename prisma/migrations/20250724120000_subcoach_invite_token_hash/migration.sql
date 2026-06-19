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
--
-- ── ORDERING-BUG GUARD (no-op-on-missing) ──────────────────────────────────
-- This migration was authored assuming "SubCoachInvite" already existed. Due
-- to a pre-existing lexical-ordering bug, the CREATE for "SubCoachInvite"
-- actually lives in a LATER-dated migration
-- (20260604000000_add_team_profile_and_sub_coach_invite), so on a clean DB a
-- forward `prisma migrate deploy` runs these ALTERs before the table exists
-- and aborts with P3018 ("relation \"SubCoachInvite\" does not exist").
--
-- Fix: wrap the original DDL in an IF EXISTS presence guard so a clean-DB
-- forward migration no-ops here and succeeds. The DDL is otherwise unchanged
-- and idempotent (ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT
-- EXISTS), so on production DBs that already applied this migration the body
-- runs identically. The same columns/index are (re)applied AFTER the table is
-- created by the new sibling migration
-- 20260604000001_subcoach_invite_token_hash_reapply.
--
-- NOTE on Prisma checksum drift: Prisma stores a SHA-256 of this file in
-- `_prisma_migrations.checksum`. Editing this file changes that checksum, so
-- `prisma migrate deploy` on an environment where this migration was already
-- recorded will report drift. See the PR body / OPERATOR_ATTACH for the exact
-- one-time `UPDATE _prisma_migrations SET checksum = ...` the operator must run
-- on prod before this lands. The edit is a guard-only semantic no-op.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'SubCoachInvite') THEN
    -- Drop the NOT NULL constraint on `token` by altering the column to nullable.
    ALTER TABLE "SubCoachInvite" ALTER COLUMN "token" DROP NOT NULL;

    -- Add the new token_hash column (nullable during rollout; new writes always
    -- populate it, but the column constraint stays nullable until the legacy
    -- `token` column is dropped and a NOT NULL backfill can run safely).
    ALTER TABLE "SubCoachInvite" ADD COLUMN IF NOT EXISTS "token_hash" TEXT;

    -- Unique index on token_hash — this is the primary lookup key for all new
    -- invites. Partial index excludes NULL so legacy rows with only `token` set
    -- do not collide with new rows that have only `token_hash` set.
    CREATE UNIQUE INDEX IF NOT EXISTS "SubCoachInvite_token_hash_key"
        ON "SubCoachInvite"("token_hash")
        WHERE "token_hash" IS NOT NULL;
  END IF;
END $$;

-- token column: kept for legacy unredeemed invites; new writes populate token_hash only.
-- A separate backfill+drop migration will retire `token` once all pre-rollout
-- invites expire (7–14 days after this deploy, per INVITE_TTL_DAYS).
