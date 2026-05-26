-- A276 P0-1 (refix) — extend GuestCheckout_status_check to admit
-- 'refunded' and 'disputed' as first-class terminal-ish states.
--
-- Why
-- ───
-- The 2026-08-04 migration (20260804000000_guest_checkout_retryable_conversion)
-- locked the status CHECK to a 6-value enum that omitted the two
-- post-fulfilment states that the refund + dispute webhook handlers
-- need to write:
--
--   - charge.refunded  → GuestCheckout.status = 'refunded'
--   - charge.dispute.* → GuestCheckout.status = 'disputed'
--
-- The r48 Hardening migration (20260920000000_r48_checkout_hardening)
-- added the `refunded_at` / `disputed_at` / `dispute_reason` columns
-- but never reopened the CHECK constraint. Result: every full refund
-- and every dispute webhook would fail with Postgres 23514
-- (check_violation), Fix 7 propagates the throw, BillingService's
-- outer $transaction rolls back, Stripe sees a 5xx and re-delivers on
-- exponential backoff for up to 3 days. The row stays stuck in 'paid',
-- entitlement is never revoked, coach is never alerted.
--
-- Decacorn choice
-- ───────────────
-- Refund and dispute are real domain states of a GuestCheckout, not
-- bookkeeping flags. Modelling them via a `status` value (rather than
-- collapsing into `'converted'` + a `refunded_at` boolean) preserves
-- the existing one-column query shape that admin dashboards already
-- use (`WHERE status = 'refunded'` for refund reports) and keeps the
-- state machine explicit. The two new states are sibling terminals to
-- `'converted'`:
--
--   pending ─→ paid ─→ converted ─→ refunded   (full refund, after conversion)
--   pending ─→ paid           ─→ refunded      (full refund, race window)
--   pending ─→ paid ─→ converted ─→ disputed   (chargeback opened)
--   pending ─→ paid           ─→ disputed      (chargeback, race window)
--
-- The new constraint name is kept stable so the next migration that
-- needs to extend it can target it by name without grepping.
--
-- Forward-only in production. Roll back in dev/staging by re-adding
-- the 6-value version (see the 2026-08-04 migration for the SQL).

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
        'conversion_failed_terminal',
        'refunded',
        'disputed'
    ));
