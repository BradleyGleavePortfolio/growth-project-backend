-- A5-COACH-BRIEF (annex lane A5) — Roman daily brief highlights, the coach
-- honorific preference, and Roman reply drafts for unread client messages.
--
-- 1. CoachBriefPreferences.honorific — how Roman addresses the coach in the
--    brief ("first_name" default, or "sir" / "maam"). A preference the coach
--    edits through the existing own-row UPDATE policy.
-- 2. CoachBrief.roman — the deterministic butler-tone highlights payload
--    (money settled to the coach, who messaged, drafts ready, reviews
--    waiting). Server-written like every other CoachBrief column.
-- 3. RomanReplyDraft — one row per (coach, unread source message). It is the
--    idempotency claim and the triage metadata for a Roman reply draft. The
--    draft text and the approve/send pipeline stay in the existing
--    AiActionDraft (capability draft.coach_message) + CoachMessageMaterializer,
--    so there is exactly one AI-draft send path. Server-only table: RLS on,
--    forced, service_role bypass only (the CoachBriefPushLedger posture).

ALTER TABLE "CoachBriefPreferences"
  ADD COLUMN IF NOT EXISTS "honorific" TEXT NOT NULL DEFAULT 'first_name';

ALTER TABLE "CoachBriefPreferences"
  DROP CONSTRAINT IF EXISTS "CoachBriefPreferences_honorific_check";
ALTER TABLE "CoachBriefPreferences"
  ADD CONSTRAINT "CoachBriefPreferences_honorific_check"
  CHECK ("honorific" IN ('first_name', 'sir', 'maam'));

ALTER TABLE "CoachBrief" ADD COLUMN IF NOT EXISTS "roman" JSONB;

CREATE TABLE IF NOT EXISTS "RomanReplyDraft" (
  "id"                    TEXT NOT NULL,
  "coach_id"              TEXT NOT NULL,
  "client_id"             TEXT NOT NULL,
  "source_message_id"     TEXT NOT NULL,
  "ai_draft_id"           TEXT,
  "status"                TEXT NOT NULL DEFAULT 'generating',
  "category"              TEXT,
  "urgency"               TEXT,
  "failure_code"          TEXT,
  "generation_started_at" TIMESTAMP(3),
  "generated_at"          TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RomanReplyDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RomanReplyDraft_status_check"
    CHECK ("status" IN ('generating', 'ready', 'failed', 'superseded')),
  CONSTRAINT "RomanReplyDraft_category_check"
    CHECK ("category" IS NULL OR "category" IN ('question', 'check_in', 'scheduling', 'billing', 'feedback', 'other')),
  CONSTRAINT "RomanReplyDraft_urgency_check"
    CHECK ("urgency" IS NULL OR "urgency" IN ('today', 'soon', 'whenever')),
  CONSTRAINT "RomanReplyDraft_ready_has_draft_check"
    CHECK ("status" <> 'ready' OR "ai_draft_id" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS "RomanReplyDraft_coach_id_source_message_id_key"
  ON "RomanReplyDraft" ("coach_id", "source_message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "RomanReplyDraft_ai_draft_id_key"
  ON "RomanReplyDraft" ("ai_draft_id");
CREATE INDEX IF NOT EXISTS "RomanReplyDraft_coach_id_status_idx"
  ON "RomanReplyDraft" ("coach_id", "status");
CREATE INDEX IF NOT EXISTS "RomanReplyDraft_client_id_idx"
  ON "RomanReplyDraft" ("client_id");

ALTER TABLE "RomanReplyDraft"
  ADD CONSTRAINT "RomanReplyDraft_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RomanReplyDraft"
  ADD CONSTRAINT "RomanReplyDraft_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RomanReplyDraft"
  ADD CONSTRAINT "RomanReplyDraft_source_message_id_fkey"
  FOREIGN KEY ("source_message_id") REFERENCES "CoachMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RomanReplyDraft"
  ADD CONSTRAINT "RomanReplyDraft_ai_draft_id_fkey"
  FOREIGN KEY ("ai_draft_id") REFERENCES "AiActionDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Server-only RLS: no coach / client / anon policy exists, so only the
-- service_role bypass applies (live proof: test/rls/roman-reply-draft-rls.live.spec.ts).
ALTER TABLE "RomanReplyDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RomanReplyDraft" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roman_reply_draft_service_role_bypass" ON "RomanReplyDraft";
CREATE POLICY "roman_reply_draft_service_role_bypass"
  ON "RomanReplyDraft"
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
