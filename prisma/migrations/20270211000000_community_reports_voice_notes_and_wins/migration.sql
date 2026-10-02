-- Community reports for voice notes and member wins (App Review 1.2).
--
-- 1. CommunityModerationTargetType gains 'voice_note' and 'win' so a member can
--    report a voice note or a win into the coach's moderation queue (the queue
--    table community_moderation_actions already has RLS with explicit
--    coach / reporter policies; no policy change is needed because the new
--    values reuse the same rows and workspace_id scoping).
-- 2. "CommunityWin"."hidden_at": a moderation Hide sets it; hidden wins are
--    excluded from every feed. Nullable, no default, no backfill: additive and
--    safe for the running reader/writer (old code never reads the column).
--
-- IRREVERSIBLE for the enum values (PostgreSQL < 17 cannot drop an enum
-- value); down.sql drops only the column. ADD VALUE IF NOT EXISTS keeps the
-- statements idempotent. Prisma runs each migration file outside a
-- transaction (see 20260701235900_add_sub_coach_role_value), and nothing in
-- this file uses the new values, so ADD VALUE is safe here.
-- No new table: RLS coverage is unchanged ("CommunityWin" keeps RLS enabled
-- and forced with its existing service-role policy).

ALTER TYPE "CommunityModerationTargetType" ADD VALUE IF NOT EXISTS 'voice_note';
ALTER TYPE "CommunityModerationTargetType" ADD VALUE IF NOT EXISTS 'win';

ALTER TABLE "CommunityWin" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3);
