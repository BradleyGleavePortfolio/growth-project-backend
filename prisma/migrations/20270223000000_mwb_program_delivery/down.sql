-- Reverse of 20270223000000_mwb_program_delivery. Drops only what the forward
-- migration added. Client copies stay (they are ordinary is_template = false
-- programs); they lose their client link and exactly-once key, so readers fall
-- back to ClientWorkoutAssignment.client_id, as for pre-S-MWB clones.
ALTER TABLE "WorkoutProgram" DROP CONSTRAINT IF EXISTS "WorkoutProgram_client_id_fkey";
DROP INDEX IF EXISTS "WorkoutProgram_cloned_from_id_client_id_archived_at_idx";
DROP INDEX IF EXISTS "WorkoutProgram_delivery_key_key";
ALTER TABLE "WorkoutProgram" DROP COLUMN IF EXISTS "delivery_key";
ALTER TABLE "WorkoutProgram" DROP COLUMN IF EXISTS "client_id";
