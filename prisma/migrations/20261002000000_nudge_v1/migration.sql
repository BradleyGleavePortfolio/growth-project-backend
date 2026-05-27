-- NUDGE-V1 — Behavioral re-engagement subsystem (PR #282).
--
-- Additive only. Three pieces:
--   1. NotificationPreferences gets 12 new boolean columns (4 trigger
--      types × 3 channels). Defaults chosen to favor opt-in for high-
--      value re-engagement and opt-out for cosmetic touches; see
--      `nudge_v1_plan.md` and the schema-side comment block.
--   2. NudgeLog ledger: one row per (user, trigger_type, signal_key)
--      decision. Status taxonomy enforced at app level.
--   3. cap_bucket column + @@unique([user_id, cap_bucket]) — the
--      atomic primitive for the spec §3 "max 1 nudge per user per 48h"
--      rule. Race-safe across Fly replicas (see audit P1-2 fix).
--
-- Forward-only. Existing NotificationPreferences rows inherit the
-- column defaults; existing User rows pick up the nudge_logs back-ref
-- which has no on-disk footprint (Prisma relation, no FK column).

-- ── NotificationPreferences: 12 new nudge channel toggles ──────────
ALTER TABLE "NotificationPreferences"
  ADD COLUMN IF NOT EXISTS "nudge_missed_checkin_email"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "nudge_missed_checkin_push"         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_missed_checkin_inapp"        BOOLEAN NOT NULL DEFAULT true,
  -- 'practice_paused' is the schema-side name for the 'streak_broken'
  -- product trigger; the schema doctrine bans the literal 'streak_'
  -- substring in prisma/schema.prisma. Mapping lives in the engine.
  ADD COLUMN IF NOT EXISTS "nudge_practice_paused_email"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "nudge_practice_paused_push"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_practice_paused_inapp"       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_onboarding_abandoned_email"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_onboarding_abandoned_push"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_onboarding_abandoned_inapp"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_inactive_email"              BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_inactive_push"               BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "nudge_inactive_inapp"              BOOLEAN NOT NULL DEFAULT true;

-- ── NudgeLog: one row per (user, trigger_type, signal_key) decision ─
CREATE TABLE IF NOT EXISTS "NudgeLog" (
  "id"             TEXT        NOT NULL,
  "user_id"        TEXT        NOT NULL,
  "trigger_type"   TEXT        NOT NULL,
  "signal_key"     TEXT        NOT NULL,
  "status"         TEXT        NOT NULL,
  "channels"       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attempted_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"        TIMESTAMP(3),
  "deferred_until" TIMESTAMP(3),
  -- 48h cap bucket; see audit P1-2 fix. NULL on every non-sent row.
  "cap_bucket"     TIMESTAMP(3),
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("id")
);

-- Idempotency: one decision per (user, trigger_type, signal_key).
CREATE UNIQUE INDEX IF NOT EXISTS "NudgeLog_user_id_trigger_type_signal_key_key"
  ON "NudgeLog"("user_id", "trigger_type", "signal_key");

-- Atomic cap enforcement. PG treats NULL as distinct in unique indexes,
-- so multiple non-sent rows for the same user coexist; only one row
-- per (user, 48h-bucket) can hold a non-NULL cap_bucket → that's the
-- one that actually delivered.
CREATE UNIQUE INDEX IF NOT EXISTS "NudgeLog_user_id_cap_bucket_key"
  ON "NudgeLog"("user_id", "cap_bucket");

-- Read indexes for the cap window scan (Gate 4 read-side) and the
-- deferred / by-status sweeps used by the scheduler.
CREATE INDEX IF NOT EXISTS "NudgeLog_user_id_sent_at_idx"
  ON "NudgeLog"("user_id", "sent_at");
CREATE INDEX IF NOT EXISTS "NudgeLog_status_attempted_at_idx"
  ON "NudgeLog"("status", "attempted_at");
CREATE INDEX IF NOT EXISTS "NudgeLog_status_deferred_until_idx"
  ON "NudgeLog"("status", "deferred_until");

-- ON DELETE CASCADE on user fk so account-deletion sweeps the ledger.
ALTER TABLE "NudgeLog"
  ADD CONSTRAINT "NudgeLog_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
