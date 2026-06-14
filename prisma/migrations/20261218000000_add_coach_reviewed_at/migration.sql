-- ED.6 (Roman "coach-is-watching" micro-signal) — coach-review timestamps.
--
-- Additive only. Two changes:
--   1. ADD a nullable "coach_reviewed_at" column to the existing "CheckIn"
--      table. Existing rows read NULL (no behaviour change); the client-facing
--      CompetencePill renders "Your coach reviewed this {relative}." off this
--      value and stays hidden while it is NULL. Most-recent semantics — every
--      coach review re-stamps it (brief §Write paths).
--   2. CREATE the "ConversationReview" marker table. The 1:1 coach↔client thread
--      has no first-class Conversation row (it is addressed purely by the
--      (coach_id, client_id) pair on "CoachMessage"), so this thin marker table
--      records when the coach last reviewed a given thread WITHOUT touching the
--      high-traffic "CoachMessage" rows.
--
-- Timestamp 20261218000000 is strictly AFTER the most recent landed migration
-- (20261217000000_community_voice_notes) so the ordered apply never reorders
-- behind a landed migration (R76 §6 / ENGINEERING_RULES §2 append-only). If the
-- parallel L9 search+wearables lane lands a later timestamp, this directory is
-- re-bumped forward by one minute before merge.
--
-- RLS: "CheckIn" already has RLS enabled + FORCEd and carries coach
-- SELECT/UPDATE policies (20260607000000_rls_remaining_gaps) — the new column is
-- covered by the existing row-scoped policies, no policy change needed. The new
-- "ConversationReview" table ENABLEs + FORCEs RLS in THIS migration with an
-- owner-bypass policy plus a participant-scoped FOR ALL policy
-- (ENGINEERING_RULES §2: every new table ships RLS in the same migration).
--
-- Helper functions (app.current_user_id(), app.is_owner()) are provided by the
-- baseline RLS chain and are search_path-hardened by 20261212000000_rls_helper_search_path.
--
-- Rollback (reverse): DROP the policies, DISABLE RLS, DROP the table, then
-- ALTER TABLE "CheckIn" DROP COLUMN "coach_reviewed_at". The Prisma down path is
-- exercised by the migration roundtrip test. Only on a confirmed P0; otherwise
-- fix forward.

BEGIN;

-- Defensive, idempotent schema guard (matches every prior RLS migration).
CREATE SCHEMA IF NOT EXISTS app;

-- 1) AlterTable — additive nullable column on the existing CheckIn table.
ALTER TABLE "CheckIn" ADD COLUMN "coach_reviewed_at" TIMESTAMP(3);

-- 2) CreateTable — per-conversation coach-review marker.
CREATE TABLE "ConversationReview" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "coach_reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReview_coach_id_client_id_key" ON "ConversationReview"("coach_id", "client_id");
CREATE INDEX "ConversationReview_coach_id_idx" ON "ConversationReview"("coach_id");
CREATE INDEX "ConversationReview_client_id_idx" ON "ConversationReview"("client_id");

-- AddForeignKey — Cascade on delete: a hard-deleted participant takes the
-- marker with them (the marker carries no independent audit value once a
-- participant is gone, unlike CoachMessage history which uses SET NULL).
ALTER TABLE "ConversationReview"
    ADD CONSTRAINT "ConversationReview_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationReview"
    ADD CONSTRAINT "ConversationReview_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (ENGINEERING_RULES §2) — enable + FORCE on the new table.
ALTER TABLE "ConversationReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationReview" FORCE ROW LEVEL SECURITY;

-- Owner-staff bypass.
DROP POLICY IF EXISTS "conversation_review_owner_all" ON "ConversationReview";
CREATE POLICY "conversation_review_owner_all" ON "ConversationReview"
  FOR ALL TO public
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- Participant access: the coach OR the client of the thread may read/write the
-- marker. Mirrors the CoachMessage participant policy
-- (20260607000000_rls_remaining_gaps). The runtime app connects as Supabase
-- service_role (BYPASSRLS) and scopes itself in the service layer; this policy
-- is defence-in-depth for any non-service-role connection.
DROP POLICY IF EXISTS "conversation_review_participant_access" ON "ConversationReview";
CREATE POLICY "conversation_review_participant_access" ON "ConversationReview"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id" = app.current_user_id()
      OR "client_id" = app.current_user_id()
    )
  );

COMMIT;
