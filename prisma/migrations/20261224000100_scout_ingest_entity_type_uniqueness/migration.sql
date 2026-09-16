-- IMPORTER I1a — add entity_type to the ScoutIngestEntity idempotency key.
--
-- P0 SILENT DATA LOSS. The shipped key (20261222000000) is UNIQUE (coach_id,
-- intent_id, source_id), but the extension posts one envelope per entity_type
-- inside an intent and source ids are only unique WITHIN a type at the source (a
-- TrueCoach client and workout can both be "1042"), so the second envelope of a
-- crawl session collided. The writer compiles to ON CONFLICT DO NOTHING
-- (createMany + skipDuplicates), which never raises P2002: the row silently
-- never landed and `deduped = received - count` reported it as a good replay.
--
-- R-IDEMP-1 (2026-07-08) RESTATED: captured_at stays a VALUE (a re-observation
-- within an intent must be a no-op replay, so a retry carrying a fresh timestamp
-- must not insert); entity_type IS a key column (identity is "the coach saw
-- entity X OF TYPE T during crawl session Y"), as both sibling scout tables
-- already have it. 20261222000000 is shipped and never edited (ENGINEERING_RULES
-- §2); its stale prose stands as historical record (R5).
--
-- SAFETY: widening cannot fail on existing data (every row meeting UNIQUE
-- (a,b,c) meets UNIQUE (a,b,c,d)) and rewrites no rows — previously dropped
-- batches start landing. FEATURE_SCOUT_INGEST stays default-OFF. ROLLBACK
-- (R82/R106) is down.sql, which NARROWS, so it CAN fail and refuses rather than
-- delete crawl data. RLS is unchanged, re-asserted below to be verifiable here.

BEGIN;

-- Widened key FIRST, then drop the narrow one: if the DROP were ever moved out
-- of this transaction there is still no window without a uniqueness constraint.
CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_entity_type_source_id_key"
    ON "ScoutIngestEntity" ("coach_id", "intent_id", "entity_type", "source_id");

DROP INDEX IF EXISTS "ScoutIngestEntity_coach_id_intent_id_source_id_key";

-- RLS re-assertion (idempotent): the exact policies from 20261222000000, so a
-- reviewer can confirm service_role-only access without cross-referencing.
ALTER TABLE "ScoutIngestEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutIngestEntity" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_ingest_service_role_all" ON "ScoutIngestEntity";
CREATE POLICY "p_scout_ingest_service_role_all" ON "ScoutIngestEntity" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_ingest_service_role_all" ON "ScoutIngestEntity" IS 'service_role bypass: the crawl-envelope receiver writes/reads only via the server-side ingest engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_ingest" ON "ScoutIngestEntity";
CREATE POLICY "deny_all_anon_scout_ingest" ON "ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_ingest" ON "ScoutIngestEntity" IS 'RESTRICTIVE deny-all: anon can never read/write crawl data regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity";
CREATE POLICY "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_ingest" ON "ScoutIngestEntity" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write crawl data; only service_role may.';

COMMIT;
