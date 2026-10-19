-- GC-PHONE: GuestCheckout.guest_phone, the buyer's phone from the web pay
-- page (name, phone, email, then checkout). Additive and nullable, no data
-- change: rows from before it stay NULL. The CHECK holds the API's rule
-- (E.164, src/storefront/storefront.dto.ts). The 13-month PII scrub and
-- account deletion set it to NULL.
-- Row rules: unchanged. GuestCheckout keeps RLS enabled and forced with the
-- restrictive deny-all policies of 20260801000000 for every API role; only
-- the server's service_role reads or writes it. Live proof:
-- test/rls/gc-phone-rls.spec.ts (rls-live-tests). Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "GuestCheckout"
  ADD COLUMN "guest_phone" TEXT,
  ADD CONSTRAINT "GuestCheckout_guest_phone_check"
    CHECK ("guest_phone" IS NULL OR "guest_phone" ~ '^\+[1-9][0-9]{6,14}$');

COMMIT;
