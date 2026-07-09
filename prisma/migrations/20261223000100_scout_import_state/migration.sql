-- IMPORTER-E FIX-3 — parent lifecycle state table for an extension import
-- (R-STATE-1: /complete must OWN the state transition, not just observe it).
--
-- The completion ledger (ScoutImportCompletion) records THAT a settle happened;
-- this table owns the import's current lifecycle STATE so the ingest side is not
-- stuck reading `in_progress` forever. /api/scout/ingest/complete upserts this
-- row to the reported terminal_status in the SAME $transaction as the ledger
-- insert, so the ledger and the state can never disagree: a duplicate settle
-- hits the ledger's unique constraint, the whole transaction rolls back, and
-- the state is never re-flipped.
--
-- One row per (coach_id, intent_id); the @@unique anchors the upsert. Additive,
-- server-only (written under the extension bearer token via service_role); it
-- touches no existing table, column, policy, or migration.
--
-- RLS: RESTRICTIVE deny-all (anon + authenticated) + service_role-only bypass,
-- the same posture as the other scout tables (20261222000000).
--
-- Dated AFTER 20261223000000_scout_progress_add_device_id.
-- =====================================================================

BEGIN;

CREATE TABLE "ScoutImport" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'in_progress',
    "terminal_status" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ScoutImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutImport_coach_id_intent_id_key" ON "ScoutImport"("coach_id", "intent_id");
CREATE INDEX "ScoutImport_coach_id_idx" ON "ScoutImport"("coach_id");

-- ── RLS: RESTRICTIVE deny-all + service_role bypass (RLS floor). ──────────────
ALTER TABLE "ScoutImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutImport" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_import_service_role_all" ON "ScoutImport";
CREATE POLICY "p_scout_import_service_role_all" ON "ScoutImport" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_import_service_role_all" ON "ScoutImport" IS 'Primitive A: service_role bypass. The import lifecycle row is written/read only by the server-side IMPORTER-E handler running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_import" ON "ScoutImport";
CREATE POLICY "deny_all_anon_scout_import" ON "ScoutImport" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_import" ON "ScoutImport" IS 'RESTRICTIVE deny-all: anon can never read/write the import lifecycle row.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_import" ON "ScoutImport";
CREATE POLICY "deny_all_authenticated_scout_import" ON "ScoutImport" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_import" ON "ScoutImport" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the import lifecycle row; only service_role may.';

COMMIT;
