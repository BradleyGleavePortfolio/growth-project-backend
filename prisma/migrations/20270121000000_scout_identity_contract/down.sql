-- Reverse of 20270121000000_scout_identity_contract (G2-C).
-- Recreates ONLY the two narrow unique indexes, byte-exact (original names, columns,
-- schema-qualified), returning both tables to the accepted R shape: wide keys, both
-- canonical CHECKs, the ledger NOT NULL, the B fence, every row and every assigned
-- provenance value are retained. Nothing is derived, deleted, deduplicated or
-- re-statused. Refuses when C is absent or not exactly as shipped (raw reruns and a
-- pre-C database fail atomically), and REFUSES when restoring a narrow key would lose
-- data: any duplicate (coach_id, intent_id, source_id) in staging or duplicate
-- (coach_id, intent_id, entity_type, source_id) in the ledger is a cross-family or
-- cross-platform identity that only the wide key can hold. That refusal is a fixed,
-- identifier-free 23505 (never PostgreSQL's `DETAIL: Key (...)=(...)` line, which would
-- print coach/source identifiers into release logs); both tables are checked before
-- either CREATE, so there is never a half-narrow state. Forward repair only: keep C,
-- fix forward with N-compatible writers. The recorded migration history is not
-- rewritten here (S1-owned recovery semantics).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  prerequisite RECORD;
BEGIN
  -- 1. C exactly as shipped: no relation in `public` holds either narrow name (a rerun, a
  --    pre-C database or a decoy relation under the name is refused, never dropped or adopted).
  IF to_regclass('public."ScoutIngestEntity_coach_id_intent_id_source_id_key"') IS NOT NULL
    OR to_regclass('public."ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key"') IS NOT NULL
  THEN
    RAISE EXCEPTION 'G2-C contract absent';
  END IF;
  -- 2. R exactly as shipped: both wide unique indexes on their own tables with the exact
  --    definition, both validated CHECK constraints keyed on source_platform alone, both
  --    provenance columns NOT NULL. Anything else (absent, partial, decoy) is refused.
  FOR prerequisite IN SELECT * FROM (VALUES
    ('ScoutIngestEntity', 'ScoutIngestEntity_identity_key', 'ScoutIngestEntity_source_platform_canonical'),
    ('ScoutReconstructionLedger', 'ScoutReconstructionLedger_identity_key', 'ScoutReconstructionLedger_source_platform_canonical')
  ) AS shipped(table_name, index_name, check_name)
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
          'CREATE UNIQUE INDEX %I ON public.%I USING btree (coach_id, intent_id, entity_type, source_platform, source_id)',
          prerequisite.index_name, prerequisite.table_name)
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'source_platform'
      WHERE c.conname = prerequisite.check_name
        AND c.conrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND c.contype = 'c' AND c.convalidated AND c.conkey = ARRAY[a.attnum]
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND a.attname = 'source_platform' AND NOT a.attisdropped
        AND a.atttypid = 'text'::regtype AND a.attnotnull
    ) THEN
      RAISE EXCEPTION 'G2-C contract absent';
    END IF;
  END LOOP;
  -- 3. Collision pre-check under ACCESS EXCLUSIVE (race-free), BOTH tables before ANY CREATE.
  --    Fixed text, SQLSTATE 23505, no identifiers or values are raised.
  IF EXISTS (
      SELECT 1 FROM public."ScoutIngestEntity"
      GROUP BY coach_id, intent_id, source_id HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1 FROM public."ScoutReconstructionLedger"
      GROUP BY coach_id, intent_id, entity_type, source_id HAVING count(*) > 1
    ) THEN
    RAISE EXCEPTION 'G2-C.down refused: cross-family/cross-platform identities exist; restoring narrow keys would lose data. Forward repair only: keep C, fix forward with N-compatible writers; no deletion.'
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

-- Byte-exact recreation of the accepted narrow keys (20261222000000 / 20261223000200 DDL),
-- schema-qualified so a shadow search_path cannot redirect them; the ledger name is the
-- literal accepted text and truncates to the same 63-character stored name.
CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
  ON public."ScoutIngestEntity" (coach_id, intent_id, source_id);
CREATE UNIQUE INDEX "ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key"
  ON public."ScoutReconstructionLedger" (coach_id, intent_id, entity_type, source_id);

-- Postcondition, in the same transaction: the recreated keys are exactly the accepted shape
-- (the same predicate every older down.sql requires). A non-exact recreation refuses atomically.
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
      RAISE EXCEPTION 'G2-C narrow key not restored exactly';
    END IF;
  END LOOP;
END $$;
COMMIT;
