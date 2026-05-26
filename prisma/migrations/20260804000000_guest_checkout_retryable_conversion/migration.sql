-- R43 Audit #3 P1-6 + P1-7 — retryable conversion + split processed-event
-- semantics.
--
-- 1. GuestCheckout learns two new states: `conversion_failed_retryable`
--    (Supabase or DB write failed after Stripe took the money) and
--    `conversion_failed_terminal` (retry budget exhausted; on-call must
--    intervene). The legacy `failed` terminal is preserved only for the
--    pre-payment Stripe PI failure path.
-- 2. Three new columns drive reconciliation: retry_count, last_error,
--    last_retry_at. last_error is a short machine-readable tag (no PII).
-- 3. The status CHECK constraint is dropped + re-added with the expanded
--    enum. We keep the constraint name stable so future migrations can
--    target it by name.
-- 4. A composite index (status, last_retry_at) backs the reconciliation
--    worker scan: `WHERE status = 'conversion_failed_retryable' ORDER BY
--    last_retry_at NULLS FIRST LIMIT N`.
-- 5. StripeProcessedEvent learns handler_completed_at — webhook receipt
--    is recorded immediately so we always return 200, but handler
--    completion is recorded separately so the reconciliation worker can
--    detect "Stripe acknowledged, fulfillment never finished" cases.

-- ─── Step 1: New columns on GuestCheckout ───────────────────────────────

ALTER TABLE "GuestCheckout"
    ADD COLUMN IF NOT EXISTS "retry_count"   INT     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "last_error"    TEXT,
    ADD COLUMN IF NOT EXISTS "last_retry_at" TIMESTAMP(3);

-- ─── Step 2: Expanded status CHECK constraint ───────────────────────────
-- Drop the existing 4-value constraint and re-add the 6-value version.
-- Drop is idempotent (IF EXISTS); ADD runs unconditionally because the
-- name has already been removed.

ALTER TABLE "GuestCheckout"
    DROP CONSTRAINT IF EXISTS "GuestCheckout_status_check";

ALTER TABLE "GuestCheckout"
    ADD CONSTRAINT "GuestCheckout_status_check"
    CHECK (status IN (
        'pending',
        'paid',
        'failed',
        'converted',
        'conversion_failed_retryable',
        'conversion_failed_terminal'
    ));

-- ─── Step 3: Reconciliation scan index ──────────────────────────────────

CREATE INDEX IF NOT EXISTS "GuestCheckout_status_last_retry_at_idx"
    ON "GuestCheckout" ("status", "last_retry_at");

-- ─── Step 4: StripeProcessedEvent handler-completion column ─────────────

ALTER TABLE "StripeProcessedEvent"
    ADD COLUMN IF NOT EXISTS "handler_completed_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "StripeProcessedEvent_handler_completed_at_idx"
    ON "StripeProcessedEvent" ("handler_completed_at");

-- ─── Reversibility (P3-2) ───────────────────────────────────────────────
-- Forward-only in production. Roll back in dev/staging by:
--
-- DROP INDEX IF EXISTS "StripeProcessedEvent_handler_completed_at_idx";
-- ALTER TABLE "StripeProcessedEvent" DROP COLUMN IF EXISTS "handler_completed_at";
-- DROP INDEX IF EXISTS "GuestCheckout_status_last_retry_at_idx";
-- ALTER TABLE "GuestCheckout" DROP CONSTRAINT IF EXISTS "GuestCheckout_status_check";
-- ALTER TABLE "GuestCheckout" ADD CONSTRAINT "GuestCheckout_status_check"
--     CHECK (status IN ('pending', 'paid', 'failed', 'converted'));
-- ALTER TABLE "GuestCheckout"
--     DROP COLUMN IF EXISTS "last_retry_at",
--     DROP COLUMN IF EXISTS "last_error",
--     DROP COLUMN IF EXISTS "retry_count";
