-- Reverse of 20270502006800_guest_checkout_phone, for a confirmed defect
-- only: drops the buyer's phone on every guest checkout (data loss for that
-- column only; its CHECK goes with it). No policy changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "GuestCheckout" DROP COLUMN IF EXISTS "guest_phone";

COMMIT;
