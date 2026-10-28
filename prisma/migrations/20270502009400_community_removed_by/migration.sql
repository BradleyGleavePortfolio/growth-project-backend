-- 20270502009400_community_removed_by (REMOVED-BY-BE, agent 175): who removed a
-- space voice note or chat message, so a coach's removal stays visible as a
-- placeholder (#174-4). Reverse: down.sql.
--
-- 1. removed_by_user_id on community_voice_notes, community_messages and
--    community_posts (posts: FR-1165R3): the coach (or TGP owner) who
--    removed someone else's item, set in the same write that sets
--    soft_deleted_at / deleted_at. Null on every live row, on an author's own
--    delete, and on every row removed before this file, so old removals stay
--    gone. Plain TEXT with no foreign key, as coach_messages.deleted_by_id
--    (20270303000000).
-- 2. Additive and nullable: no default, no backfill, no rewrite, so ADD COLUMN
--    is a catalog-only change. community_messages is range-partitioned; the
--    column added on the parent reaches every partition.
-- 3. No grant or policy changes: both tables keep their RLS (only the server's
--    service-role connection writes these columns).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "community_voice_notes" ADD COLUMN IF NOT EXISTS "removed_by_user_id" TEXT;
ALTER TABLE "community_messages" ADD COLUMN IF NOT EXISTS "removed_by_user_id" TEXT;
ALTER TABLE "community_posts" ADD COLUMN IF NOT EXISTS "removed_by_user_id" TEXT;

COMMIT;
