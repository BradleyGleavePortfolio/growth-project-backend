-- IMPORTER-F — scout reconstruction: canonical invite-pending roster + ledger.
--
-- D2 (DECIDED, Op 59): an imported client reconstructs into an invite-pending,
-- NON-LOGIN, tenant-owned roster "Person" record. NO auth User / AuthPrincipal
-- / credential is minted at import. Identity is the opaque server-issued id
-- (person_id); dedup/idempotency is the tenant-scoped external_ref
-- (coach_id, source_platform, source_person_id). Email is unverified imported
-- data — deliberately NOT a column here and NEVER a canonical id or linking key.
--
-- "ScoutReconstructionLedger" gives honest per-entity reconciliation for one
-- reconstruction pass: staged = reconstructed + skipped + failed, with a reason
-- on every non-reconstructed outcome. Its UNIQUE (coach_id, intent_id,
-- entity_type, source_id) anchors idempotent replay (a re-run is a no-op).
--
-- REVERSIBLE (R82/R106): additive, self-contained; reverse in the companion
-- down.sql.
--
-- RLS: RESTRICTIVE deny-all to anon + authenticated with a service_role bypass,
-- identical posture to ScoutIngestEntity (20261222000000). Reconstruction runs
-- server-side as service_role; no client principal reads or writes these tables
-- directly, so a client can never learn another tenant's roster (no oracle).
--
-- ORDERING: dated AFTER 20261223000100_scout_import_state so a fresh apply
-- creates the ScoutImport lifecycle table (which reconstruct's post-settle gate
-- reads) before this migration. This migration is additive and self-contained —
-- it declares no FK to ScoutImport — so ordering is for deploy clarity, not a
-- structural dependency; a fresh migrate applies both cleanly in sequence.
-- =====================================================================

BEGIN;

CREATE TYPE "PersonState" AS ENUM ('InvitePending', 'Invited', 'Claimed', 'Suspended', 'Deleted');

CREATE TABLE "Person" (
    "id"               TEXT NOT NULL,
    "coach_id"         TEXT NOT NULL,
    "source_platform"  TEXT NOT NULL,
    "source_person_id" TEXT NOT NULL,
    "display_name"     TEXT,
    "state"            "PersonState" NOT NULL DEFAULT 'InvitePending',
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Person_coach_id_source_platform_source_person_id_key"
    ON "Person" ("coach_id", "source_platform", "source_person_id");

CREATE INDEX "Person_coach_id_idx" ON "Person" ("coach_id");

CREATE TABLE "ScoutReconstructionLedger" (
    "id"          TEXT NOT NULL,
    "coach_id"    TEXT NOT NULL,
    "intent_id"   TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "source_id"   TEXT NOT NULL,
    "status"      TEXT NOT NULL,
    "target_id"   TEXT,
    "reason"      TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutReconstructionLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key"
    ON "ScoutReconstructionLedger" ("coach_id", "intent_id", "entity_type", "source_id");

CREATE INDEX "ScoutReconstructionLedger_coach_id_intent_id_idx"
    ON "ScoutReconstructionLedger" ("coach_id", "intent_id");

-- RLS: Person -----------------------------------------------------------------
ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Person" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_person_service_role_all" ON "Person";
CREATE POLICY "p_person_service_role_all" ON "Person" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_person_service_role_all" ON "Person" IS 'service_role bypass: invite-pending roster is written/read only via the server-side reconstruction engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_person" ON "Person";
CREATE POLICY "deny_all_anon_person" ON "Person" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_person" ON "Person" IS 'RESTRICTIVE deny-all: anon can never read/write roster records regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_person" ON "Person";
CREATE POLICY "deny_all_authenticated_person" ON "Person" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_person" ON "Person" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write roster records directly; only service_role may (no cross-tenant oracle).';

-- RLS: ScoutReconstructionLedger ---------------------------------------------
ALTER TABLE "ScoutReconstructionLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScoutReconstructionLedger" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_scout_reconstruction_service_role_all" ON "ScoutReconstructionLedger";
CREATE POLICY "p_scout_reconstruction_service_role_all" ON "ScoutReconstructionLedger" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_scout_reconstruction_service_role_all" ON "ScoutReconstructionLedger" IS 'service_role bypass: the reconciliation ledger is written/read only via the server-side reconstruction engine running as service_role.';

DROP POLICY IF EXISTS "deny_all_anon_scout_reconstruction" ON "ScoutReconstructionLedger";
CREATE POLICY "deny_all_anon_scout_reconstruction" ON "ScoutReconstructionLedger" AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_anon_scout_reconstruction" ON "ScoutReconstructionLedger" IS 'RESTRICTIVE deny-all: anon can never read/write the reconciliation ledger regardless of any permissive policy.';

DROP POLICY IF EXISTS "deny_all_authenticated_scout_reconstruction" ON "ScoutReconstructionLedger";
CREATE POLICY "deny_all_authenticated_scout_reconstruction" ON "ScoutReconstructionLedger" AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
COMMENT ON POLICY "deny_all_authenticated_scout_reconstruction" ON "ScoutReconstructionLedger" IS 'RESTRICTIVE deny-all: authenticated principals can never read/write the ledger directly; only service_role may.';

COMMIT;
