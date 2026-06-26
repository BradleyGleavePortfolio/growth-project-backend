-- v3-2 — community classroom posts (media-backed lessons).
--
-- Additive only. Creates two NEW tables (community_classroom_posts +
-- community_classroom_media_assets) and one NEW enum
-- (CommunityClassroomPostStatus). No existing community table is altered, no FK
-- on an existing table changes (R69 / "no FK churn on existing tables").
--
-- Tenancy + RLS follow the v1-1 community migration verbatim
-- (20261212000000_community_v1_1_schema):
--   * Both tables ENABLE + FORCE ROW LEVEL SECURITY.
--   * The runtime app connects as Supabase `service_role` (BYPASSRLS) and scopes
--     itself in CommunityAccessService (application-layer tenancy). The policies
--     below are defence-in-depth for any non-service-role connection.
--   * Coaches who own the workspace get FOR ALL via
--     app.is_community_workspace_coach(workspace_id).
--   * Students/members SELECT a lesson only when it is PUBLISHED, RELEASED
--     (release_at IS NULL OR release_at <= now()), NOT soft-deleted, and they are
--     a workspace member (workspace-wide lesson, cohort_id IS NULL) or share the
--     lesson's cohort. This mirrors community_posts_member_select and enforces
--     the brief's release-time-lock + media-access-by-membership guarantees at
--     the DB layer.
--   * Media assets inherit visibility from their parent post: a member may SELECT
--     a media row only when the parent post row is itself visible to them (same
--     predicate, evaluated through the post join).
--
-- Helper functions (app.is_community_workspace_coach(uuid),
-- app.is_community_workspace_member(uuid), app.shares_community_cohort(uuid),
-- app.current_user_id()) are provided by the v1-1 migration and are search_path-
-- hardened by 20261212000000_rls_helper_search_path.
--
-- Rollback: DROP the policies created here, DISABLE ROW LEVEL SECURITY on both
-- tables, DROP both tables, DROP TYPE "CommunityClassroomPostStatus". Only on a
-- confirmed P0; otherwise fix forward.

BEGIN;

-- Defensive, idempotent schema guard (matches every prior community/RLS
-- migration). `app` already exists in the chain; this is a no-op on replay.
CREATE SCHEMA IF NOT EXISTS app;

-- CreateEnum
CREATE TYPE "CommunityClassroomPostStatus" AS ENUM ('draft', 'scheduled', 'published', 'archived');

-- CreateTable
CREATE TABLE "community_classroom_posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "coach_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body_markdown" TEXT NOT NULL,
    "status" "CommunityClassroomPostStatus" NOT NULL DEFAULT 'draft',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinned_order" INTEGER,
    "release_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "soft_deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_classroom_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_classroom_media_assets" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_sec" INTEGER,
    "bytes" BIGINT,
    "mime_type" VARCHAR(120),
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_classroom_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_classroom_posts_workspace_id_cohort_id_status_rele_idx" ON "community_classroom_posts"("workspace_id", "cohort_id", "status", "release_at");

-- CreateIndex
CREATE INDEX "community_classroom_posts_workspace_id_cohort_id_pinned_pinn_idx" ON "community_classroom_posts"("workspace_id", "cohort_id", "pinned", "pinned_order");

-- CreateIndex
CREATE INDEX "community_classroom_media_assets_workspace_id_post_id_idx" ON "community_classroom_media_assets"("workspace_id", "post_id");

-- CreateIndex
CREATE INDEX "community_classroom_media_assets_storage_key_idx" ON "community_classroom_media_assets"("storage_key");

-- AddForeignKey
ALTER TABLE "community_classroom_posts" ADD CONSTRAINT "community_classroom_posts_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_classroom_media_assets" ADD CONSTRAINT "community_classroom_media_assets_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_classroom_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Row-Level Security ──────────────────────────────────────────────────────

ALTER TABLE "community_classroom_posts"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_classroom_posts"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "community_classroom_media_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_classroom_media_assets" FORCE ROW LEVEL SECURITY;

-- community_classroom_posts: workspace owner ALL; members SELECT a lesson only
-- when it is published, released (release_at NULL or in the past), not
-- soft-deleted, and they are a workspace member (cohort_id NULL = workspace-wide)
-- or share the lesson's cohort. Mirrors community_posts_member_select and proves
-- the release-time-lock + media-access-by-membership guarantees at the DB layer.
DROP POLICY IF EXISTS "community_classroom_posts_coach_all" ON "community_classroom_posts";
CREATE POLICY "community_classroom_posts_coach_all" ON "community_classroom_posts"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_classroom_posts_member_select" ON "community_classroom_posts";
CREATE POLICY "community_classroom_posts_member_select" ON "community_classroom_posts"
  FOR SELECT TO public
  USING (
    "status" = 'published'
    AND ("release_at" IS NULL OR "release_at" <= now())
    AND "soft_deleted_at" IS NULL
    AND (
      ("cohort_id" IS NULL AND app.is_community_workspace_member("workspace_id"))
      OR ("cohort_id" IS NOT NULL AND app.shares_community_cohort("cohort_id"))
    )
  );

-- community_classroom_media_assets: workspace owner ALL; members SELECT a media
-- row only when the parent post is itself visible to them (same published +
-- released + not-deleted + membership predicate, evaluated through the post
-- join). A non-member therefore cannot resolve a storage_key for signing, which
-- backs the "non-member cannot fetch storageKey URL" test.
DROP POLICY IF EXISTS "community_classroom_media_assets_coach_all" ON "community_classroom_media_assets";
CREATE POLICY "community_classroom_media_assets_coach_all" ON "community_classroom_media_assets"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

DROP POLICY IF EXISTS "community_classroom_media_assets_member_select" ON "community_classroom_media_assets";
CREATE POLICY "community_classroom_media_assets_member_select" ON "community_classroom_media_assets"
  FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1
      FROM "community_classroom_posts" p
      WHERE p."id" = "community_classroom_media_assets"."post_id"
        AND p."status" = 'published'
        AND (p."release_at" IS NULL OR p."release_at" <= now())
        AND p."soft_deleted_at" IS NULL
        AND (
          (p."cohort_id" IS NULL AND app.is_community_workspace_member(p."workspace_id"))
          OR (p."cohort_id" IS NOT NULL AND app.shares_community_cohort(p."cohort_id"))
        )
    )
  );

COMMIT;
