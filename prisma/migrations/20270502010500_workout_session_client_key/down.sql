-- Down for 20270502010500_workout_session_client_key (WK-1-BE). Drops the workout client key and its index.
-- Irreversible for data: every stored key is deleted; workouts otherwise stay. A resend after the down
-- stores a second workout again (the pre-WK-1 behaviour).

SET lock_timeout = '5s';

DROP INDEX IF EXISTS "WorkoutSession_user_id_client_key_key";

ALTER TABLE "WorkoutSession" DROP COLUMN IF EXISTS "client_key";

RESET lock_timeout;
