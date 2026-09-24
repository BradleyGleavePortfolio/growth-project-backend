-- G2-S8-B only: the native provenance ledger expand
-- (docs/decisions/2026-09-24-s8-native-contract.md §3.3, D-S8-3). Additive and
-- metadata-only: ONE new table ImportNativeProvenance keyed on the D-S8-3 identity
-- (coach_id, source_namespace, entity_type, source_id), with closed CHECKs on
-- native_kind and outcome, native_id NULL exactly when outcome = 'unresolved', a
-- reason on every unresolved record, and a composite owner-scoped FK to
-- ImportIntent(id, coach_id) (nullable until S7-L L4 binds Scout runs to server
-- intents); plus ONE nullable column ScoutReconstructionLedger.target_kind with a
-- closed CHECK, so a ledger target is typed without adding columns to every native
-- table (CQ-14). No data is rewritten, renamed or dropped; every existing ledger row
-- keeps target_kind NULL. Ledger RLS (ENABLE+FORCE, the three 20261223000200
-- policies), both identity keys, the canonical CHECK and the NOT NULL provenance
-- are untouched. NOT a writer/reader/route change: the N/Q1 (+C) writer keeps
-- upserting the five-field ledger identity and never names target_kind; S8-C is the
-- first code that writes a provenance row. Separate release artifact; own
-- promotion stage after C (D-C2); order-independent of 20270123000000 (S7-L1).
--
-- Entry gate (refuses, never derives, deletes or repairs): the accepted ledger
-- shape (RLS enabled+forced, the R wide identity key and canonical CHECK exactly
-- as shipped, source_platform NOT NULL TEXT, status NOT NULL TEXT, target_id
-- nullable TEXT without default), the C1 FK target ImportIntent(id, coach_id)
-- exactly as shipped, and none of the objects this file creates (raw rerun,
-- partial state or a decoy holding one of the names). Raw reruns fail atomically.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."ImportIntent" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  -- Accepted ledger identity: the R wide key on an RLS-forced table, exactly as shipped, and the
  -- validated canonical CHECK keyed on source_platform alone.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    WHERE i.indexrelid = to_regclass('public."ScoutReconstructionLedger_identity_key"')
      AND i.indrelid = to_regclass('public."ScoutReconstructionLedger"')
      AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
      AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ScoutReconstructionLedger_identity_key" ON public."ScoutReconstructionLedger" USING btree (coach_id, intent_id, entity_type, source_platform, source_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'source_platform'
    WHERE c.conname = 'ScoutReconstructionLedger_source_platform_canonical'
      AND c.conrelid = 'public."ScoutReconstructionLedger"'::regclass
      AND c.contype = 'c' AND c.convalidated AND c.conkey = ARRAY[a.attnum]
  ) THEN
    RAISE EXCEPTION 'G2-S8B unexpected ledger identity prerequisite';
  END IF;
  -- Ledger outcome columns exactly as shipped: status NOT NULL TEXT, target_id nullable TEXT
  -- without default, source_platform NOT NULL TEXT (R).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass AND a.attname = 'status'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass AND a.attname = 'target_id'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass AND a.attname = 'source_platform'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-S8B unexpected ledger column prerequisite';
  END IF;
  -- C1 FK target exactly as shipped: ImportIntent(id uuid, coach_id text) with its unique key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    WHERE i.indexrelid = to_regclass('public."ImportIntent_id_coach_id_key"')
      AND i.indrelid = to_regclass('public."ImportIntent"')
      AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
      AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ImportIntent_id_coach_id_key" ON public."ImportIntent" USING btree (id, coach_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ImportIntent"'::regclass AND a.attname = 'id'
      AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ImportIntent"'::regclass AND a.attname = 'coach_id'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-S8B unexpected intent prerequisite';
  END IF;
  -- Nothing this file creates may already exist under its name: refused, never dropped or adopted.
  IF to_regclass('public."ImportNativeProvenance"') IS NOT NULL
    OR to_regclass('public."ImportNativeProvenance_pkey"') IS NOT NULL
    OR to_regclass('public."ImportNativeProvenance_identity_key"') IS NOT NULL
    OR to_regclass('public."ImportNativeProvenance_coach_id_native_kind_native_id_idx"') IS NOT NULL
    OR to_regclass('public."ImportNativeProvenance_coach_id_import_intent_id_idx"') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conname IN ('ImportNativeProvenance_pkey',
                        'ImportNativeProvenance_native_kind_check',
                        'ImportNativeProvenance_outcome_check',
                        'ImportNativeProvenance_native_id_shape_check',
                        'ImportNativeProvenance_unresolved_reason_check',
                        'ImportNativeProvenance_import_intent_id_coach_id_fkey',
                        'ScoutReconstructionLedger_target_kind_check',
                        'ScoutReconstructionLedger_target_kind_shape_check')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public."ScoutReconstructionLedger"'::regclass AND NOT a.attisdropped
        AND a.attname = 'target_kind'
    ) THEN
    RAISE EXCEPTION 'G2-S8B provenance already present';
  END IF;
END $$;

