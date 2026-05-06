-- Phase 6C + 6D — Async voice notes on coach<->client messages,
-- and Coach Onboarding Wizard progress tracking.
--
-- Additive only. No existing column is dropped. The existing CoachMessage.body
-- column is loosened from NOT NULL to nullable so a row with a voice
-- attachment and no text can persist; existing rows already satisfy the new
-- constraint (a row with body NOT NULL is still valid). The MessagingService
-- enforces "at least one of body or voice_url" at write-time.
--
-- Doctrine reminders:
--   * Voice metadata (size_bytes, duration_sec, content_type) is set
--     server-side from the accepted upload — never trusted from the client.
--   * Voice content_type whitelist is enforced in the service layer:
--     ['audio/mp4','audio/m4a','audio/aac','audio/webm','audio/ogg'].
--   * Voice size and duration limits are clamped from VOICE_NOTE_MAX_*
--     env vars; defaults: 5 MB / 300 s.
--   * CoachOnboardingProgress is 1:1 with a coach User. Re-promoting the
--     same user is idempotent — AdminService.promoteUser swallows P2002
--     when COACH_ONBOARDING_AUTO_START=true.

-- 1. Voice columns on CoachMessage ----------------------------------------

-- Make body nullable so voice-only messages can persist without a placeholder
-- body string. Existing NOT NULL rows continue to satisfy the new column.
ALTER TABLE "CoachMessage" ALTER COLUMN "body" DROP NOT NULL;

ALTER TABLE "CoachMessage"
  ADD COLUMN "voice_url"          TEXT,
  ADD COLUMN "voice_duration_sec" INTEGER,
  ADD COLUMN "voice_size_bytes"   INTEGER,
  ADD COLUMN "voice_content_type" TEXT;

-- 2. CoachOnboardingProgress (Phase 6D) -----------------------------------

CREATE TABLE "CoachOnboardingProgress" (
  "id"           TEXT        NOT NULL,
  "coach_id"     TEXT        NOT NULL,
  "started_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "current_step" INTEGER     NOT NULL DEFAULT 1,
  "step_data"    JSONB,
  CONSTRAINT "CoachOnboardingProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachOnboardingProgress_coach_id_key"
  ON "CoachOnboardingProgress" ("coach_id");

CREATE INDEX "CoachOnboardingProgress_completed_at_idx"
  ON "CoachOnboardingProgress" ("completed_at");

ALTER TABLE "CoachOnboardingProgress"
  ADD CONSTRAINT "CoachOnboardingProgress_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
