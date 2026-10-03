-- S-MWB Programs (backend, lane S-MWB-111) — client copies of a master program.
--
-- Bulk assign and package delivery copy a master WorkoutProgram (is_template =
-- true) onto each client as an is_template = false program. Two additive,
-- nullable columns make that copy addressable and exactly-once:
--   client_id    — the client the copy was made for (FK User, ON DELETE CASCADE,
--                  so deleting the client account deletes their copies; the
--                  copies' plans and assignments already cascade the same way).
--   delivery_key — UNIQUE exactly-once key. A retried bulk assign
--                  (`bulk:<coach>:<Idempotency-Key>:<client>`) or a retried
--                  package delivery (`pkg:p=<purchase>:c=<content>`) converges
--                  on one copy, including across a rolled-back transaction and
--                  two racing workers (the loser hits the unique index).
-- Existing rows keep NULL in both (masters, MWB-2 clones, #607 onboarding
-- copies); readers fall back to ClientWorkoutAssignment.client_id for those.
--
-- No backfill. No RLS change: WorkoutProgram policies are row-level
-- (owner_user_id / tenant) and cover every column; clients never read
-- WorkoutProgram directly (they read their ClientWorkoutAssignment rows).
ALTER TABLE "WorkoutProgram" ADD COLUMN IF NOT EXISTS "client_id" TEXT;
ALTER TABLE "WorkoutProgram" ADD COLUMN IF NOT EXISTS "delivery_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkoutProgram_delivery_key_key"
  ON "WorkoutProgram"("delivery_key");

CREATE INDEX IF NOT EXISTS "WorkoutProgram_cloned_from_id_client_id_archived_at_idx"
  ON "WorkoutProgram"("cloned_from_id", "client_id", "archived_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WorkoutProgram_client_id_fkey'
  ) THEN
    ALTER TABLE "WorkoutProgram"
      ADD CONSTRAINT "WorkoutProgram_client_id_fkey"
      FOREIGN KEY ("client_id") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
