-- Prefer retaining E. Operator must first drain every platform-aware writer.
-- This script cannot prove that drain or authorize erasure. Refuse ANY assigned
-- provenance; no derivation, deletion, restore-artifact or force-drop shortcut.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Forced RLS must error rather than hide rows from the destructive safety check.
-- This does not disable RLS or confer a bypass privilege.
SET LOCAL row_security = off;
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  prerequisite RECORD;
BEGIN
  FOR prerequisite IN SELECT * FROM (VALUES
    ('ScoutIngestEntity', 'ScoutIngestEntity_coach_id_intent_id_source_id_key',
      'coach_id, intent_id, source_id'),
    ('ScoutReconstructionLedger', 'ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key',
      'coach_id, intent_id, entity_type, source_id')
  ) AS required(table_name, index_name, columns)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      WHERE i.indexrelid = to_regclass(format('public.%I', prerequisite.index_name))
        AND i.indrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
        AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
        AND pg_get_indexdef(i.indexrelid) = format(
          'CREATE UNIQUE INDEX %I ON public.%I USING btree (%s)',
          prerequisite.index_name::name, prerequisite.table_name, prerequisite.columns)
    ) THEN
      RAISE EXCEPTION 'G2-E unexpected identity prerequisite';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND a.attname = 'source_platform' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND a.atttypmod = -1
      AND NOT a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = ''
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = a.attrelid AND a.attnum = ANY(c.conkey)
      )
  ) THEN
    RAISE EXCEPTION 'G2-E unexpected platform column prerequisite';
  END IF;
  IF EXISTS (SELECT 1 FROM public."ScoutReconstructionLedger" WHERE source_platform IS NOT NULL) THEN
    RAISE EXCEPTION 'G2-E refuses removal of assigned provenance';
  END IF;
END $$;

ALTER TABLE public."ScoutReconstructionLedger" DROP COLUMN source_platform;
COMMIT;
