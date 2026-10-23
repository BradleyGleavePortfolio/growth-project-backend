-- Down for 20270502009100_community_space_reads (SC-BE2). Drops the read rows (read lines, notification
-- modes and silences go back to the defaults) and the high-alert mark on messages.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS "community_space_reads";
ALTER TABLE "community_messages" DROP COLUMN IF EXISTS "high_alert";

COMMIT;
