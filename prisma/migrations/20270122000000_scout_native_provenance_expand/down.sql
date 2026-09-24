-- Reverse of 20270122000000_scout_native_provenance_expand (G2-S8-B).
-- Disposable/pre-use only. Returns the catalog to the accepted N/Q1 (+C) shape: drops
-- ONLY the two ledger target_kind CHECK constraints, the ledger target_kind column and
-- the ImportNativeProvenance table (with its own indexes, constraints, FK and policies).
-- Every ledger row, every ledger value, both ledger identity keys, the canonical CHECK,
-- the ledger RLS flags and its three policies are untouched. Refuses to erase even one
-- recorded native provenance fact: once any ImportNativeProvenance row exists OR any
-- ledger row carries a typed target, the schema is retained and repair is forward-only
-- (same doctrine as the C1 and S7-L1 downs). Refuses when S8-B is absent or not exactly
-- as shipped, so raw reruns fail atomically; the recorded migration history is not
-- rewritten here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Do not certify emptiness from an RLS-filtered view, even for a table owner.
-- This setting rejects filtered queries; it does not disable or bypass RLS.
SET LOCAL row_security = off;
LOCK TABLE public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  -- S8-B exactly as shipped: the provenance table (RLS enabled+forced) with its four validated
  -- CHECKs, its validated composite FK to ImportIntent, its identity key and two indexes, its
  -- three policies; the ledger target_kind column with both validated CHECKs. Anything else
  -- (absent, partial, decoy) is refused. The table's presence is tested first (by name, no
  -- regclass cast) so a pre-S8-B database or a rerun receives this fixed text, not a raw
  -- undefined-table error; the table lock is taken only once the relation is known to exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class t
    WHERE t.oid = to_regclass('public."ImportNativeProvenance"')
      AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'G2-S8B provenance absent';
  END IF;
  LOCK TABLE public."ImportNativeProvenance" IN ACCESS EXCLUSIVE MODE;
  IF (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public."ImportNativeProvenance"'::regclass AND c.contype = 'c' AND c.convalidated
      AND c.conname IN ('ImportNativeProvenance_native_kind_check', 'ImportNativeProvenance_outcome_check',
                        'ImportNativeProvenance_native_id_shape_check', 'ImportNativeProvenance_unresolved_reason_check')
  ) <> 4 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public."ImportNativeProvenance"'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.conname = 'ImportNativeProvenance_import_intent_id_coach_id_fkey'
      AND c.confrelid = to_regclass('public."ImportIntent"')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = to_regclass('public."ImportNativeProvenance_identity_key"')
      AND i.indrelid = 'public."ImportNativeProvenance"'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ImportNativeProvenance_identity_key" ON public."ImportNativeProvenance" USING btree (coach_id, source_namespace, entity_type, source_id)'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_index i
    WHERE i.indrelid = 'public."ImportNativeProvenance"'::regclass AND i.indisvalid
      AND i.indexrelid IN (to_regclass('public."ImportNativeProvenance_coach_id_native_kind_native_id_idx"'),
                           to_regclass('public."ImportNativeProvenance_coach_id_import_intent_id_idx"'))
  ) <> 2 OR (
    SELECT count(*) FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public."ImportNativeProvenance"'::regclass
      AND p.polname IN ('p_import_native_provenance_service_role_all', 'deny_all_anon_import_native_provenance',
                        'deny_all_authenticated_import_native_provenance')
  ) <> 3 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass AND a.attname = 'target_kind'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public."ScoutReconstructionLedger"'::regclass AND c.contype = 'c' AND c.convalidated
      AND c.conname IN ('ScoutReconstructionLedger_target_kind_check', 'ScoutReconstructionLedger_target_kind_shape_check')
  ) <> 2 THEN
    RAISE EXCEPTION 'G2-S8B provenance absent';
  END IF;
  -- Refuse to erase recorded native provenance facts. Fixed, identifier-free text; nothing is named.
  IF EXISTS (SELECT 1 FROM public."ImportNativeProvenance")
    OR EXISTS (SELECT 1 FROM public."ScoutReconstructionLedger" WHERE "target_kind" IS NOT NULL) THEN
    RAISE EXCEPTION 'Native provenance state exists; retain schema and use compatible forward repair';
  END IF;
END $$;

ALTER TABLE public."ScoutReconstructionLedger" DROP CONSTRAINT "ScoutReconstructionLedger_target_kind_shape_check";
ALTER TABLE public."ScoutReconstructionLedger" DROP CONSTRAINT "ScoutReconstructionLedger_target_kind_check";
ALTER TABLE public."ScoutReconstructionLedger" DROP COLUMN "target_kind";
-- No CASCADE: any dependent object makes the drop refuse atomically. Policies, indexes, the FK
-- and the CHECKs of the table go with it.
DROP TABLE public."ImportNativeProvenance";
COMMIT;
