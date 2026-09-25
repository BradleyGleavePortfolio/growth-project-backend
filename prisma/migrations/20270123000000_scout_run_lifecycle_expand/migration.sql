-- G2-S7-L1 only: the server-owned import run lifecycle expand
-- (docs/decisions/2026-09-24-s7l-run-lifecycle.md D-S7L-1..5, §4 invariants 2, 4, 7).
-- Additive and metadata-only on ScoutImport: ten nullable-or-defaulted columns
-- (mode, import_intent_id, phase, accepted_start_at, deadline_at, last_observed_at,
-- execution_epoch, fenced_at, fence_reason, reason_code), four closed CHECKs (mode, phase,
-- fence_reason, and the mode-shape CHECK that binds a server run to its intent, its
-- server-owned clock and the server terminal vocabulary while every legacy row keeps the
-- legacy vocabulary), one partial unique index on import_intent_id (at most one run per
-- setup intent) and one composite owner-scoped FK to ImportIntent(id, coach_id)
-- (ON DELETE RESTRICT: the intent cannot be deleted while its run exists; ON UPDATE
-- CASCADE). No data is rewritten, renamed or dropped: every existing row is
-- mode='legacy', execution_epoch=1 and every other lifecycle column NULL by default.
-- ScoutImport RLS (ENABLE+FORCE, the three 20261223000100 policies) and both existing
-- indexes are untouched; the existing policies cover the new columns. NOT a
-- writer/reader/route change by itself: S7-L2 is the first code that writes mode='server'.
-- Separate release artifact; own promotion stage after C (D-C2); order-independent of
-- 20270122000000 (S8-B).
--
-- Entry gate (refuses, never derives, deletes or repairs): the accepted ScoutImport shape
-- (RLS enabled+forced, the (coach_id, intent_id) unique key exactly as shipped,
-- state NOT NULL TEXT, terminal_status nullable TEXT, completed_at nullable
-- TIMESTAMP(3)), the C1 FK target ImportIntent(id, coach_id) exactly as shipped, and none
-- of the objects this file creates (raw rerun, partial state or a decoy holding one of the
-- names). Raw reruns fail atomically.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutImport" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public."ImportIntent" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  -- Accepted run identity: the (coach_id, intent_id) key on an RLS-forced table, exactly as shipped.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    WHERE i.indexrelid = to_regclass('public."ScoutImport_coach_id_intent_id_key"')
      AND i.indrelid = to_regclass('public."ScoutImport"')
      AND t.relkind = 'r' AND t.relrowsecurity AND t.relforcerowsecurity
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
      AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ScoutImport_coach_id_intent_id_key" ON public."ScoutImport" USING btree (coach_id, intent_id)'
  ) THEN
    RAISE EXCEPTION 'G2-S7L unexpected run identity prerequisite';
  END IF;
  -- Run lifecycle columns exactly as shipped: state NOT NULL TEXT, terminal_status nullable TEXT
  -- without default, completed_at nullable TIMESTAMP(3) without default, coach_id NOT NULL TEXT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'state'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'terminal_status'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'completed_at'
      AND NOT a.attisdropped AND a.atttypid = 'timestamp'::regtype AND a.atttypmod = 3
      AND NOT a.attnotnull AND NOT a.atthasdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'coach_id'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-S7L unexpected run column prerequisite';
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
    RAISE EXCEPTION 'G2-S7L unexpected intent prerequisite';
  END IF;
  -- Nothing this file creates may already exist under its name: refused, never dropped or adopted.
  IF to_regclass('public."ScoutImport_import_intent_id_key"') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conname IN ('ScoutImport_mode_check',
                        'ScoutImport_phase_check',
                        'ScoutImport_fence_reason_check',
                        'ScoutImport_mode_shape_check',
                        'ScoutImport_import_intent_id_coach_id_fkey')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public."ScoutImport"'::regclass AND NOT a.attisdropped
        AND a.attname IN ('mode', 'import_intent_id', 'phase', 'accepted_start_at', 'deadline_at',
                          'last_observed_at', 'execution_epoch', 'fenced_at', 'fence_reason', 'reason_code')
    ) THEN
    RAISE EXCEPTION 'G2-S7L run lifecycle already present';
  END IF;
