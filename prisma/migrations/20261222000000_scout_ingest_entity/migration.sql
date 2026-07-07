-- IMPORTER-B — create the scout ingest receiver table.
--
-- Backs POST /api/scout/ingest, the receiver for the tgp-importer extension's
-- autonomous crawl envelope. The envelope shape is the R80-locked contract in
-- tgp-importer-extension extractors/_interface.js:
--   { intent_id, entity_type, entities:[{ source_id, payload }] }
--
-- IDEMPOTENCY: the UNIQUE (coach_id, intent_id, source_id) constraint is the
-- anchor for the endpoint's replay-safety — a re-posted entity loses the
-- INSERT ... ON CONFLICT DO NOTHING race and is counted as deduped, so the
-- extension can retry a batch during recovery without duplicating rows.
--
-- REVERSIBLE (R82/R106): additive, self-contained. The reverse step lives in
-- the companion down.sql (DROP TABLE IF EXISTS "ScoutIngestEntity";).
--
-- RLS: RESTRICTIVE deny-all to anon + authenticated with a service_role
-- bypass. The ingest endpoint runs server-side as service_role; no client
-- principal may ever read or write crawl data directly. Mirrors the posture on
-- MarketplaceMutationIdempotency (20261220000010).
-- =====================================================================

BEGIN;

CREATE TABLE "ScoutIngestEntity" (
    "id"              TEXT NOT NULL,
    "coach_id"        TEXT NOT NULL,
    "intent_id"       TEXT NOT NULL,
    "entity_type"     TEXT NOT NULL,
    "source_id"       TEXT NOT NULL,
    "source_platform" TEXT NOT NULL,
    "captured_at"     TIMESTAMP(3),
    "payload"         JSONB NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutIngestEntity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutIngestEntity_coach_id_intent_id_source_id_key"
    ON "ScoutIngestEntity" ("coach_id", "intent_id", "source_id");

CREATE INDEX "ScoutIngestEntity_coach_id_entity_type_idx"
    ON "ScoutIngestEntity" ("coach_id", "entity_type");

-- RLS posture: only service_role (the server-side ingest engine) may touch the
-- table; anon + authenticated are denied by a RESTRICTIVE policy that no
-- permissive policy can override.
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
