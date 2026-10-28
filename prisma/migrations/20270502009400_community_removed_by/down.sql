-- Down for 20270502009400_community_removed_by (REMOVED-BY-BE). Drops the three
-- removed_by_user_id columns. Rows removed by a coach stay soft-deleted, so an
-- older server simply drops them from lists again (no placeholder).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "community_posts" DROP COLUMN IF EXISTS "removed_by_user_id";
ALTER TABLE "community_messages" DROP COLUMN IF EXISTS "removed_by_user_id";
ALTER TABLE "community_voice_notes" DROP COLUMN IF EXISTS "removed_by_user_id";

COMMIT;