END $$;

-- Lifecycle columns (D-S7L-1, D-S7L-3, D-S7L-4, D-S7L-5). Every default is a constant, so the
-- ADD COLUMN is metadata-only (PG 11+): no rewrite of the existing rows, which become
-- mode='legacy', execution_epoch=1, everything else NULL.
ALTER TABLE public."ScoutImport"
  ADD COLUMN "mode"              TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "import_intent_id"  UUID,
  ADD COLUMN "phase"             TEXT,
  ADD COLUMN "accepted_start_at" TIMESTAMP(3),
  ADD COLUMN "deadline_at"       TIMESTAMP(3),
  ADD COLUMN "last_observed_at"  TIMESTAMP(3),
  ADD COLUMN "execution_epoch"   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "fenced_at"         TIMESTAMP(3),
  ADD COLUMN "fence_reason"      TEXT,
  ADD COLUMN "reason_code"       TEXT;

-- Closed vocabularies (D-S7L-1 modes; §3 phases; D-S7L-4 fence reasons). Adding a value is a
-- core change by design. reason_code is closed by src/scout/lifecycle/reason-codes.ts (the only
-- writer) and left as opaque TEXT here so an S9 verdict reason needs no schema change.
ALTER TABLE public."ScoutImport"
  ADD CONSTRAINT "ScoutImport_mode_check"
    CHECK ("mode" IN ('legacy', 'server')),
  ADD CONSTRAINT "ScoutImport_phase_check"
    CHECK ("phase" IS NULL OR "phase" IN ('discovering', 'transferring', 'reconciling')),
  ADD CONSTRAINT "ScoutImport_fence_reason_check"
    CHECK (("fenced_at" IS NULL) = ("fence_reason" IS NULL)
      AND ("fence_reason" IS NULL OR "fence_reason" IN ('cancelled', 'timed_out', 'revoked'))
      AND "execution_epoch" >= 1),
  -- Invariant 2 (CQ-18 legacy marker): `success` appears only on legacy rows, `complete` only on
  -- server rows; a server run always carries its intent, its server-owned clock and a deadline
  -- strictly after its accepted start; a legacy run never carries an intent binding.
  ADD CONSTRAINT "ScoutImport_mode_shape_check"
    CHECK (
      ("mode" = 'legacy'
        AND "import_intent_id" IS NULL
        AND ("terminal_status" IS NULL OR "terminal_status" IN ('success', 'partial', 'failed')))
      OR
      ("mode" = 'server'
        AND "import_intent_id" IS NOT NULL
        AND "accepted_start_at" IS NOT NULL
        AND "deadline_at" IS NOT NULL
        AND "deadline_at" > "accepted_start_at"
        AND ("terminal_status" IS NULL
          OR "terminal_status" IN ('complete', 'partial', 'blocked', 'failed', 'cancelled', 'timed_out')))
    );

-- Invariant 7: at most one run per setup intent. Partial so every legacy row (NULL) is free.
CREATE UNIQUE INDEX "ScoutImport_import_intent_id_key"
  ON public."ScoutImport" USING btree ("import_intent_id")
  WHERE "import_intent_id" IS NOT NULL;

-- Owner-scoped binding to the setup authority (C1 ImportIntent(id, coach_id)). RESTRICT: the intent
-- (and, through its cascade, the User row) cannot be hard-deleted while a server run exists (§8 L8
-- seam; the live erasure flow tombstones and never hard-deletes). The pair challenge cascades from
-- the intent, not from the run, so a run outlives challenge deletion.
ALTER TABLE public."ScoutImport"
  ADD CONSTRAINT "ScoutImport_import_intent_id_coach_id_fkey"
    FOREIGN KEY ("import_intent_id", "coach_id")
    REFERENCES public."ImportIntent" ("id", "coach_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
