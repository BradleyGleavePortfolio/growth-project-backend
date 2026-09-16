-- Restates R-IDEMP-1: entity type AND platform namespace prevent silent
-- loss via ON CONFLICT DO NOTHING; captured_at remains a value.
-- Platform-qualified R-IDEMP-1. Public is the supported application schema.
-- Stop ingest/reconstruction writers during this coordinated schema/code rollout.
-- Once-only, history-managed SQL. Raw reruns fail atomically, not silently succeed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public."ScoutIngestEntity", public."ScoutReconstructionLedger" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public."ScoutIngestEntity_coach_id_intent_id_source_id_key"')
      AND indrelid = 'public."ScoutIngestEntity"'::regclass) OR
     NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public."ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key"')
      AND indrelid = 'public."ScoutReconstructionLedger"'::regclass) THEN
    RAISE EXCEPTION 'Unexpected identity index owner or missing prerequisite';
  END IF;
END $$;
ALTER TABLE public."ScoutIngestEntity" ADD CONSTRAINT scout_ingest_platform_canonical
  CHECK (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$');
ALTER TABLE public."ScoutReconstructionLedger" ADD COLUMN source_platform TEXT;
-- The still-active three-column ingest key guarantees at most one match.
-- Missing provenance becomes NULL and NOT NULL below refuses the whole migration.
-- Never invent a platform or discard orphaned ledger records.
UPDATE public."ScoutReconstructionLedger" l SET source_platform = (
  SELECT i.source_platform FROM public."ScoutIngestEntity" i
  WHERE (i.coach_id, i.intent_id, i.entity_type, i.source_id) =
        (l.coach_id, l.intent_id, l.entity_type, l.source_id)
);
ALTER TABLE public."ScoutReconstructionLedger" ALTER COLUMN source_platform SET NOT NULL;
ALTER TABLE public."ScoutReconstructionLedger" ADD CONSTRAINT scout_ledger_platform_canonical
  CHECK (source_platform COLLATE "C" ~ '^[a-z0-9][a-z0-9._:-]{0,255}$');
CREATE UNIQUE INDEX "ScoutIngestEntity_identity_key" ON public."ScoutIngestEntity"
  (coach_id, intent_id, entity_type, source_platform, source_id);
CREATE UNIQUE INDEX "ScoutReconstructionLedger_identity_key" ON public."ScoutReconstructionLedger"
  (coach_id, intent_id, entity_type, source_platform, source_id);
DROP INDEX public."ScoutIngestEntity_coach_id_intent_id_source_id_key";
DROP INDEX public."ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key";
-- RLS re-assertion (idempotent): the exact policies from 20261222000000, so a
-- reviewer can confirm service_role-only access without cross-referencing.
ALTER TABLE public."ScoutIngestEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ScoutIngestEntity" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_ingest_service_role_all" ON public."ScoutIngestEntity";
CREATE POLICY "p_scout_ingest_service_role_all" ON public."ScoutIngestEntity" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_ingest_service_role_all" ON public."ScoutIngestEntity" IS 'service_role bypass: the crawl-envelope receiver writes/reads only via the server-side ingest engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_ingest" ON public."ScoutIngestEntity";
CREATE POLICY "deny_all_anon_scout_ingest" ON public."ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_ingest" ON public."ScoutIngestEntity" IS 'RESTRICTIVE deny-all: anon can never read/write crawl data regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_ingest" ON public."ScoutIngestEntity";
CREATE POLICY "deny_all_authenticated_scout_ingest" ON public."ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_ingest" ON public."ScoutIngestEntity" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write crawl data; only service_role may.';

-- History-managed, once-only SQL: reapplication fails atomically, never IF NOT EXISTS over an unchecked index.
COMMIT;
