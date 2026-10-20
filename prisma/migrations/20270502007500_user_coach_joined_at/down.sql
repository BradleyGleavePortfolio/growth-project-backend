-- Down for 20270502007500_user_coach_joined_at (FIX-1118-R1). Drops the
-- trigger, its function and the column; the stored join times are lost (the
-- brief then counts only a consultation finished in the last 24 h).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS "User_coach_joined_at" ON "User";
DROP FUNCTION IF EXISTS app.user_coach_joined_at();
ALTER TABLE "User" DROP COLUMN IF EXISTS "coach_joined_at";

COMMIT;
