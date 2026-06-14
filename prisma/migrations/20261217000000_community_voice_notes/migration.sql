-- v3-3 — community voice notes (audio attachments on classroom DMs/channels).
--
-- Additive only. Creates ONE new table (community_voice_notes). No existing
-- community table is altered, no FK on an existing table changes (R69 / "no FK
-- churn on existing tables"). Timestamp 20261217000000 is strictly AFTER the
-- v3-2 classroom migration (20261216000200_community_classroom_posts) so the
-- ordered apply never reorders behind a landed migration (R76 §6).
--
-- Tenancy + RLS follow the v1-1 community migration verbatim
-- (20261212000000_community_v1_1_schema) and the v3-2 classroom migration:
--   * The table ENABLEs + FORCEs ROW LEVEL SECURITY.
--   * The runtime app connects as Supabase `service_role` (BYPASSRLS) and scopes
--     itself in CommunityVoiceService (application-layer tenancy). The policies
--     below are defence-in-depth for any non-service-role connection.
--   * Coaches who own the workspace get FOR ALL via
--     app.is_community_workspace_coach(workspace_id).
--   * Members SELECT a voice note only when it is NOT soft-deleted AND they are
--     a workspace member of a channel/cohort note (cohort_id IS NULL = the
--     workspace hall; cohort_id present = the cohort) OR they are a participant
--     of the DM conversation. DM participation is proven through the existing
--     community_memberships + the conversation owner check the app enforces;
--     at the DB layer a DM note (conversation_id IS NOT NULL) is visible to the
--     author and to workspace coaches only (defence-in-depth — the app layer is
--     the primary participant gate for DM threads).
--
-- Helper functions (app.is_community_workspace_coach(uuid),
-- app.is_community_workspace_member(uuid), app.shares_community_cohort(uuid),
-- app.current_user_id()) are provided by the v1-1 migration and are search_path-
-- hardened by 20261212000000_rls_helper_search_path.
--
-- Rollback: DROP the policies created here, DISABLE ROW LEVEL SECURITY on the
-- table, DROP the table. Only on a confirmed P0; otherwise fix forward.

BEGIN;

-- Defensive, idempotent schema guard (matches every prior community/RLS
-- migration). `app` already exists in the chain; this is a no-op on replay.
CREATE SCHEMA IF NOT EXISTS app;

-- CreateTable
CREATE TABLE "community_voice_notes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort_id" UUID,
    "conversation_id" UUID,
    "author_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,
    "mime_type" VARCHAR(120) NOT NULL,
    "waveform_peaks" BYTEA,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soft_deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "community_voice_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_voice_notes_workspace_id_cohort_id_created_at_idx" ON "community_voice_notes"("workspace_id", "cohort_id", "created_at");

-- CreateIndex
CREATE INDEX "community_voice_notes_workspace_id_conversation_id_created_a_idx" ON "community_voice_notes"("workspace_id", "conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "community_voice_notes_author_id_created_at_idx" ON "community_voice_notes"("author_id", "created_at");

-- AddForeignKey
ALTER TABLE "community_voice_notes" ADD CONSTRAINT "community_voice_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "community_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_voice_notes" ADD CONSTRAINT "community_voice_notes_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "community_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_voice_notes" ADD CONSTRAINT "community_voice_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-Level Security ──────────────────────────────────────────────────────

ALTER TABLE "community_voice_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_voice_notes" FORCE ROW LEVEL SECURITY;

-- community_voice_notes: workspace owner ALL. Mirrors the classroom coach_all
-- policy: a coach who owns the workspace can read/write every voice note in it
-- (USING for read, WITH CHECK for write), gated through
-- app.is_community_workspace_coach(workspace_id).
DROP POLICY IF EXISTS "community_voice_notes_coach_all" ON "community_voice_notes";
CREATE POLICY "community_voice_notes_coach_all" ON "community_voice_notes"
  FOR ALL TO public
  USING (app.is_community_workspace_coach("workspace_id"))
  WITH CHECK (app.is_community_workspace_coach("workspace_id"));

-- community_voice_notes: member SELECT. A non-coach member reads a voice note
-- only when it is NOT soft-deleted AND either:
--   * it is a channel/cohort note (conversation_id IS NULL) AND they are a
--     workspace member (cohort_id IS NULL = workspace hall) or share the cohort;
--   * OR it is a DM note (conversation_id IS NOT NULL) AND they are the author.
-- DM participant resolution beyond authorship is enforced in the app layer
-- (CommunityVoiceService) which has the conversation participant list; the DB
-- policy is defence-in-depth and intentionally conservative (author + coach).
DROP POLICY IF EXISTS "community_voice_notes_member_select" ON "community_voice_notes";
CREATE POLICY "community_voice_notes_member_select" ON "community_voice_notes"
  FOR SELECT TO public
  USING (
    "soft_deleted_at" IS NULL
    AND (
      (
        "conversation_id" IS NULL
        AND (
          ("cohort_id" IS NULL AND app.is_community_workspace_member("workspace_id"))
          OR ("cohort_id" IS NOT NULL AND app.shares_community_cohort("cohort_id"))
        )
      )
      OR (
        "conversation_id" IS NOT NULL
        AND "author_id" = app.current_user_id()
      )
    )
  );

COMMIT;
