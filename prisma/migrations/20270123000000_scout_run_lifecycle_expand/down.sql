-- Reverse of 20270123000000_scout_run_lifecycle_expand (G2-S7-L1).
-- Disposable/pre-use only. Returns ScoutImport to the accepted C (+S8-B) shape: drops ONLY
-- the composite FK, the partial unique index, the four lifecycle CHECK constraints and the ten
-- lifecycle columns this expand added. Every run row, every legacy value (state,
-- terminal_status, started_at, completed_at), the (coach_id, intent_id) key, the coach_id
-- index, the RLS flags and the three policies are untouched. Refuses to erase even one
-- recorded lifecycle fact: once any row is mode='server' OR carries any non-default lifecycle
-- value, the schema is retained and repair is forward-only (same doctrine as the C1 and S8-B
-- downs). Refuses when S7-L1 is absent or not exactly as shipped, so raw reruns fail
-- atomically; the recorded migration history is not rewritten here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Do not certify emptiness from an RLS-filtered view, even for a table owner.
-- This setting rejects filtered queries; it does not disable or bypass RLS.
SET LOCAL row_security = off;
LOCK TABLE public."ScoutImport" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  -- S7-L1 exactly as shipped: the ten columns with their shipped types, nullability and defaults,
  -- the four validated CHECKs, the validated composite FK to ImportIntent and the partial unique
  -- index. Anything else (absent, partial, decoy) is refused with this fixed text, so a pre-S7-L
  -- database or a rerun receives it, not a raw undefined-column error.
  IF (
    SELECT count(*) FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND NOT a.attisdropped
      AND (
        (a.attname = 'mode' AND a.atttypid = 'text'::regtype AND a.attnotnull
          AND pg_get_expr(d.adbin, d.adrelid) = '''legacy''::text')
        OR (a.attname = 'import_intent_id' AND a.atttypid = 'uuid'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'phase' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'accepted_start_at' AND a.atttypid = 'timestamp'::regtype AND a.atttypmod = 3
          AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'deadline_at' AND a.atttypid = 'timestamp'::regtype AND a.atttypmod = 3
          AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'last_observed_at' AND a.atttypid = 'timestamp'::regtype AND a.atttypmod = 3
          AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'execution_epoch' AND a.atttypid = 'int4'::regtype AND a.attnotnull
          AND pg_get_expr(d.adbin, d.adrelid) = '1')
        OR (a.attname = 'fenced_at' AND a.atttypid = 'timestamp'::regtype AND a.atttypmod = 3
          AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'fence_reason' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
        OR (a.attname = 'reason_code' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
      )
  ) <> 10 OR (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public."ScoutImport"'::regclass AND c.contype = 'c' AND c.convalidated
      AND c.conname IN ('ScoutImport_mode_check', 'ScoutImport_phase_check',
                        'ScoutImport_fence_reason_check', 'ScoutImport_mode_shape_check')
  ) <> 4 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public."ScoutImport"'::regclass AND c.contype = 'f' AND c.convalidated
      AND c.conname = 'ScoutImport_import_intent_id_coach_id_fkey'
      AND c.confrelid = to_regclass('public."ImportIntent"')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = to_regclass('public."ScoutImport_import_intent_id_key"')
      AND i.indrelid = 'public."ScoutImport"'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "ScoutImport_import_intent_id_key" ON public."ScoutImport" USING btree (import_intent_id) WHERE (import_intent_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'G2-S7L run lifecycle absent';
  END IF;
  -- Refuse to erase recorded lifecycle facts. Fixed, identifier-free text; nothing is named.
  IF EXISTS (
    SELECT 1 FROM public."ScoutImport"
    WHERE "mode" <> 'legacy'
      OR "import_intent_id" IS NOT NULL
      OR "phase" IS NOT NULL
      OR "accepted_start_at" IS NOT NULL
      OR "deadline_at" IS NOT NULL
      OR "last_observed_at" IS NOT NULL
      OR "execution_epoch" <> 1
      OR "fenced_at" IS NOT NULL
      OR "fence_reason" IS NOT NULL
      OR "reason_code" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Run lifecycle state exists; retain schema and use compatible forward repair';
  END IF;
END $$;

ALTER TABLE public."ScoutImport" DROP CONSTRAINT "ScoutImport_import_intent_id_coach_id_fkey";
DROP INDEX public."ScoutImport_import_intent_id_key";
ALTER TABLE public."ScoutImport" DROP CONSTRAINT "ScoutImport_mode_shape_check";
ALTER TABLE public."ScoutImport" DROP CONSTRAINT "ScoutImport_fence_reason_check";
ALTER TABLE public."ScoutImport" DROP CONSTRAINT "ScoutImport_phase_check";
ALTER TABLE public."ScoutImport" DROP CONSTRAINT "ScoutImport_mode_check";
-- No CASCADE: any dependent object makes the drop refuse atomically.
ALTER TABLE public."ScoutImport"
  DROP COLUMN "reason_code",
  DROP COLUMN "fence_reason",
  DROP COLUMN "fenced_at",
  DROP COLUMN "execution_epoch",
  DROP COLUMN "last_observed_at",
  DROP COLUMN "deadline_at",
  DROP COLUMN "accepted_start_at",
  DROP COLUMN "phase",
  DROP COLUMN "import_intent_id",
  DROP COLUMN "mode";
COMMIT;
