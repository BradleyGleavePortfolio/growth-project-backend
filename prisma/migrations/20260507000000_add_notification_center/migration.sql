-- Phase 9 — Notifications Matrix
--
-- Two new tables:
--
--   1. Notification — the per-user in-app notification inbox. Every emitter
--      (milestone-reached, message-received, missed-checkin, weight-trend-alert,
--      check-in-submitted, build-week-day-unlocked, coach-alert, etc.) writes one
--      row here. The mobile client polls GET /notifications to render the inbox,
--      and the read_at timestamp drives the unread-badge count.
--
--   2. NotificationDigestLog — idempotency guard for digest email sends.
--      Before each daily / weekly digest run the cron job inserts a row with
--      status 'sending', then updates to 'sent'. On any duplicate run attempt
--      within the same window a row already exists → the send is skipped,
--      so re-running the cron never produces duplicate emails.
--
-- Also extends NotificationPreferences with per-kind channel preferences
-- (email vs push vs in-app) and mute flag so the mobile Notification
-- Settings screen can turn individual kinds on or off per channel.
--
-- Additive only — no existing column, row, or constraint is altered.

-- ──────────────────────────────────────────────────────────────────
-- 1. Notification inbox
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Notification" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"    TEXT        NOT NULL,
  -- Notification kind. Values match NotificationKind enum:
  --   milestone_reached | message_received | missed_checkin |
  --   weight_trend_alert | checkin_submitted | build_week_day_unlocked |
  --   coach_alert | coach_digest | client_digest
  "kind"       TEXT        NOT NULL,
  -- Structured context the mobile client uses to route the deep link.
  -- Example: { "milestoneId": "abc", "weight": 185.5 }
  -- Never contains another user's PII.
  "payload"    JSONB,
  -- Short plain-text body displayed in the notification inbox card.
  -- Max 160 chars. Numeric where possible ("You hit 185 lbs" not "Great job!").
  "body"       TEXT        NOT NULL,
  -- Deep-link destination the mobile client opens on tap.
  -- Format: tgp://screen/param  (e.g. tgp://checkin/today)
  "deep_link"  TEXT,
  -- Delivery channel: 'push' | 'email' | 'inapp'
  "channel"    TEXT        NOT NULL DEFAULT 'inapp',
  "read_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "Notification_user_id_created_at_idx"
  ON "Notification"("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "Notification_user_id_read_at_idx"
  ON "Notification"("user_id", "read_at");

CREATE INDEX IF NOT EXISTS "Notification_kind_created_at_idx"
  ON "Notification"("kind", "created_at" DESC);

-- ──────────────────────────────────────────────────────────────────
-- 2. Digest idempotency log
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "NotificationDigestLog" (
  "id"          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"     TEXT        NOT NULL,
  -- digest kind: 'client_daily' | 'coach_daily' | 'weekly_client' | 'weekly_coach'
  "digest_kind" TEXT        NOT NULL,
  -- ISO-8601 date string of the window this digest covers (e.g. "2026-05-07").
  -- Uniqueness is enforced on (user_id, digest_kind, window_date) so re-running
  -- the cron for the same window is always a no-op.
  "window_date" TEXT        NOT NULL,
  -- 'sending' | 'sent' | 'failed' | 'skipped'
  "status"      TEXT        NOT NULL DEFAULT 'sending',
  "sent_at"     TIMESTAMP(3),
  "error"       TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT "NotificationDigestLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDigestLog_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "NotificationDigestLog_user_digest_window_key"
    UNIQUE ("user_id", "digest_kind", "window_date")
);

CREATE INDEX IF NOT EXISTS "NotificationDigestLog_user_id_digest_kind_idx"
  ON "NotificationDigestLog"("user_id", "digest_kind", "window_date");

CREATE INDEX IF NOT EXISTS "NotificationDigestLog_status_idx"
  ON "NotificationDigestLog"("status", "created_at" DESC);

-- ──────────────────────────────────────────────────────────────────
-- 3. Extend NotificationPreferences with per-kind channel controls
-- ──────────────────────────────────────────────────────────────────

-- Global mute toggle (overrides all per-kind settings).
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "muted"                     BOOLEAN NOT NULL DEFAULT false;

-- Per-kind email enable flags. These are additive and default ON so
-- existing users keep receiving the communications they had before.
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "milestone_email"           BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "milestone_push"            BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "milestone_inapp"           BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "message_email"             BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "message_push"              BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "message_inapp"             BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "missed_checkin_email"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "missed_checkin_push"       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "missed_checkin_inapp"      BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "weight_trend_email"        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "weight_trend_push"         BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "weight_trend_inapp"        BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "checkin_submitted_email"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "checkin_submitted_push"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "checkin_submitted_inapp"   BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "build_week_email"          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "build_week_push"           BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "build_week_inapp"          BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "coach_alert_email"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "coach_alert_push"          BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "coach_alert_inapp"         BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "digest_email"              BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "digest_push"               BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "digest_inapp"              BOOLEAN NOT NULL DEFAULT false;
