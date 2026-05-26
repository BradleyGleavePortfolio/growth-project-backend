-- Fix Round 5 P1-4: bounded push retry on CoachBriefPushLedger.
--
-- Pre-fix-round-5 the scheduler set last_push_attempt_date to today
-- BEFORE calling pushToUser. A transient Expo failure consumed the
-- whole day's slot and the coach never received the brief even though
-- it was ready.
--
-- This migration adds two columns that implement a bounded retry:
--
--   push_attempt_lease_until  TIMESTAMP(3)  -- short-lived lease taken
--     right before the Expo call. Concurrent cron instances see the
--     lease and back off; a stale lease (now > lease_until) is
--     reclaimable so a crashed worker cannot wedge dispatch.
--
--   push_attempts_today       INTEGER NOT NULL DEFAULT 0 -- retry
--     counter scoped to last_push_attempt_date. Capped in app code at
--     MAX_PUSH_ATTEMPTS so an Expo outage cannot drive unbounded calls;
--     resets to 0 when last_push_attempt_date rolls to a new day.

ALTER TABLE "CoachBriefPushLedger"
  ADD COLUMN IF NOT EXISTS "push_attempt_lease_until" TIMESTAMP(3);

ALTER TABLE "CoachBriefPushLedger"
  ADD COLUMN IF NOT EXISTS "push_attempts_today" INTEGER NOT NULL DEFAULT 0;

-- Reversibility:
--
--   ALTER TABLE "CoachBriefPushLedger" DROP COLUMN IF EXISTS "push_attempt_lease_until";
--   ALTER TABLE "CoachBriefPushLedger" DROP COLUMN IF EXISTS "push_attempts_today";
--
-- Safe to roll back as long as the scheduler has been redeployed to
-- the pre-P1-4 logic that did not reference these columns.
