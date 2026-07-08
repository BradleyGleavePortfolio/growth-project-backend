-- IMPORTER-E FIX-2 — add device_id to the progress snapshot key.
--
-- A coach mirroring one import (single intent_id) from two physical devices at
-- once (laptop + phone) must keep two independent snapshot rows instead of the
-- second device clobbering the first. device_id joins (coach_id, intent_id) in
-- the upsert key so each device owns its own row.
--
-- The base table (20261222000000) shipped with a 2-column unique on
-- (coach_id, intent_id). This migration widens that to 3 columns. It is safe on
-- a populated table only if no (coach_id, intent_id) pair already has rows that
-- would collide under a default device_id — the feature is dark (FEATURE_SCOUT
-- _INGEST off, R-DARK-1) so the table is empty in every environment, and the
-- backfill DEFAULT below makes the NOT NULL add total regardless.
--
-- Dated AFTER 20261222000000_scout_progress_and_completion.
-- =====================================================================

BEGIN;

-- Backfill any pre-existing rows with a sentinel so the NOT NULL add is total,
-- then drop the default so new rows must supply device_id explicitly.
ALTER TABLE "ScoutProgressSnapshot" ADD COLUMN "device_id" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "ScoutProgressSnapshot" ALTER COLUMN "device_id" DROP DEFAULT;

DROP INDEX IF EXISTS "ScoutProgressSnapshot_coach_id_intent_id_key";
CREATE UNIQUE INDEX "ScoutProgressSnapshot_coach_id_intent_id_device_id_key" ON "ScoutProgressSnapshot"("coach_id", "intent_id", "device_id");

COMMIT;
