-- IMPORTER-H — multi-family reconstruction: generic canonical entity table.
--
-- D2, site-agnostic. The reconstruction engine is now keyed on entity_type via
-- a family registry. The `clients` family still reconstructs into "Person"
-- (20261223000200); families that are NOT people — `workouts`, `client_history`
-- — reconstruct into this ONE generic tenant-owned table instead of a per-family
-- clone. Adding a new non-person family is a registry + mapper change only; no
-- new table and no new migration.
--
-- Identity/idempotency is the tenant-scoped external_ref
-- (coach_id, source_platform, entity_type, source_id) — the source platform's
-- own opaque record id, NEVER email and NEVER a billing key. "client_source_id"
-- is a SOFT provenance link to the owning Person's external_ref
-- (coach_id, source_platform, client_source_id) — no FK, mirroring the no-FK
-- posture of the other scout tables. "label" is a best-effort, PII-minimal
-- display string (a title/name), never email, never any billing/price field.
--
-- REVERSIBLE (R82/R106): additive, self-contained; reverse in the companion
-- down.sql.
--
-- RLS: RESTRICTIVE deny-all to anon + authenticated with a service_role bypass,
-- identical posture to Person / ScoutReconstructionLedger (20261223000200).
-- Reconstruction runs server-side as service_role; no client principal reads or
-- writes this table directly, so a client can never learn another tenant's
-- reconstructed entities (no oracle).
--
-- ORDERING: dated AFTER 20261223000200_scout_reconstruction. Additive and
-- self-contained (no FK to Person or any scout table), so a fresh migrate
-- applies the sequence cleanly.
-- =====================================================================

BEGIN;

CREATE TABLE "ScoutReconstructedEntity" (
    "id"               TEXT NOT NULL,
    "coach_id"         TEXT NOT NULL,
    "source_platform"  TEXT NOT NULL,
    "entity_type"      TEXT NOT NULL,
    "source_id"        TEXT NOT NULL,
    "client_source_id" TEXT,
    "label"            TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutReconstructedEntity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutReconstructedEntity_coach_id_source_platform_entity_type_source_id_key"
    ON "ScoutReconstructedEntity" ("coach_id", "source_platform", "entity_type", "source_id");

CREATE INDEX "ScoutReconstructedEntity_coach_id_entity_type_idx"
    ON "ScoutReconstructedEntity" ("coach_id", "entity_type");

-- RLS: ScoutReconstructedEntity ----------------------------------------------
ALTER TABLE "ScoutReconstructedEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutReconstructedEntity" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_reconstructed_entity_service_role_all" ON "ScoutReconstructedEntity";
CREATE POLICY "p_scout_reconstructed_entity_service_role_all" ON "ScoutReconstructedEntity" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_reconstructed_entity_service_role_all" ON "ScoutReconstructedEntity" IS 'service_role bypass: canonical reconstructed entities are written/read only via the server-side reconstruction engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_reconstructed_entity" ON "ScoutReconstructedEntity";
CREATE POLICY "deny_all_anon_scout_reconstructed_entity" ON "ScoutReconstructedEntity" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_reconstructed_entity" ON "ScoutReconstructedEntity" IS 'RESTRICTIVE deny-all: anon can never read/write reconstructed entities regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_reconstructed_entity" ON "ScoutReconstructedEntity";
CREATE POLICY "deny_all_authenticated_scout_reconstructed_entity" ON "ScoutReconstructedEntity" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_reconstructed_entity" ON "ScoutReconstructedEntity" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write reconstructed entities directly; only service_role may (no cross-tenant oracle).';

COMMIT;
