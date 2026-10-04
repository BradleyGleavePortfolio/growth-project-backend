-- Rollback of 20270311000000_subscription_checkout_terms (B-RECUR-3).
-- Drops the attempt-terms snapshot. Safe: the checkout treats a missing
-- snapshot as "not pinned" and reads today's package terms.
BEGIN;

ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "checkout_terms";

COMMIT;
