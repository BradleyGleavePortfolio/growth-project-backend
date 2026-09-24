-- Reverse of 20270120000000_scout_identity_ready (G2-R).
-- Returns the two tables to the accepted E+B shape: drops ONLY the two canonical
-- CHECK constraints and the two wide unique indexes, and re-admits NULL on
-- ScoutReconstructionLedger.source_platform. Every row and every assigned
-- provenance value is retained; both narrow unique indexes, the E column and the
-- B fence (which keeps refusing NULL INSERTs) are untouched. Nothing is derived,
-- deleted or reset. Refuses when R is absent or not exactly as shipped, so raw
-- reruns fail atomically; the recorded migration history is not rewritten here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  prerequisite RECORD;
BEGIN
  -- Narrow keys still arbitrate: exactly the accepted shape, on both tables.
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
      RAISE EXCEPTION 'G2-R unexpected identity prerequisite';
    END IF;
  END LOOP;
  -- R exactly as shipped: both wide unique indexes on their own tables with the exact
  -- definition, both validated CHECK constraints keyed on source_platform alone, and the
  -- ledger column NOT NULL. Anything else (absent, partial, decoy) is refused.
  FOR prerequisite IN SELECT * FROM (VALUES
    ('ScoutIngestEntity', 'ScoutIngestEntity_identity_key', 'ScoutIngestEntity_source_platform_canonical'),
    ('ScoutReconstructionLedger', 'ScoutReconstructionLedger_identity_key', 'ScoutReconstructionLedger_source_platform_canonical')
  ) AS shipped(table_name, index_name, check_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indexrelid = to_regclass(format('public.%I', prerequisite.index_name))
        AND i.indrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
        AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
        AND pg_get_indexdef(i.indexrelid) = format(
          'CREATE UNIQUE INDEX %I ON public.%I USING btree (coach_id, intent_id, entity_type, source_platform, source_id)',
          prerequisite.index_name, prerequisite.table_name)
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'source_platform'
      WHERE c.conname = prerequisite.check_name
        AND c.conrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND c.contype = 'c' AND c.convalidated AND c.conkey = ARRAY[a.attnum]
    ) THEN
      RAISE EXCEPTION 'G2-R wide identity absent';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND a.attname = 'source_platform' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-R wide identity absent';
  END IF;
END $$;

ALTER TABLE public."ScoutReconstructionLedger"
  DROP CONSTRAINT "ScoutReconstructionLedger_source_platform_canonical";
ALTER TABLE public."ScoutIngestEntity"
  DROP CONSTRAINT "ScoutIngestEntity_source_platform_canonical";
DROP INDEX public."ScoutReconstructionLedger_identity_key";
DROP INDEX public."ScoutIngestEntity_identity_key";
ALTER TABLE public."ScoutReconstructionLedger"
  ALTER COLUMN source_platform DROP NOT NULL;
COMMIT;
