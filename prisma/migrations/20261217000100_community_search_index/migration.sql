-- v3-4 — community full-text search index (community_search_entries).
--
-- Additive only. Creates ONE new table plus a generated tsvector column and a
-- GIN index. No existing community table is altered, no FK on an existing table
-- changes (R69 / R76 §6 — "no FK churn on existing tables"). Timestamp
-- 20261217000100 is strictly AFTER the v3-3 voice-notes migration
-- (20261217000000_community_voice_notes) so the ordered apply never reorders
-- behind a landed migration.
--
-- COLUMN NAMING: the Prisma model `CommunitySearchEntry` maps the TABLE name
-- (@@map community_search_entries) but does NOT @map individual fields, so
-- Prisma generates camelCase column identifiers ("workspaceId", "cohortId",
-- "targetId", "authorId", "excerpt", "visibleToRoles", "createdAt",
-- "softDeletedAt"). The CommunitySearchRepository raw SQL references exactly
-- those quoted identifiers PLUS a raw `search_tsv` tsvector column that Prisma
-- does NOT model — this migration is the sole creator of `search_tsv`.
--
-- TENANCY + RLS follow the v3-3 voice-notes / v1-1 community convention:
--   * ENABLE + FORCE ROW LEVEL SECURITY.
--   * The runtime app connects as Supabase `service_role` (BYPASSRLS) and scopes
--     itself in CommunitySearchService/Repository (application-layer tenancy +
--     keyset SQL). The policies below are defence-in-depth for any non-service-
--     role connection.
--   * Workspace coaches get FOR ALL via app.is_community_workspace_coach().
--   * Members SELECT a row only when it is NOT soft-deleted AND either the row
--     is the workspace hall (cohortId IS NULL, any workspace member) or they
--     share the cohort (app.shares_community_cohort).
--
-- Helper functions (app.is_community_workspace_coach(uuid),
-- app.is_community_workspace_member(uuid), app.shares_community_cohort(uuid),
-- app.current_user_id()) are provided by the v1-1 migration and search_path-
-- hardened by 20261212000000_rls_helper_search_path.
--
-- IDEMPOTENT RE-INDEX: the unique key (workspaceId, kind, targetId) lets the
-- indexer upsert the same target without duplicate rows (brief test 7).
--
-- Rollback: DROP the policies, DISABLE ROW LEVEL SECURITY, DROP the table.
-- Only on a confirmed P0; otherwise fix forward.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommunitySearchKind') THEN
    CREATE TYPE "CommunitySearchKind" AS ENUM ('post', 'classroom_lesson', 'voice_note_transcript', 'event');
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "community_search_entries" (
    "id" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "cohortId" UUID,
    "kind" "CommunitySearchKind" NOT NULL,
    "targetId" UUID NOT NULL,
    "authorId" UUID,
    "excerpt" TEXT NOT NULL,
    "visibleToRoles" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "softDeletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "community_search_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent re-index key — brief test 7)
CREATE UNIQUE INDEX "community_search_entries_workspaceId_kind_targetId_key" ON "community_search_entries"("workspaceId", "kind", "targetId");

-- CreateIndex (cohort/kind/recency browse)
CREATE INDEX "community_search_entries_workspaceId_cohortId_kind_createdAt_idx" ON "community_search_entries"("workspaceId", "cohortId", "kind", "createdAt");

-- AddForeignKey (scalar references resolved at the SQL layer — no Prisma relation)
ALTER TABLE "community_search_entries" ADD CONSTRAINT "community_search_entries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "community_search_entries" ADD CONSTRAINT "community_search_entries_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Full-text search: generated tsvector column + GIN index ────────────────
-- The repository's raw SQL uses websearch_to_tsquery('english', term) against a
-- `search_tsv` column and ts_rank(search_tsv, ...) for ranking. A STORED
-- generated column keeps the tsvector consistent with `excerpt` on every
-- insert/update with zero trigger maintenance. `excerpt` is already PII-stripped
-- + body-free at the indexer layer (V3_4_PREFLIGHT_NOTES §8).
ALTER TABLE "community_search_entries"
  ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "excerpt")) STORED;

CREATE INDEX "community_search_entries_search_tsv_gin" ON "community_search_entries" USING GIN ("search_tsv");

-- ─── Row-Level Security ──────────────────────────────────────────────────────

ALTER TABLE "community_search_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_search_entries" FORCE ROW LEVEL SECURITY;

-- Workspace owner / coach: FOR ALL (read + write) on every row in the workspace.
DROP POLICY IF EXISTS "community_search_entries_coach_all" ON "community_search_entries";
CREATE POLICY "community_search_entries_coach_all" ON "community_search_entries"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspaceId"))
  WITH CHECK (app.is_community_workspace_coach("workspaceId"));

-- Member SELECT: not-soft-deleted AND (workspace hall OR shared cohort). Role
-- visibility ("visibleToRoles") is additionally enforced application-side in the
-- repository SQL; the DB policy is the cohort/soft-delete defence-in-depth gate.
DROP POLICY IF EXISTS "community_search_entries_member_select" ON "community_search_entries";
CREATE POLICY "community_search_entries_member_select" ON "community_search_entries"
  FOR SELECT TO public
  USING (
    "softDeletedAt" IS NULL
    AND (
      ("cohortId" IS NULL AND app.is_community_workspace_member("workspaceId"))
      OR ("cohortId" IS NOT NULL AND app.shares_community_cohort("cohortId"))
    )
  );

COMMIT;
