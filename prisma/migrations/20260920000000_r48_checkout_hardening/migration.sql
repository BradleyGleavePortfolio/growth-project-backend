-- r48 Checkout hardening — 14 failure-mode mitigations for the guest
-- checkout pipeline. This migration adds the columns + index required
-- by the runtime code; RLS posture is unchanged (GuestCheckout already
-- has FORCE + restrictive deny-all from r43_storefront_phase1).
--
-- Columns added to GuestCheckout:
--   last_reconciled_at  — when the lost-webhook poller last touched
--                         this row. NULL = never reconciled.
--   reconcile_attempts  — bounded counter (max 30 polls = 5 min before
--                         giving up and flipping to reconcile_failed).
--   package_snapshot    — JSONB capture of the package at PaymentIntent
--                         create time so a coach editing mid-checkout
--                         does not change what the guest pays.
--   refunded_at         — set by charge.refunded webhook handler.
--   disputed_at         — set by charge.dispute.created webhook handler.
--   dispute_reason      — Stripe-provided reason on a dispute.
--   receipt_url         — branded PDF receipt URL set by the post-
--                         success ReceiptScheduler (local:// dev,
--                         s3:// in prod).
--
-- Index added: (status, last_reconciled_at)
--   The reconciler scans WHERE status='pending' AND last_reconciled_at
--   <= now()-10s, ordered by last_reconciled_at NULLS FIRST. The
--   composite serves both the filter and the order-by.
--
-- All ALTERs use IF NOT EXISTS so re-running against an already-
-- migrated DB is a no-op.

ALTER TABLE "GuestCheckout"
    ADD COLUMN IF NOT EXISTS "last_reconciled_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "package_snapshot"   JSONB,
    ADD COLUMN IF NOT EXISTS "refunded_at"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "disputed_at"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "dispute_reason"     VARCHAR(500),
    ADD COLUMN IF NOT EXISTS "receipt_url"        TEXT;

CREATE INDEX IF NOT EXISTS "GuestCheckout_status_last_reconciled_at_idx"
    ON "GuestCheckout" ("status", "last_reconciled_at");

-- Reversibility (commented out; forward-only in production):
--   DROP INDEX  IF EXISTS "GuestCheckout_status_last_reconciled_at_idx";
--   ALTER TABLE "GuestCheckout"
--     DROP COLUMN IF EXISTS "receipt_url",
--     DROP COLUMN IF EXISTS "dispute_reason",
--     DROP COLUMN IF EXISTS "disputed_at",
--     DROP COLUMN IF EXISTS "refunded_at",
--     DROP COLUMN IF EXISTS "package_snapshot",
--     DROP COLUMN IF EXISTS "reconcile_attempts",
--     DROP COLUMN IF EXISTS "last_reconciled_at";
