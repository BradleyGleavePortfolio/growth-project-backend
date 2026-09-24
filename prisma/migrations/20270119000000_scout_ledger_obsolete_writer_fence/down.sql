-- Reverse of 20270119000000_scout_ledger_obsolete_writer_fence (G2-B).
-- Removes ONLY the fence trigger and its function. The nullable E column, every
-- ledger row and every assigned provenance value are retained; nothing is
-- derived, deleted or reset. Re-admitting platform-unaware writers voids any
-- completed drain evidence: a backfill "drained" report predates this down and
-- must be re-established after a later re-apply before R is considered.
-- Refuses when the fence is absent or not exactly as shipped (raw reruns fail).
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
        AND pg_get_indexdef(i.indexrelid) = format(
          'CREATE UNIQUE INDEX %I ON public.%I USING btree (%s)',
          prerequisite.index_name::name, prerequisite.table_name, prerequisite.columns)
    ) THEN
      RAISE EXCEPTION 'G2-B unexpected identity prerequisite';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND a.attname = 'source_platform' AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND NOT a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-B unexpected platform column prerequisite';
  END IF;
  -- Structural identity, independent of the session search_path (pg_get_triggerdef drops the
  -- function's schema whenever search_path makes it visible, so its text is not compared):
  -- exact table + trigger name, function public.scout_ledger_platform_fence() with zero
  -- arguments, BEFORE INSERT FOR EACH ROW (tgtype 7), no WHEN clause, no column list, no
  -- arguments, not a constraint trigger, not SECURITY DEFINER. to_regprocedure is NULL when the
  -- function is absent, so a genuinely absent fence reaches the RAISE below without an error.
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
      AND t.tgattr::int2[] = '{}'::int2[]
      AND t.tgnargs = 0
      AND t.tgconstraint = 0
  ) THEN
    RAISE EXCEPTION 'G2-B fence absent';
  END IF;
END $$;

DROP TRIGGER "ScoutReconstructionLedger_platform_fence" ON public."ScoutReconstructionLedger";
DROP FUNCTION public.scout_ledger_platform_fence();
COMMIT;