-- The native provenance ledger (contract §3.3). One record per native row written (top-level or
-- nested child, outcome created) and one per unresolved nested child (native_id NULL, outcome
-- unresolved, §3.7 reason). Identity is the D-S8-3 key; source_namespace equals source_platform
-- until G3 attribution lands and is an opaque string here (no format CHECK, never parsed).
-- source_id is unbounded TEXT: wide enough for the injective child encoding
-- `<n>:<parent source_id>#id:<child id>` / `<n>:<parent source_id>#ord:<ordinal>`.
-- Audit columns keep database defaults (source timestamps are never written here, §3.3).
CREATE TABLE public."ImportNativeProvenance" (
  "id"               TEXT NOT NULL,
  "coach_id"         TEXT NOT NULL,
  "import_intent_id" UUID,
  "source_namespace" TEXT NOT NULL,
  "entity_type"      TEXT NOT NULL,
  "source_id"        TEXT NOT NULL,
  "native_kind"      TEXT NOT NULL,
  "native_id"        TEXT,
  "outcome"          TEXT NOT NULL,
  "reason"           TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportNativeProvenance_pkey" PRIMARY KEY ("id"),
  -- Closed vocabularies (contract §3.3 minimum native_kind set; §3.2 outcomes). Adding a native
  -- kind is a core change by design.
  CONSTRAINT "ImportNativeProvenance_native_kind_check"
    CHECK ("native_kind" IN ('person', 'scout_entity', 'workout_program', 'workout_plan', 'workout_plan_exercise')),
  CONSTRAINT "ImportNativeProvenance_outcome_check"
    CHECK ("outcome" IN ('created', 'already_present', 'unresolved')),
  -- A2 closure: native_id is NULL exactly when the outcome is unresolved.
  CONSTRAINT "ImportNativeProvenance_native_id_shape_check"
    CHECK (("native_id" IS NULL) = ("outcome" = 'unresolved')),
  -- Every unresolved record carries its §3.7 reason code.
  CONSTRAINT "ImportNativeProvenance_unresolved_reason_check"
    CHECK ("outcome" <> 'unresolved' OR "reason" IS NOT NULL),
  -- Composite owner-scoped FK (the C1 ExtensionPairCode / S7-L1 pattern): a bound intent must
  -- belong to the same coach and cannot vanish under its provenance. RESTRICT: provenance is a
  -- durable record; erasure is the L8 seam. Nullable until S7-L L4 binds Scout runs to intents.
  CONSTRAINT "ImportNativeProvenance_import_intent_id_coach_id_fkey"
    FOREIGN KEY ("import_intent_id", "coach_id") REFERENCES public."ImportIntent" ("id", "coach_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
-- D-S8-3 identity: the only arbiter of native provenance identity (replay converges on it, §3.4).
CREATE UNIQUE INDEX "ImportNativeProvenance_identity_key"
  ON public."ImportNativeProvenance" ("coach_id", "source_namespace", "entity_type", "source_id");
-- Reverse lookup by native target (S8-F readers, §3.5 identity_conflict / native_target_removed).
CREATE INDEX "ImportNativeProvenance_coach_id_native_kind_native_id_idx"
  ON public."ImportNativeProvenance" ("coach_id", "native_kind", "native_id");
-- Per-run counts (PLAN L248 created_native / already_present_verified / unresolved).
CREATE INDEX "ImportNativeProvenance_coach_id_import_intent_id_idx"
  ON public."ImportNativeProvenance" ("coach_id", "import_intent_id");

-- RLS: RESTRICTIVE deny-all to anon + authenticated with a service_role bypass, identical posture to
-- ScoutReconstructionLedger (20261223000200), plus the S1 belt-and-braces REVOKE of the API-role
-- table privileges Supabase's default privileges would otherwise grant. Native writers run
-- server-side as service_role; no client principal reads or writes provenance directly.
ALTER TABLE public."ImportNativeProvenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ImportNativeProvenance" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ImportNativeProvenance" FROM anon, authenticated;
CREATE POLICY "p_import_native_provenance_service_role_all" ON public."ImportNativeProvenance"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_import_native_provenance_service_role_all" ON public."ImportNativeProvenance" IS 'service_role bypass: native provenance is written/read only via the server-side native writers running as service_role.';
CREATE POLICY "deny_all_anon_import_native_provenance" ON public."ImportNativeProvenance"
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_import_native_provenance" ON public."ImportNativeProvenance" IS 'RESTRICTIVE deny-all: anon can never read/write native provenance regardless of any permissive policy.';
CREATE POLICY "deny_all_authenticated_import_native_provenance" ON public."ImportNativeProvenance"
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_import_native_provenance" ON public."ImportNativeProvenance" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write native provenance directly; only service_role may (no cross-tenant oracle).';

-- Typed ledger target (contract §3.2): created / already_present are ledger `reconstructed` with a
-- typed target. Nullable, no default: metadata-only, no row is rewritten, and the N/Q1 (+C) writer
-- (which never names the column) keeps inserting NULL. workout_plan_exercise is a child-only
-- native_kind and is deliberately not a ledger target.
ALTER TABLE public."ScoutReconstructionLedger" ADD COLUMN "target_kind" TEXT;
ALTER TABLE public."ScoutReconstructionLedger"
  ADD CONSTRAINT "ScoutReconstructionLedger_target_kind_check"
  CHECK ("target_kind" IS NULL OR "target_kind" IN ('person', 'scout_entity', 'workout_program', 'workout_plan'));
-- A kind without a target is meaningless: target_kind is set only beside a target_id.
ALTER TABLE public."ScoutReconstructionLedger"
  ADD CONSTRAINT "ScoutReconstructionLedger_target_kind_shape_check"
  CHECK ("target_kind" IS NULL OR "target_id" IS NOT NULL);
COMMIT;
