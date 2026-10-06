-- Rollback of 20270318000000_dunning_dispute_pause_effects (D2d).
-- Drops only the two columns that migration adds. Confirmed-pause and
-- coach-restart stamps written after it are lost; run only with the dunning
-- v2 flag off.
BEGIN;

ALTER TABLE "DunningDisputeObligation" DROP COLUMN IF EXISTS "restarted_at";
ALTER TABLE "DunningState" DROP COLUMN IF EXISTS "billing_paused_at";

COMMIT;
