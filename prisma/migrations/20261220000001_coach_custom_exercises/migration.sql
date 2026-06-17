-- FEATURE_CUSTOM_EXERCISE — coach-owned custom exercise library.
--
-- Additive only. Creates ONE new table (coach_exercises). No existing table is
-- altered and no FK on an existing table changes (no FK churn). Timestamp
-- 20261220000001 is strictly AFTER the latest landed migration
-- (20261220000000_talent_marketplace_rls) so the ordered apply never reorders
-- behind a shipped migration (migrations are append-only).
--
-- WHAT THIS IS: a coach (e.g. a yoga instructor) authors a brand-new move NOT
-- in the fixed catalog — free-text name, written instructions, and an optional
-- image/video they upload to Supabase Storage. The row is the durable, reusable,
-- coach-OWNED library entry. The media object is uploaded via a signed PUT URL
-- and the row is inserted only AFTER that upload is confirmed (presign -> direct
-- PUT -> durable create), mirroring the community voice-notes idiom.
--
-- Tenancy + RLS follow the v1-1 community migration verbatim
-- (20261212000000_community_v1_1_schema, the community_workspaces coach_all
-- policy):
--   * The table ENABLEs + FORCEs ROW LEVEL SECURITY.
--   * The runtime app connects as Supabase `service_role` (BYPASSRLS) and scopes
--     itself in CoachExerciseService (application-layer tenancy is primary). The
--     policy below is defence-in-depth for any non-service-role connection.
--   * The owning coach gets FOR ALL via the same coach-owns-own-row idiom the
--     community_workspaces_coach_all policy uses: "coach_id"::text =
--     app.current_user_id(). (app.is_owner() is the platform-OWNER role check —
--     NOT a per-row owner test — so we scope through coach_id directly, exactly
--     as the v1-1 community_workspaces policy does. app.current_user_id() is the
--     canonical helper provided by the v1-1 migration and search_path-hardened by
--     20261212000000_rls_helper_search_path; auth.uid() is never referenced.)
--
-- Rollback: DROP the policy created here, DISABLE ROW LEVEL SECURITY on the
-- table, DROP the table. Only on a confirmed P0; otherwise fix forward.

BEGIN;

-- Defensive, idempotent schema guard (matches every prior community/RLS
-- migration). `app` already exists in the chain; this is a no-op on replay.
CREATE SCHEMA IF NOT EXISTS app;

-- CreateTable
CREATE TABLE "coach_exercises" (
    "id" UUID NOT NULL,
    "coach_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "instructions" TEXT NOT NULL,
    "media_kind" VARCHAR(16) NOT NULL,
    "storage_key" TEXT,
    "media_mime" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "coach_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_exercises_coach_id_created_at_idx" ON "coach_exercises"("coach_id", "created_at");

-- AddForeignKey
ALTER TABLE "coach_exercises" ADD CONSTRAINT "coach_exercises_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-Level Security ──────────────────────────────────────────────────────

ALTER TABLE "coach_exercises" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_exercises" FORCE ROW LEVEL SECURITY;

-- coach_exercises: owner ALL. Mirrors the v1-1 community_workspaces coach_all
-- policy idiom exactly — the coach who authored the row (coach_id) can
-- read/write it (USING for read, WITH CHECK for write), scoped through the
-- canonical app.current_user_id() helper. service_role is BYPASSRLS; this
-- policy is defence-in-depth for any non-service-role connection.
DROP POLICY IF EXISTS "coach_exercises_owner_all" ON "coach_exercises";
CREATE POLICY "coach_exercises_owner_all" ON "coach_exercises"
  FOR ALL TO public
  USING ("coach_id"::text = app.current_user_id())
  WITH CHECK ("coach_id"::text = app.current_user_id());

COMMIT;
