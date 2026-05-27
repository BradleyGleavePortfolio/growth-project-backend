-- Dunning v1 follow-up: send-retry bookkeeping + CAS claim columns.
--
-- Additive only. Backfills retry_count default to 0 for existing rows.
--
-- Added columns:
--   retry_count    - number of email.send() failures for this attempt.
--                    Bounded by DUNNING_MAX_SEND_RETRIES; once exceeded the
--                    row is marked status='failed_permanent' and dropped
--                    from the tick scan.
--   next_retry_at  - exponential backoff target. Tick picks status='failed'
--                    rows whose next_retry_at <= now.
--   superseded_at  - audit timestamp set when a payment recovery webhook
--                    raced ahead of an in-flight email send and the send
--                    had already been claimed (status='sending'). PR #281
--                    P1-1.
--
-- New status values introduced by this migration (no enum/constraint to
-- alter \u2014 status is a free-form TEXT column):
--   'sending'           transient CAS-claim state between pending and sent
--   'failed_permanent'  send retry budget exhausted
--
-- Backfill: existing rows have retry_count=0 and next_retry_at/
-- superseded_at NULL, which matches "no retries attempted yet" \u2014 the
-- tick loop treats those identically to fresh rows.

ALTER TABLE "DunningAttempt"
  ADD COLUMN "retry_count"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_retry_at"  TIMESTAMP(3),
  ADD COLUMN "superseded_at"  TIMESTAMP(3);

CREATE INDEX "DunningAttempt_status_next_retry_at_idx"
  ON "DunningAttempt" ("status", "next_retry_at");
