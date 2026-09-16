-- Stop both writers before rollback. Refuse (23505) if either table relies on
-- platform separation; retain all data and both widened keys on any failure.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public."ScoutIngestEntity_identity_key"')
      AND indrelid = 'public."ScoutIngestEntity"'::regclass) OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public."ScoutReconstructionLedger_identity_key"')
      AND indrelid = 'public."ScoutReconstructionLedger"'::regclass) THEN
    RAISE EXCEPTION 'Unexpected identity index owner or missing prerequisite';
  END IF;
END $$;
CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
  ON public."ScoutIngestEntity" (coach_id, intent_id, source_id);
CREATE UNIQUE INDEX "ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key"
  ON public."ScoutReconstructionLedger" (coach_id, intent_id, entity_type, source_id);
DROP INDEX public."ScoutIngestEntity_identity_key";
DROP INDEX public."ScoutReconstructionLedger_identity_key";
ALTER TABLE public."ScoutIngestEntity" DROP CONSTRAINT scout_ingest_platform_canonical;
ALTER TABLE public."ScoutReconstructionLedger" DROP COLUMN source_platform;
COMMIT;
