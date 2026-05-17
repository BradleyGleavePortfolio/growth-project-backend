ALTER TABLE "ClientWorkoutAssignment" ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
ALTER TABLE "ClientWorkoutAssignment" ADD COLUMN IF NOT EXISTS "completion_payload" JSONB;
ALTER TABLE "ClientWorkoutAssignment" ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWorkoutAssignment_idempotency_key_key" ON "ClientWorkoutAssignment"("idempotency_key");
