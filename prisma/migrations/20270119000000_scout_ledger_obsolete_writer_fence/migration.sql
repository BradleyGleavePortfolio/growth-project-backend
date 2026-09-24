-- G2-B only: fence obsolete (platform-unaware) ledger writers. NOT a backfill,
-- NOT NULL, a CHECK, wide identity or any writer/reader/policy change.
-- Entry gate (operator-owned, not provable here): T is the only deployed ledger
-- writer image and no O image is restart-eligible. The fence makes a stray O
-- restart or direct maintenance writer fail loudly on its first NULL-provenance
-- INSERT instead of silently re-creating NULL rows after the bounded backfill,
-- so the later "zero remaining NULL" sweep is durable evidence for R.
--
-- Insert-only on purpose: UPDATEs are not fenced, so the accepted T claim of an
-- existing NULL row (upsert update path, then the transactional claim) and O's
-- update of already-present rows keep their accepted semantics. Both narrow
-- unique indexes, RLS and the nullable E column are prerequisites and untouched.
-- The bounded resumable backfill is src/scout/scout-ledger-backfill.ts.
-- Separate release artifact from E/T and from R/N/C. Raw reruns fail atomically.
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
      RAISE EXCEPTION 'G2-B unexpected identity prerequisite';
    END IF;
  END LOOP;
  -- E must be present exactly as shipped: nullable TEXT, no default, no constraint.
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
    RAISE EXCEPTION 'G2-B unexpected platform column prerequisite';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND tgname = 'ScoutReconstructionLedger_platform_fence'
  ) OR to_regprocedure('public.scout_ledger_platform_fence()') IS NOT NULL THEN
    RAISE EXCEPTION 'G2-B fence already present';
  END IF;
END $$;

-- Refuses, never derives: no default, lookup, or "unknown" substitute.
CREATE FUNCTION public.scout_ledger_platform_fence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.source_platform IS NULL THEN
    RAISE EXCEPTION 'G2-B obsolete writer fenced: ScoutReconstructionLedger.source_platform is required'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Not SECURITY DEFINER; trigger firing needs no EXECUTE grant, so nothing is callable.
REVOKE ALL ON FUNCTION public.scout_ledger_platform_fence() FROM PUBLIC;
COMMENT ON FUNCTION public.scout_ledger_platform_fence() IS
  'G2-B: refuses INSERT of a ScoutReconstructionLedger row without source_platform (obsolete-writer fence). Removed by 20270119000000 down.sql only.';

CREATE TRIGGER "ScoutReconstructionLedger_platform_fence"
  BEFORE INSERT ON public."ScoutReconstructionLedger"
  FOR EACH ROW EXECUTE FUNCTION public.scout_ledger_platform_fence();
COMMENT ON TRIGGER "ScoutReconstructionLedger_platform_fence" ON public."ScoutReconstructionLedger" IS
  'G2-B obsolete-writer fence: platform-unaware (O) ledger INSERTs fail with check_violation. UPDATEs are not fenced.';
COMMIT;
