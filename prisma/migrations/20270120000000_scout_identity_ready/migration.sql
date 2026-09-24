-- G2-R only: required canonical provenance and the wide identity keys, on top of
-- E (nullable column), T (provenance-writing worker) and B (backfill + fence).
-- Makes ScoutReconstructionLedger.source_platform NOT NULL, adds one canonical
-- CHECK per table (the exact SQL mirror of src/scout/scout-platform.ts
-- isCanonicalPlatform: 1..256 chars, first [a-z0-9], rest [a-z0-9._:-]) and
-- creates the two wide unique keys (coach_id, intent_id, entity_type,
-- source_platform, source_id). NOT a writer/reader/policy change: both narrow
-- unique indexes stay and keep arbitrating duplicates (a narrow duplicate is
-- always a wide duplicate, so the wide builds cannot fail on data), the B fence
-- stays (redundant beside NOT NULL, harmless), RLS is untouched. N/Q1/C are later.
--
-- Entry gate (refuses, never derives, deletes or repairs): the accepted narrow
-- identity, the E column exactly as shipped, the B fence exactly as shipped, no
-- remaining NULL provenance (B's drain must be complete on THIS database), no
-- noncanonical provenance in either table, and none of the objects this file
-- creates. Separate release artifact from E/T/B. Raw reruns fail atomically.
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
      RAISE EXCEPTION 'G2-R unexpected identity prerequisite';
    END IF;
  END LOOP;
  -- Nothing this file creates may already exist under its name (raw rerun, partial state or a
  -- decoy relation/constraint holding the name): refused, never dropped or adopted.
  IF to_regclass('public."ScoutIngestEntity_identity_key"') IS NOT NULL
    OR to_regclass('public."ScoutReconstructionLedger_identity_key"') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname IN ('ScoutIngestEntity_source_platform_canonical',
                        'ScoutReconstructionLedger_source_platform_canonical')
    ) THEN
    RAISE EXCEPTION 'G2-R wide identity already present';
  END IF;
  -- E must be present exactly as shipped: nullable TEXT, no default, no constraint. The
  -- staging column must be the accepted NOT NULL TEXT, no default, no constraint.
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
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutIngestEntity"'::regclass
      AND a.attname = 'source_platform' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND a.atttypmod = -1
      AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = ''
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = a.attrelid AND a.attnum = ANY(c.conkey)
      )
  ) THEN
    RAISE EXCEPTION 'G2-R unexpected platform column prerequisite';
  END IF;
  -- B fence exactly as shipped (structural identity as 20270119000000 down.sql checks it):
  -- BEFORE INSERT FOR EACH ROW (tgtype 7), public.scout_ledger_platform_fence() with zero
  -- arguments, no WHEN clause, no column list, not a constraint trigger, not SECURITY DEFINER.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND t.tgname = 'ScoutReconstructionLedger_platform_fence'
      AND NOT t.tgisinternal
      AND p.oid = to_regprocedure('public.scout_ledger_platform_fence()')
      AND p.pronargs = 0
      AND NOT p.prosecdef
      AND t.tgtype = 7
      AND t.tgqual IS NULL
      AND cardinality(t.tgattr::int2[]) = 0
      AND t.tgnargs = 0
      AND t.tgconstraint = 0
  ) THEN
    RAISE EXCEPTION 'G2-R fence absent';
  END IF;
  -- Data preconditions: the drain is complete and every value is already canonical. A
  -- violation names the class only; no identifiers or values are raised.
  IF EXISTS (SELECT 1 FROM public."ScoutReconstructionLedger" WHERE source_platform IS NULL) THEN
    RAISE EXCEPTION 'G2-R unresolved NULL provenance';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."ScoutReconstructionLedger"
    WHERE NOT (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$')
  ) THEN
    RAISE EXCEPTION 'G2-R noncanonical provenance';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."ScoutIngestEntity"
    WHERE NOT (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$')
  ) THEN
    RAISE EXCEPTION 'G2-R noncanonical staged provenance';
  END IF;
END $$;

ALTER TABLE public."ScoutReconstructionLedger"
  ALTER COLUMN source_platform SET NOT NULL;
-- Canonical token contract (isCanonicalPlatform): no normalization, no default, no fallback.
ALTER TABLE public."ScoutReconstructionLedger"
  ADD CONSTRAINT "ScoutReconstructionLedger_source_platform_canonical"
  CHECK (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$');
ALTER TABLE public."ScoutIngestEntity"
  ADD CONSTRAINT "ScoutIngestEntity_source_platform_canonical"
  CHECK (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$');
-- Wide identity keys (names and column order are the frozen F contract; declared in
-- prisma/schema.prisma with the same `map`). The narrow keys are NOT dropped here.
CREATE UNIQUE INDEX "ScoutIngestEntity_identity_key"
  ON public."ScoutIngestEntity" (coach_id, intent_id, entity_type, source_platform, source_id);
CREATE UNIQUE INDEX "ScoutReconstructionLedger_identity_key"
  ON public."ScoutReconstructionLedger" (coach_id, intent_id, entity_type, source_platform, source_id);
COMMIT;
