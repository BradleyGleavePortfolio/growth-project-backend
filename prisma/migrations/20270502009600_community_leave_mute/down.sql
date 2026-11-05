-- Down for 20270502009600_community_leave_mute (LEAVE-MUTE-BE). Drops the thread rows (muted and left threads
-- follow again) and the left mark on space rows (every left space is back in the list).
-- FR-1168: also the reply trigger and its function, and the departure rows (no "{name} left" lines).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS "community_messages_reply_follows_thread" ON "community_messages";
DROP FUNCTION IF EXISTS public.community_reply_follows_thread();
DROP TABLE IF EXISTS "community_space_departures";
DROP TABLE IF EXISTS "community_thread_prefs";
ALTER TABLE "community_space_reads" DROP COLUMN IF EXISTS "left_at";

COMMIT;
