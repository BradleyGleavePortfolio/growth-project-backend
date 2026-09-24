-- G2-C only: the identity contract. Drops the two NARROW unique indexes so that
-- the wide keys R created (coach_id, intent_id, entity_type, source_platform,
-- source_id) become the only arbiters of staging and ledger identity. Activation
-- boundary: from here the same source_id may exist under several families and
-- several platforms of one intent; the N writer and Q1 readers already address
-- rows by the five-field identity. NOT a writer/reader/policy/data change: the
-- wide keys, both canonical CHECKs, the ledger NOT NULL, the B fence, RLS flags
-- and every policy stay exactly as R/B left them; zero rows are touched.
--
-- Entry gate (refuses, never derives, deletes or repairs): both narrow indexes
-- exactly as accepted (a raw rerun or a decoy relation holding a narrow name is
-- refused), R exactly as shipped (both wide keys, both validated CHECKs, ledger
-- NOT NULL), both source_platform columns NOT NULL TEXT without default, and no
-- NULL provenance row anywhere. B's fence is neither asserted nor touched
-- (NOT NULL already refuses what it refuses; B.down owns it). Separate release
-- artifact from E/T/B/R/N. The recorded migration history is not rewritten by
-- the reverse (down.sql): after a production C.down the operator resolves it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  prerequisite RECORD;
BEGIN
  -- 1. Narrow keys exactly as accepted, on both tables (the objects this file drops).
  --    ::name honors PostgreSQL's 63-character identifier truncation for the ledger key.
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
      RAISE EXCEPTION 'G2-C unexpected identity prerequisite';
    END IF;
  END LOOP;
  -- 2. R exactly as shipped: both wide unique indexes on their own tables with the exact
  --    definition, both validated CHECK constraints keyed on source_platform alone, and the
  --    ledger column NOT NULL. Anything else (absent, partial, decoy) is refused.
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
      RAISE EXCEPTION 'G2-C wide identity absent';
    END IF;
  END LOOP;
  -- 3. Both provenance columns NOT NULL TEXT, no default, not generated/identity; and no NULL
  --    row on either table (redundant beside NOT NULL, cheap, belt-and-braces).
  FOR prerequisite IN SELECT * FROM (VALUES
    ('ScoutIngestEntity'), ('ScoutReconstructionLedger')
  ) AS columns(table_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(format('public.%I', prerequisite.table_name))
        AND a.attname = 'source_platform' AND NOT a.attisdropped
        AND a.atttypid = 'text'::regtype AND a.atttypmod = -1
        AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = ''
    ) THEN
      RAISE EXCEPTION 'G2-C wide identity absent';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public."ScoutReconstructionLedger" WHERE source_platform IS NULL)
    OR EXISTS (SELECT 1 FROM public."ScoutIngestEntity" WHERE source_platform IS NULL) THEN
    RAISE EXCEPTION 'G2-C wide identity absent';
  END IF;
END $$;

-- Contraction: catalog-only drops inside the transaction. No CONCURRENTLY (would break the
-- two-table atomicity), no CASCADE (any dependent object makes the drop refuse atomically),
-- schema-qualified so a shadow search_path cannot redirect them. The ledger name is the
-- literal accepted text; PostgreSQL truncates it to the same 63-character stored name.
DROP INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key";
DROP INDEX public."ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key";
COMMIT;
