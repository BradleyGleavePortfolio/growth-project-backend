-- IMPORTER-E — cross-device progress mirroring + terminal completion ledger for
-- the tgp-importer Chrome extension (DESIGN.md v0.3 §10 + §2 step 11).
--
-- Two additive tables, both server-only (written under the extension bearer
-- token via service_role). Neither touches an existing table, column, type,
-- policy, or migration.
--
-- Dated AFTER main's latest migration 20261221010000_add_signup_ref_to_user.
--
-- ScoutProgressSnapshot: latest crawl snapshot per (coach_id, intent_id,
-- device_id). The endpoint upserts (not appends) so only the newest snapshot per
-- device is retained; the @@unique anchors the upsert. device_id is in the key
-- so a coach mirroring one import from two physical devices at once keeps two
-- independent rows instead of clobbering each other. Progress can arrive before
-- the first ingest batch, so there is deliberately NO foreign key to any ingest
-- table.
--
-- ScoutImportCompletion: terminal completion per (coach_id, intent_id). The
-- @@unique is the idempotency anchor — a redelivered completion loses the
-- unique-insert race and is a no-op, so the coach is never double-notified.
--
-- RLS: RESTRICTIVE deny-all (anon + authenticated) + service_role-only bypass,
-- the same posture as MarketplaceConnectEvent (20261220000030).
-- =====================================================================

BEGIN;

CREATE TABLE "ScoutProgressSnapshot" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutProgressSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutProgressSnapshot_coach_id_intent_id_device_id_key" ON "ScoutProgressSnapshot"("coach_id", "intent_id", "device_id");
CREATE INDEX "ScoutProgressSnapshot_coach_id_idx" ON "ScoutProgressSnapshot"("coach_id");

CREATE TABLE "ScoutImportCompletion" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "intent_id" TEXT NOT NULL,
    "terminal_status" TEXT NOT NULL,
    "final_counts" JSONB,
    "error_summary" TEXT,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutImportCompletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutImportCompletion_coach_id_intent_id_key" ON "ScoutImportCompletion"("coach_id", "intent_id");
CREATE INDEX "ScoutImportCompletion_coach_id_idx" ON "ScoutImportCompletion"("coach_id");

-- ── RLS: RESTRICTIVE deny-all + service_role bypass (RLS floor). ──────────────
ALTER TABLE "ScoutProgressSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutProgressSnapshot" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_progress_snapshot_service_role_all" ON "ScoutProgressSnapshot";
CREATE POLICY "p_scout_progress_snapshot_service_role_all" ON "ScoutProgressSnapshot" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_progress_snapshot_service_role_all" ON "ScoutProgressSnapshot" IS 'Primitive A: service_role bypass. Progress snapshots are written/read only by the server-side IMPORTER-E handler running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_progress_snapshot" ON "ScoutProgressSnapshot";
CREATE POLICY "deny_all_anon_scout_progress_snapshot" ON "ScoutProgressSnapshot" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_progress_snapshot" ON "ScoutProgressSnapshot" IS 'RESTRICTIVE deny-all: anon can never read/write scout progress snapshots.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_progress_snapshot" ON "ScoutProgressSnapshot";
CREATE POLICY "deny_all_authenticated_scout_progress_snapshot" ON "ScoutProgressSnapshot" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_progress_snapshot" ON "ScoutProgressSnapshot" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write scout progress snapshots; only service_role may.';

ALTER TABLE "ScoutImportCompletion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutImportCompletion" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_import_completion_service_role_all" ON "ScoutImportCompletion";
CREATE POLICY "p_scout_import_completion_service_role_all" ON "ScoutImportCompletion" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_import_completion_service_role_all" ON "ScoutImportCompletion" IS 'Primitive A: service_role bypass. The completion ledger is written/read only by the server-side IMPORTER-E handler running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_import_completion" ON "ScoutImportCompletion";
CREATE POLICY "deny_all_anon_scout_import_completion" ON "ScoutImportCompletion" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_import_completion" ON "ScoutImportCompletion" IS 'RESTRICTIVE deny-all: anon can never read/write the completion ledger.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_import_completion" ON "ScoutImportCompletion";
CREATE POLICY "deny_all_authenticated_scout_import_completion" ON "ScoutImportCompletion" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_import_completion" ON "ScoutImportCompletion" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the completion ledger; only service_role may.';

COMMIT;
