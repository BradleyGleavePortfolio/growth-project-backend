-- 20270502010500_workout_session_client_key (WK-1-BE, agent 188): a workout saved twice after a lost answer
-- is stored once.
--
-- WorkoutSession.client_key: the optional Idempotency-Key the phone sends on POST /workouts (its offline
-- queue key). A resend with the same key returns the stored workout and creates nothing. NULL = a save
-- without a key, exactly as before. Additive only: one nullable column, no default, no backfill and no data
-- rewrite; every existing row keeps client_key NULL, and NULLs never collide in a Postgres unique index, so
-- the index builds over existing data without conflict.
-- No RLS change: the table keeps its existing row-level policies, which cover every column.
-- Reverse: down.sql.

SET lock_timeout = '5s';

ALTER TABLE "WorkoutSession" ADD COLUMN IF NOT EXISTS "client_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkoutSession_user_id_client_key_key" ON "WorkoutSession"("user_id", "client_key");

RESET lock_timeout;
