-- G2-E only: nullable provenance, NOT wide identity activation.
-- Reuses the recovered identity migration's public-object/transaction guards.
-- No default, backfill, new uniqueness, canonical check, policy or writer change.
-- Separate release artifact from T/R/N/C. Raw reruns must fail atomically.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
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
        -- ::name honors PostgreSQL's identifier truncation for the ledger key.
        AND pg_get_indexdef(i.indexrelid) = format(
          'CREATE UNIQUE INDEX %I ON public.%I USING btree (%s)',
          prerequisite.index_name::name, prerequisite.table_name, prerequisite.columns)
    ) THEN
      RAISE EXCEPTION 'G2-E unexpected identity prerequisite';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND attname = 'source_platform' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'G2-E platform column already exists';
  END IF;
END $$;

ALTER TABLE public."ScoutReconstructionLedger" ADD COLUMN source_platform TEXT;
COMMIT;
