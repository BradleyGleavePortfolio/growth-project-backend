-- G2-S10-B only: the run declaration / observation evidence / settled basis expand
-- (docs/decisions/2026-09-26-s10-induction.md D-S10-2, D-S10-4; acceptance R29-R32).
-- Additive: THREE new insert-only tables, each keyed by the bearer's coach_id and bound by a
-- composite FK (coach_id, intent_id) -> ScoutImport(coach_id, intent_id), so a row for another
-- coach's intent is unrepresentable:
--   ScoutRunDeclaration   the run's immutable authorized platform/scope set and its ONE shared
--                         32-byte challenge (identical challenge and declared_at per run: trigger)
--   ScoutRunObservation   one validated ObservationEvidenceV1 per (epoch, platform, scope, family)
--   ScoutRunSettledBasis  the settle-time report (written by S10-C only; schema-only here)
-- Deletion posture (D-S10-4 "Deletion", findings 4 / B-2): UPDATE, DELETE and TRUNCATE are
-- revoked from every runtime role (anon, authenticated, service_role; service_role keeps SELECT
-- and INSERT only); a BEFORE UPDATE OR DELETE row trigger refuses every UPDATE and every
-- top-level (pg_trigger_depth() = 1) DELETE; a BEFORE TRUNCATE trigger refuses TRUNCATE. A parent
-- run delete removes the children by ON DELETE CASCADE: referential cleanup only, for a parent run
-- deleted under a separately authorized L8 policy; NOT a retention or erasure authorization (Q3).
-- Depth > 1 is a nesting test, not proof of an FK action: a nested DELETE by a privileged
-- (owner/superuser) trigger is not excluded and is reserved to database governance. Today the run
-- is RESTRICT-bound to its intent and erasure tombstones the User, so every row stays in place.
-- RLS copies the ImportNativeProvenance set exactly (20270122000000 L168-182): ENABLE + FORCE,
-- one service_role policy, RESTRICTIVE deny-all for anon and authenticated. No existing table,
-- column, index, constraint, policy or row is changed. NOT a writer change by itself: the S10-B
-- routes are the first code that writes a declaration or observation row; S10-C the first basis.
-- Separate release artifact; applies after 20270123000000 (S7-L1), whose run key it references.
--
-- Entry gate (refuses, never derives, deletes or repairs): the accepted ScoutImport run identity
-- (RLS enabled+forced, the (coach_id, intent_id) key exactly as shipped, coach_id / intent_id
-- NOT NULL TEXT, S7-L1's execution_epoch present) and none of the objects this file creates (raw
-- rerun, partial state or a decoy holding one of the names). Raw reruns fail atomically.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutImport" IN SHARE ROW EXCLUSIVE MODE;

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
    RAISE EXCEPTION 'G2-S10B unexpected run identity prerequisite';
  END IF;
  -- Run key columns exactly as shipped, and S7-L1's epoch (the observation binding) present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'coach_id'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'intent_id'
      AND NOT a.attisdropped AND a.atttypid = 'text'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public."ScoutImport"'::regclass AND a.attname = 'execution_epoch'
      AND NOT a.attisdropped AND a.atttypid = 'int4'::regtype AND a.attnotnull
  ) THEN
    RAISE EXCEPTION 'G2-S10B unexpected run column prerequisite';
  END IF;
  -- Nothing this file creates may already exist under its name: refused, never dropped or adopted.
  IF to_regclass('public."ScoutRunDeclaration"') IS NOT NULL
    OR to_regclass('public."ScoutRunObservation"') IS NOT NULL
    OR to_regclass('public."ScoutRunSettledBasis"') IS NOT NULL
    OR to_regclass('public."ScoutRunDeclaration_pkey"') IS NOT NULL
    OR to_regclass('public."ScoutRunObservation_pkey"') IS NOT NULL
    OR to_regclass('public."ScoutRunObservation_unit_key"') IS NOT NULL
    OR to_regclass('public."ScoutRunSettledBasis_pkey"') IS NOT NULL
    OR to_regprocedure('public.scout_run_observation_insert_only()') IS NOT NULL
    OR to_regprocedure('public.scout_run_declaration_one_challenge()') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conname LIKE ANY (ARRAY['ScoutRunDeclaration\_%', 'ScoutRunObservation\_%', 'ScoutRunSettledBasis\_%'])
    ) THEN
    RAISE EXCEPTION 'G2-S10B observation tables already present';
  END IF;
