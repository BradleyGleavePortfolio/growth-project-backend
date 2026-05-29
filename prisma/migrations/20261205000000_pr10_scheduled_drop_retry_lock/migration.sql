-- PR-10 — DripDispatcherCron retry/backoff + double-dispatch claim columns.
--
-- Three new nullable columns on ScheduledDrop and one supporting index.
-- All additive: no DROP, no RENAME, no type change, no NOT-NULL backfill.
-- Existing rows (NULL on all three) behave exactly as today:
--   * locked_at IS NULL  → not currently claimed by any cron worker
--   * next_retry_at IS NULL → eligible immediately (status+fire_at still gate)
--   * alert_dispatched_at IS NULL → unlock-alert not yet sent (idempotency)
--
-- WHY each column:
--   * locked_at — claim stamp used by the @Cron tick to mark a row as
--     "currently being dispatched by this worker". Combined with an atomic
--     UPDATE...WHERE status='pending' AND (locked_at IS NULL OR <
--     stale-cutoff) it gives us mutex-style claim-before-work so two
--     simultaneous cron instances on a multi-replica deploy can never both
--     materialise the same drop. The stale-cutoff lets a crashed worker's
--     claim expire (default 5 minutes) so a drop never gets stuck.
--   * next_retry_at — exponential-backoff timer. On materialisation failure
--     attempt_count++ and next_retry_at = now() + backoff(attempts). Tick
--     query gates on (next_retry_at IS NULL OR next_retry_at <= now()) so
--     a transient resolver failure doesn't hammer the resolver every minute.
--   * alert_dispatched_at — idempotency for the buyer push+in-app alert.
--     A drop that successfully materialised but whose alert push failed
--     must NOT un-deliver the content (per decision #9); leaving this
--     column NULL after a successful materialise allows a future safety
--     sweep to retry just the alert without touching materialised_ref.
--     Set non-null after the alert dispatch attempt completes (success or
--     swallowed-failure) so the cron never re-pushes for the same drop.
--
-- Index `[status, next_retry_at, fire_at]` accelerates the dispatcher's hot
-- query: WHERE status='pending' AND fire_at <= now() AND materialised_ref IS
-- NULL AND (next_retry_at IS NULL OR next_retry_at <= now()).
ALTER TABLE "ScheduledDrop" ADD COLUMN "locked_at" TIMESTAMP(3);
ALTER TABLE "ScheduledDrop" ADD COLUMN "next_retry_at" TIMESTAMP(3);
ALTER TABLE "ScheduledDrop" ADD COLUMN "alert_dispatched_at" TIMESTAMP(3);

CREATE INDEX "ScheduledDrop_status_next_retry_at_fire_at_idx"
  ON "ScheduledDrop"("status", "next_retry_at", "fire_at");
