-- TGP Session Scheduling / Calendar foundation.
--
-- Additive only. Existing rows are untouched. No backfill required.
--
-- Five new tables (SessionType, CoachAvailability, CoachingSession,
-- SessionParticipant, CalendarConnection) plus four enums
-- (SessionStatus, VideoProvider, CalendarProvider, SessionParticipantRole).
-- All provider integrations ship behind a stub adapter; this migration
-- introduces no rows that depend on Google or Zoom credentials.

-- 1. Enums ---------------------------------------------------------------
CREATE TYPE "SessionStatus" AS ENUM (
    'requested',
    'scheduled',
    'declined',
    'canceled',
    'no_show',
    'completed',
    'pending_provider'
);

CREATE TYPE "VideoProvider" AS ENUM (
    'stub',
    'google_meet',
    'zoom',
    'manual'
);

CREATE TYPE "CalendarProvider" AS ENUM (
    'stub',
    'google_calendar'
);

CREATE TYPE "SessionParticipantRole" AS ENUM (
    'coach',
    'client',
    'admin',
    'assistant_coach'
);

-- 2. SessionType ---------------------------------------------------------
CREATE TABLE "SessionType" (
    "id"                     TEXT NOT NULL,
    "coach_id"               TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "description"            TEXT,
    "duration_minutes"       INTEGER NOT NULL DEFAULT 30,
    "auto_approve"           BOOLEAN NOT NULL DEFAULT false,
    "default_video_provider" "VideoProvider" NOT NULL DEFAULT 'stub',
    "archived_at"            TIMESTAMP(3),
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionType_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SessionType_coach_id_idx" ON "SessionType"("coach_id");
ALTER TABLE "SessionType"
    ADD CONSTRAINT "SessionType_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. CoachAvailability ---------------------------------------------------
CREATE TABLE "CoachAvailability" (
    "id"              TEXT NOT NULL,
    "coach_id"        TEXT NOT NULL,
    "day_of_week"     INTEGER NOT NULL,
    "start_minute"    INTEGER NOT NULL,
    "end_minute"      INTEGER NOT NULL,
    "session_type_id" TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachAvailability_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CoachAvailability_coach_id_day_of_week_idx"
    ON "CoachAvailability"("coach_id", "day_of_week");
ALTER TABLE "CoachAvailability"
    ADD CONSTRAINT "CoachAvailability_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. CoachingSession -----------------------------------------------------
CREATE TABLE "CoachingSession" (
    "id"                       TEXT NOT NULL,
    "coach_id"                 TEXT NOT NULL,
    "client_id"                TEXT,
    "session_type_id"          TEXT,
    "status"                   "SessionStatus" NOT NULL DEFAULT 'requested',
    "start_at"                 TIMESTAMP(3) NOT NULL,
    "end_at"                   TIMESTAMP(3) NOT NULL,
    "title"                    TEXT NOT NULL,
    "coach_notes_md"           TEXT,
    "client_recap_md"          TEXT,
    "video_provider"           "VideoProvider" NOT NULL DEFAULT 'stub',
    "video_url"                TEXT,
    "video_meeting_id"         TEXT,
    "calendar_provider"        "CalendarProvider" NOT NULL DEFAULT 'stub',
    "calendar_event_id"        TEXT,
    "provider_idempotency_key" TEXT,
    "approved_at"              TIMESTAMP(3),
    "ended_at"                 TIMESTAMP(3),
    "end_reason"               TEXT,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachingSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CoachingSession_coach_id_start_at_idx"  ON "CoachingSession"("coach_id", "start_at");
CREATE INDEX "CoachingSession_client_id_start_at_idx" ON "CoachingSession"("client_id", "start_at");
CREATE INDEX "CoachingSession_status_start_at_idx"    ON "CoachingSession"("status", "start_at");
ALTER TABLE "CoachingSession"
    ADD CONSTRAINT "CoachingSession_coach_id_fkey"
    FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoachingSession"
    ADD CONSTRAINT "CoachingSession_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachingSession"
    ADD CONSTRAINT "CoachingSession_session_type_id_fkey"
    FOREIGN KEY ("session_type_id") REFERENCES "SessionType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. SessionParticipant --------------------------------------------------
CREATE TABLE "SessionParticipant" (
    "id"         TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "role"       "SessionParticipantRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionParticipant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SessionParticipant_session_id_user_id_key"
    ON "SessionParticipant"("session_id", "user_id");
CREATE INDEX "SessionParticipant_user_id_idx" ON "SessionParticipant"("user_id");
ALTER TABLE "SessionParticipant"
    ADD CONSTRAINT "SessionParticipant_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "CoachingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionParticipant"
    ADD CONSTRAINT "SessionParticipant_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. CalendarConnection --------------------------------------------------
CREATE TABLE "CalendarConnection" (
    "id"                     TEXT NOT NULL,
    "user_id"                TEXT NOT NULL,
    "provider"               "CalendarProvider" NOT NULL,
    "external_account_id"    TEXT,
    "credentials_secret_ref" TEXT,
    "last_synced_at"         TIMESTAMP(3),
    "disconnected_at"        TIMESTAMP(3),
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CalendarConnection_user_id_provider_external_account_id_key"
    ON "CalendarConnection"("user_id", "provider", "external_account_id");
CREATE INDEX "CalendarConnection_user_id_idx" ON "CalendarConnection"("user_id");
ALTER TABLE "CalendarConnection"
    ADD CONSTRAINT "CalendarConnection_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
