-- R43 Audit #3 P2-3 — PII retention policy on GuestCheckout.
--
-- guest_email and guest_name are raw text on a public-checkout table.
-- Without a retention deadline this is exactly the kind of identity
-- data a hostile-lawyer / GDPR review will hammer us on.
--
-- 1. data_retention_at — set to created_at + 13 months by default. A
--    daily scrub job (GuestCheckoutPiiScrubService) walks rows past
--    this deadline that never converted to a real User and:
--      - Replaces guest_email with SHA-256(lower(email) || salt)
--      - Replaces guest_name with 'REDACTED'
--      - Stamps scrubbed_at so future runs skip it.
--    Converted rows have a User record that owns the same identity
--    data with its own retention rules — we don't double-scrub.
-- 2. scrubbed_at — bookkeeping for the scrub job.
-- 3. Index on (data_retention_at, scrubbed_at) backs the scrub scan:
--      WHERE data_retention_at <= now()
--        AND scrubbed_at IS NULL
--        AND created_user_id IS NULL
--      ORDER BY data_retention_at ASC
--      LIMIT N

ALTER TABLE "GuestCheckout"
    ADD COLUMN IF NOT EXISTS "data_retention_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "scrubbed_at"       TIMESTAMP(3);

-- Backfill: every existing row that doesn't already carry a retention
-- deadline gets created_at + 13 months. Idempotent (only fills NULLs).
UPDATE "GuestCheckout"
SET "data_retention_at" = "created_at" + INTERVAL '13 months'
WHERE "data_retention_at" IS NULL;

CREATE INDEX IF NOT EXISTS "GuestCheckout_data_retention_at_scrubbed_at_idx"
    ON "GuestCheckout" ("data_retention_at", "scrubbed_at");

-- ─── Reversibility (P3-2) ───────────────────────────────────────────────
-- Forward-only in production. Roll back in dev/staging by:
--
-- DROP INDEX IF EXISTS "GuestCheckout_data_retention_at_scrubbed_at_idx";
-- ALTER TABLE "GuestCheckout"
--     DROP COLUMN IF EXISTS "scrubbed_at",
--     DROP COLUMN IF EXISTS "data_retention_at";
