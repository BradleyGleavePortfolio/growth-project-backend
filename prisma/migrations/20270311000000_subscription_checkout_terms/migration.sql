-- B-RECUR-3 (agent 115, B-654-5 / B-654-7) — native subscription checkout:
-- the terms one attempt is bound to.
--
-- Additive only: one nullable JSONB column on ClientPurchase, no backfill, no
-- index, no RLS change (ClientPurchase policies are row-scoped and cover every
-- column). Written by POST /v1/checkout/subscription-intent on its own
-- reservation before the first Stripe Subscription create:
--   { v, recurring_price_id, one_time_price_id, amount_cents, one_time_cents,
--     currency, interval, interval_count, trial_days }
-- Stripe price ids, amounts and cadence only: no user id, email, token or
-- secret, so nothing is owed to the account-deletion manifest. Existing rows
-- keep NULL (every reader treats NULL as "not pinned").
--
-- Rollback: down.sql drops the column.

BEGIN;

ALTER TABLE "ClientPurchase" ADD COLUMN "checkout_terms" JSONB;

COMMIT;