END $$;

-- D-S10-2 run declaration. One row per declared (platform, scope); the whole set is inserted in
-- one transaction under the run lock (S10-B service). account_scope_id_digest is sha256 hex of the
-- source's scope id, never the raw id. challenge is the ONE server-generated 32-byte challenge.
CREATE TABLE public."ScoutRunDeclaration" (
  "coach_id"                TEXT NOT NULL,
  "intent_id"               TEXT NOT NULL,
  "source_platform"         TEXT NOT NULL,
  "account_scope_id_digest" TEXT NOT NULL,
  "challenge"               BYTEA NOT NULL,
  "declared_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScoutRunDeclaration_pkey"
    PRIMARY KEY ("coach_id", "intent_id", "source_platform", "account_scope_id_digest"),
  CONSTRAINT "ScoutRunDeclaration_source_platform_canonical"
    CHECK ("source_platform" COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'),
  CONSTRAINT "ScoutRunDeclaration_scope_digest_check"
    CHECK ("account_scope_id_digest" COLLATE "C" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ScoutRunDeclaration_challenge_check"
    CHECK (octet_length("challenge") = 32),
  -- Composite owner-scoped FK to the run key: another coach's intent is unrepresentable.
  -- ON DELETE CASCADE is referential cleanup only (D-S10-4); ON UPDATE RESTRICT (the run key never moves).
  CONSTRAINT "ScoutRunDeclaration_coach_id_intent_id_fkey"
    FOREIGN KEY ("coach_id", "intent_id") REFERENCES public."ScoutImport" ("coach_id", "intent_id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

-- D-S10-2 observation evidence. One validated upload per (epoch, platform, scope, family); the
-- server-bound columns (coach_id from the bearer, execution_epoch read under the run lock,
-- received_at, evidence_digest) are never client-supplied. The unit must be declared (FK).
CREATE TABLE public."ScoutRunObservation" (
  "id"                      TEXT NOT NULL,
  "coach_id"                TEXT NOT NULL,
  "intent_id"               TEXT NOT NULL,
  "execution_epoch"         INTEGER NOT NULL,
  "source_platform"         TEXT NOT NULL,
  "account_scope_id_digest" TEXT NOT NULL,
  "family"                  TEXT NOT NULL,
  "basis_kind"              TEXT NOT NULL,
  "evidence"                JSONB NOT NULL,
  "evidence_digest"         CHAR(64) NOT NULL,
  "received_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScoutRunObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScoutRunObservation_epoch_check" CHECK ("execution_epoch" >= 1),
  CONSTRAINT "ScoutRunObservation_source_platform_canonical"
    CHECK ("source_platform" COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$'),
  CONSTRAINT "ScoutRunObservation_scope_digest_check"
    CHECK ("account_scope_id_digest" COLLATE "C" ~ '^[0-9a-f]{64}$'),
  -- Closed vocabularies: the four canonical families; COMPLETENESS_BASIS_KINDS minus 'none'
  -- (append-only; adding a kind is a core change by design).
  CONSTRAINT "ScoutRunObservation_family_check"
    CHECK ("family" IN ('clients', 'workouts', 'client_history', 'programs')),
  CONSTRAINT "ScoutRunObservation_basis_kind_check"
    CHECK ("basis_kind" IN ('source_signed_enumeration')),
  CONSTRAINT "ScoutRunObservation_evidence_check" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "ScoutRunObservation_evidence_digest_check"
    CHECK ("evidence_digest" COLLATE "C" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ScoutRunObservation_coach_id_intent_id_fkey"
    FOREIGN KEY ("coach_id", "intent_id") REFERENCES public."ScoutImport" ("coach_id", "intent_id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ScoutRunObservation_declaration_fkey"
    FOREIGN KEY ("coach_id", "intent_id", "source_platform", "account_scope_id_digest")
    REFERENCES public."ScoutRunDeclaration" ("coach_id", "intent_id", "source_platform", "account_scope_id_digest")
    ON DELETE CASCADE ON UPDATE RESTRICT
);
-- At most one evidence row per unit and epoch (E2 "exactly one evidence row").
CREATE UNIQUE INDEX "ScoutRunObservation_unit_key"
  ON public."ScoutRunObservation"
  ("coach_id", "intent_id", "execution_epoch", "source_platform", "account_scope_id_digest", "family");

-- D-S10-4 settled basis (S10-C writes it in the settle transaction after writeTerminal).
CREATE TABLE public."ScoutRunSettledBasis" (
  "coach_id"            TEXT NOT NULL,
  "intent_id"           TEXT NOT NULL,
  "execution_epoch"     INTEGER NOT NULL,
  "report_version"      INTEGER NOT NULL,
  "report"              JSONB NOT NULL,
  "observation_digests" TEXT[] NOT NULL,
  "settled_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScoutRunSettledBasis_pkey" PRIMARY KEY ("coach_id", "intent_id"),
  CONSTRAINT "ScoutRunSettledBasis_epoch_check" CHECK ("execution_epoch" >= 1),
  CONSTRAINT "ScoutRunSettledBasis_report_version_check" CHECK ("report_version" >= 1),
  CONSTRAINT "ScoutRunSettledBasis_report_check" CHECK (jsonb_typeof("report") = 'object'),
  CONSTRAINT "ScoutRunSettledBasis_observation_digests_check"
    CHECK (array_position("observation_digests", NULL) IS NULL
      AND array_to_string("observation_digests", ',') COLLATE "C" ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  CONSTRAINT "ScoutRunSettledBasis_coach_id_intent_id_fkey"
    FOREIGN KEY ("coach_id", "intent_id") REFERENCES public."ScoutImport" ("coach_id", "intent_id")
    ON DELETE CASCADE ON UPDATE RESTRICT
);

-- Insert-only guard for all three tables. Refuses, never repairs. Every UPDATE is refused (the
-- FKs are ON UPDATE RESTRICT, so no referential action ever needs one); a DELETE is refused at
-- top level (pg_trigger_depth() = 1) and passes only when nested (a parent-run ON DELETE CASCADE,
-- or a privileged nested trigger reserved to database governance, D-S10-4); TRUNCATE is refused.
CREATE FUNCTION public.scout_run_observation_insert_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND pg_trigger_depth() = 1) THEN
    RAISE EXCEPTION 'G2-S10B insert-only: % on % refused', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
-- Not SECURITY DEFINER; trigger firing needs no EXECUTE grant, so nothing is callable.
REVOKE ALL ON FUNCTION public.scout_run_observation_insert_only() FROM PUBLIC;
COMMENT ON FUNCTION public.scout_run_observation_insert_only() IS
  'G2-S10B: refuses UPDATE, top-level DELETE and TRUNCATE on the three S10 run tables; nested DELETE (parent-run cascade) passes. Removed by 20270124000000 down.sql only.';

-- One statement per run: every declaration row of a run carries the same challenge and
-- declared_at. The run row is locked first (FOR NO KEY UPDATE, re-entrant for the S10-B writer
-- that already holds it), so two concurrent declarers serialise instead of both passing the check.
CREATE FUNCTION public.scout_run_declaration_one_challenge() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public."ScoutImport" r
    WHERE r.coach_id = NEW.coach_id AND r.intent_id = NEW.intent_id
    FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM public."ScoutRunDeclaration" d
    WHERE d.coach_id = NEW.coach_id AND d.intent_id = NEW.intent_id
      AND (d.challenge <> NEW.challenge OR d.declared_at <> NEW.declared_at)
  ) THEN
    RAISE EXCEPTION 'G2-S10B declaration challenge differs within one run'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.scout_run_declaration_one_challenge() FROM PUBLIC;
COMMENT ON FUNCTION public.scout_run_declaration_one_challenge() IS
  'G2-S10B: refuses a ScoutRunDeclaration row whose challenge or declared_at differs from the run''s existing rows. Removed by 20270124000000 down.sql only.';

CREATE TRIGGER "ScoutRunDeclaration_one_challenge"
  BEFORE INSERT ON public."ScoutRunDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.scout_run_declaration_one_challenge();
CREATE TRIGGER "ScoutRunDeclaration_insert_only"
  BEFORE UPDATE OR DELETE ON public."ScoutRunDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.scout_run_observation_insert_only();
CREATE TRIGGER "ScoutRunDeclaration_no_truncate"
  BEFORE TRUNCATE ON public."ScoutRunDeclaration"
  FOR EACH STATEMENT EXECUTE FUNCTION public.scout_run_observation_insert_only();
CREATE TRIGGER "ScoutRunObservation_insert_only"
  BEFORE UPDATE OR DELETE ON public."ScoutRunObservation"
  FOR EACH ROW EXECUTE FUNCTION public.scout_run_observation_insert_only();
CREATE TRIGGER "ScoutRunObservation_no_truncate"
  BEFORE TRUNCATE ON public."ScoutRunObservation"
  FOR EACH STATEMENT EXECUTE FUNCTION public.scout_run_observation_insert_only();
CREATE TRIGGER "ScoutRunSettledBasis_insert_only"
  BEFORE UPDATE OR DELETE ON public."ScoutRunSettledBasis"
  FOR EACH ROW EXECUTE FUNCTION public.scout_run_observation_insert_only();
CREATE TRIGGER "ScoutRunSettledBasis_no_truncate"
  BEFORE TRUNCATE ON public."ScoutRunSettledBasis"
  FOR EACH STATEMENT EXECUTE FUNCTION public.scout_run_observation_insert_only();

-- Privileges: nothing for PUBLIC / anon / authenticated; service_role SELECT + INSERT only
-- (UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER revoked from every runtime role). Supabase's
-- default privileges would otherwise grant ALL to the three API roles on these new tables.
REVOKE ALL PRIVILEGES ON TABLE public."ScoutRunDeclaration" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public."ScoutRunObservation" FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public."ScoutRunSettledBasis" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public."ScoutRunDeclaration" TO service_role;
GRANT SELECT, INSERT ON TABLE public."ScoutRunObservation" TO service_role;
GRANT SELECT, INSERT ON TABLE public."ScoutRunSettledBasis" TO service_role;

-- RLS: the ImportNativeProvenance set exactly (ENABLE + FORCE, one service_role policy,
-- RESTRICTIVE deny-all for anon and authenticated). Every S10-B/C access filters on the bearer's coach_id.
ALTER TABLE public."ScoutRunDeclaration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScoutRunDeclaration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "p_scout_run_declaration_service_role_all" ON public."ScoutRunDeclaration"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_run_declaration_service_role_all" ON public."ScoutRunDeclaration" IS 'service_role bypass: run declarations are written/read only via the server-side S10 routes running as service_role (table grants limit it to SELECT + INSERT).';
CREATE POLICY "deny_all_anon_scout_run_declaration" ON public."ScoutRunDeclaration"
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_run_declaration" ON public."ScoutRunDeclaration" IS 'RESTRICTIVE deny-all: anon can never read/write run declarations regardless of any permissive policy.';
CREATE POLICY "deny_all_authenticated_scout_run_declaration" ON public."ScoutRunDeclaration"
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_run_declaration" ON public."ScoutRunDeclaration" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write run declarations directly; only service_role may (no cross-tenant oracle).';

ALTER TABLE public."ScoutRunObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScoutRunObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "p_scout_run_observation_service_role_all" ON public."ScoutRunObservation"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_run_observation_service_role_all" ON public."ScoutRunObservation" IS 'service_role bypass: observation evidence is written/read only via the server-side S10 routes running as service_role (table grants limit it to SELECT + INSERT).';
CREATE POLICY "deny_all_anon_scout_run_observation" ON public."ScoutRunObservation"
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_run_observation" ON public."ScoutRunObservation" IS 'RESTRICTIVE deny-all: anon can never read/write observation evidence regardless of any permissive policy.';
CREATE POLICY "deny_all_authenticated_scout_run_observation" ON public."ScoutRunObservation"
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_run_observation" ON public."ScoutRunObservation" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write observation evidence directly; only service_role may (no cross-tenant oracle).';

ALTER TABLE public."ScoutRunSettledBasis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScoutRunSettledBasis" FORCE ROW LEVEL SECURITY;
CREATE POLICY "p_scout_run_settled_basis_service_role_all" ON public."ScoutRunSettledBasis"
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_run_settled_basis_service_role_all" ON public."ScoutRunSettledBasis" IS 'service_role bypass: the settled basis is written/read only via the server-side settle path running as service_role (table grants limit it to SELECT + INSERT).';
CREATE POLICY "deny_all_anon_scout_run_settled_basis" ON public."ScoutRunSettledBasis"
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_run_settled_basis" ON public."ScoutRunSettledBasis" IS 'RESTRICTIVE deny-all: anon can never read/write the settled basis regardless of any permissive policy.';
CREATE POLICY "deny_all_authenticated_scout_run_settled_basis" ON public."ScoutRunSettledBasis"
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_run_settled_basis" ON public."ScoutRunSettledBasis" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the settled basis directly; only service_role may (no cross-tenant oracle).';
COMMIT;
