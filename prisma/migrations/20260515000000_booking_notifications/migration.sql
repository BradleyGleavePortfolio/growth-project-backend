-- Concierge booking notifications — Phase 1.
--
-- Additive only. Existing rows untouched.
--
--   1. NotificationPreferences gains booking_inapp / booking_push /
--      booking_email columns with defaults matching
--      NotificationsService.getPreferences(). One cluster pref covers
--      all booking.* kinds; splitting per-event is deferred.
--   2. NotificationDeliveryLog table — idempotency ledger for the
--      24h / 1h booking reminder cron. UNIQUE(session_id, user_id,
--      kind) guarantees a single dispatch per (session, user, kind)
--      even with concurrent cron replicas.

-- 1. Preferences columns -------------------------------------------------
ALTER TABLE "NotificationPreferences"
    ADD COLUMN "booking_email" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "booking_push"  BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "booking_inapp" BOOLEAN NOT NULL DEFAULT true;

-- 2. NotificationDeliveryLog --------------------------------------------
CREATE TABLE "NotificationDeliveryLog" (
    "id"         TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind"       TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDeliveryLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDeliveryLog_session_user_kind_key"
    ON "NotificationDeliveryLog"("session_id", "user_id", "kind");

CREATE INDEX "NotificationDeliveryLog_session_id_idx"
    ON "NotificationDeliveryLog"("session_id");

CREATE INDEX "NotificationDeliveryLog_user_id_created_at_idx"
    ON "NotificationDeliveryLog"("user_id", "created_at");

ALTER TABLE "NotificationDeliveryLog"
    ADD CONSTRAINT "NotificationDeliveryLog_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDeliveryLog"
    ADD CONSTRAINT "NotificationDeliveryLog_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "CoachingSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
