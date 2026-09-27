-- Reverse of 20270124000000_scout_run_observation_expand (G2-S10-B).
-- Disposable/pre-use only. Returns the catalog to the accepted S7-L1 (+S8-B) shape: drops ONLY
-- the three S10 run tables (ScoutRunDeclaration, ScoutRunObservation, ScoutRunSettledBasis, with
-- their own keys, constraints, FKs, triggers and policies) and the two trigger functions this
-- expand created. ScoutImport, its rows, keys, RLS flags and policies are untouched. Refuses to
-- erase even one recorded declaration, observation or settled basis: once any row exists in any
-- of the three tables the schema is retained and repair is forward-only (same doctrine as the C1,
-- S7-L1 and S8-B downs; S7L-DOC L273). Refuses when S10-B is absent or not exactly as shipped, so
-- raw reruns fail atomically; the recorded migration history is not rewritten here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Do not certify emptiness from an RLS-filtered view, even for a table owner.
-- This setting rejects filtered queries; it does not disable or bypass RLS.
SET LOCAL row_security = off;

DO $$
BEGIN
  -- S10-B exactly as shipped. Presence is tested first (by name, no regclass cast) so a pre-S10-B
  -- database or a rerun receives this fixed text, not a raw undefined-table error; the table
  -- locks are taken only once the relations are known to exist.
  IF (
    SELECT count(*) FROM pg_catalog.pg_class t
    WHERE t.oid IN (to_regclass('public."ScoutRunDeclaration"'), to_regclass('public."ScoutRunObservation"'),
                    to_regclass('public."ScoutRunSettledBasis"'))
      AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
  ) <> 3 OR to_regprocedure('public.scout_run_observation_insert_only()') IS NULL
    OR to_regprocedure('public.scout_run_declaration_one_challenge()') IS NULL THEN
    RAISE EXCEPTION 'G2-S10B observation tables absent';
  END IF;
  LOCK TABLE public."ScoutRunObservation", public."ScoutRunDeclaration", public."ScoutRunSettledBasis"
    IN ACCESS EXCLUSIVE MODE;
  IF (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f' AND c.convalidated
      AND c.confrelid IN (to_regclass('public."ScoutImport"'), to_regclass('public."ScoutRunDeclaration"'))
      AND c.conname IN ('ScoutRunDeclaration_coach_id_intent_id_fkey', 'ScoutRunObservation_coach_id_intent_id_fkey',
                        'ScoutRunObservation_declaration_fkey', 'ScoutRunSettledBasis_coach_id_intent_id_fkey')
  ) <> 4 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = to_regclass('public."ScoutRunObservation_unit_key"')
      AND i.indrelid = 'public."ScoutRunObservation"'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ScoutRunObservation_unit_key" ON public."ScoutRunObservation" USING btree (coach_id, intent_id, execution_epoch, source_platform, account_scope_id_digest, family)'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_trigger g
    WHERE NOT g.tgisinternal
      AND g.tgrelid IN ('public."ScoutRunDeclaration"'::regclass, 'public."ScoutRunObservation"'::regclass,
                        'public."ScoutRunSettledBasis"'::regclass)
      AND g.tgname IN ('ScoutRunDeclaration_one_challenge', 'ScoutRunDeclaration_insert_only',
                       'ScoutRunDeclaration_no_truncate', 'ScoutRunObservation_insert_only',
                       'ScoutRunObservation_no_truncate', 'ScoutRunSettledBasis_insert_only',
                       'ScoutRunSettledBasis_no_truncate')
  ) <> 7 OR (
    SELECT count(*) FROM pg_catalog.pg_policy p
    WHERE p.polrelid IN ('public."ScoutRunDeclaration"'::regclass, 'public."ScoutRunObservation"'::regclass,
                         'public."ScoutRunSettledBasis"'::regclass)
  ) <> 9 THEN
    RAISE EXCEPTION 'G2-S10B observation tables absent';
  END IF;
  -- Refuse to erase recorded S10 facts. Fixed, identifier-free text; nothing is named.
  IF EXISTS (SELECT 1 FROM public."ScoutRunDeclaration")
    OR EXISTS (SELECT 1 FROM public."ScoutRunObservation")
    OR EXISTS (SELECT 1 FROM public."ScoutRunSettledBasis") THEN
    RAISE EXCEPTION 'Run declaration or observation state exists; retain schema and use compatible forward repair';
  END IF;
END $$;

-- No CASCADE: any dependent object makes the drop refuse atomically. Policies, indexes, triggers,
-- FKs and CHECKs of each table go with it; the observation table goes first (it references the
-- declaration table).
DROP TABLE public."ScoutRunObservation";
DROP TABLE public."ScoutRunDeclaration";
DROP TABLE public."ScoutRunSettledBasis";
DROP FUNCTION public.scout_run_declaration_one_challenge();
DROP FUNCTION public.scout_run_observation_insert_only();
COMMIT;
