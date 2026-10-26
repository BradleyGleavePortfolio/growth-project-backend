-- Down for 20270502009600_community_leave_mute (LEAVE-MUTE-BE). Drops the thread rows (muted and left threads
-- follow again) and the left mark on space rows (every left space is back in the list).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "community_thread_prefs";
ALTER TABLE "community_space_reads" DROP COLUMN IF EXISTS "left_at";

COMMIT;
