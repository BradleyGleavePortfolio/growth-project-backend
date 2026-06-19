-- Migration: subcoach_invite_token_hash_reapply
--
-- IRREVERSIBLE: reapplies the token_hash security hardening
-- (20250724120000_subcoach_invite_token_hash) AFTER the SubCoachInvite table
-- is created by 20260604000000_add_team_profile_and_sub_coach_invite. The
-- original migration ran before the CREATE due to a pre-existing lexical
-- ordering bug and is now guarded to no-op on a clean DB; this sibling
-- migration is what actually establishes the token_hash column, the
-- token-nullable relaxation, and the partial unique index on a freshly built
-- DB. Rolling this back would re-introduce the plaintext-token-at-rest
-- vulnerability (A1-C6-P1-2) and leave the schema out of sync with
-- schema.prisma, so there is no safe down path.
--
-- This migration is idempotent and a no-op on production DBs that already have
-- token_hash applied (ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT
-- EXISTS / DROP NOT NULL is naturally idempotent). The IF EXISTS table guard
-- keeps it defensive in the unlikely event the table is absent.
--
-- End state (matches prisma/schema.prisma model SubCoachInvite):
--   - "token"      TEXT NULL  + UNIQUE INDEX "SubCoachInvite_token_key"
--   - "token_hash" TEXT NULL  + partial UNIQUE INDEX "SubCoachInvite_token_hash_key"

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'SubCoachInvite') THEN
    ALTER TABLE "SubCoachInvite" ALTER COLUMN "token" DROP NOT NULL;

    ALTER TABLE "SubCoachInvite" ADD COLUMN IF NOT EXISTS "token_hash" TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS "SubCoachInvite_token_hash_key"
        ON "SubCoachInvite"("token_hash")
        WHERE "token_hash" IS NOT NULL;
  END IF;
END $$;
