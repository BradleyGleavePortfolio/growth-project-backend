-- R43 Storefront Phase 1 — Package share links + guest checkout.
--
-- 1. Adds three nullable/defaulted columns to CoachPackage so a coach can
--    mint a short share token, pause acquisitions, and audit when the link
--    was first generated.
-- 2. Creates the GuestCheckout table that tracks every non-authed purchase
--    attempt with a strict status machine and a unique idempotency key.
-- 3. Locks GuestCheckout with RLS ENABLE + FORCE + restrictive deny-all
--    policies — only the Prisma service-role connection (which bypasses
--    RLS) may read or write the table. This mirrors the SplitLedgerEntry /
--    ConnectTransfer pattern: financial rows touched only by server code.
-- 4. Adds a CHECK constraint that enforces the four valid status values at
--    the database layer.

-- ─── Step 1: CoachPackage share-link columns ────────────────────────────

ALTER TABLE "CoachPackage"
    ADD COLUMN IF NOT EXISTS "share_token"             TEXT,
    ADD COLUMN IF NOT EXISTS "share_link_enabled"      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS "share_link_generated_at" TIMESTAMP(3);

-- Unique index doubles as the @unique constraint Prisma expects and as a
-- partial index for the public lookup (`WHERE share_token = $1`). NULL
-- tokens are allowed in unlimited supply; only minted tokens are policed
-- for collision.
--
-- Audit #4 P2-7 — the CoachPackage table is pre-existing and may be
-- large by the time this lands. A plain CREATE UNIQUE INDEX takes an
-- ACCESS EXCLUSIVE lock that blocks every write to the table for the
-- duration of the build, which on a hot OLTP table is a stall the
-- billing surface cannot absorb. The correct production play is:
--
--   1. Run the migration with CONCURRENTLY OFF only on dev/test, where
--      the table is small. The IF NOT EXISTS guard makes this idempotent.
--   2. On staging/production, run the index build manually via psql
--      BEFORE applying the migration:
--        CREATE UNIQUE INDEX CONCURRENTLY "CoachPackage_share_token_key"
--          ON "CoachPackage" ("share_token")
--          WHERE "share_token" IS NOT NULL;
--      Then `prisma migrate deploy` short-circuits the IF NOT EXISTS.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, and Prisma
-- migrate deploy wraps every file in a transaction — hence the manual
-- ops step. See R44 in AGENT_RULES.md for the runbook.
CREATE UNIQUE INDEX IF NOT EXISTS "CoachPackage_share_token_key"
    ON "CoachPackage" ("share_token")
    WHERE "share_token" IS NOT NULL;

-- ─── Step 2: GuestCheckout table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "GuestCheckout" (
    "id"                       TEXT      NOT NULL PRIMARY KEY,
    "package_id"               TEXT      NOT NULL,
    "stripe_payment_intent_id" TEXT      NOT NULL,
    "stripe_customer_id"       TEXT,
    "guest_email"              TEXT      NOT NULL,
    "guest_name"               TEXT      NOT NULL,
    "status"                   TEXT      NOT NULL DEFAULT 'pending',
    "created_user_id"          TEXT,
    "idempotency_key"          TEXT      NOT NULL,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GuestCheckout_package_id_fkey"
        FOREIGN KEY ("package_id") REFERENCES "CoachPackage" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GuestCheckout_created_user_id_fkey"
        FOREIGN KEY ("created_user_id") REFERENCES "User" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "GuestCheckout_stripe_payment_intent_id_key"
    ON "GuestCheckout" ("stripe_payment_intent_id");

CREATE UNIQUE INDEX IF NOT EXISTS "GuestCheckout_idempotency_key_key"
    ON "GuestCheckout" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "GuestCheckout_package_id_idx"
    ON "GuestCheckout" ("package_id");

CREATE INDEX IF NOT EXISTS "GuestCheckout_status_idx"
    ON "GuestCheckout" ("status");

-- Audit #4 P2-6 — raw email index intentionally NOT created.
-- Indexing guest_email reveals a per-row PII surface in index
-- pages (and via the index leaf in pg_stat_user_indexes ops)
-- without any matching query benefit — we never lookup by
-- guest_email at runtime. The scrub job uses
-- (data_retention_at, scrubbed_at) and is unaffected.

CREATE INDEX IF NOT EXISTS "GuestCheckout_stripe_payment_intent_id_idx"
    ON "GuestCheckout" ("stripe_payment_intent_id");

-- ─── Step 3: CHECK constraint on status ─────────────────────────────────
-- Prisma cannot model a CHECK at the schema level, so we enforce the
-- enum at the DB layer. Anything outside the four valid values fails on
-- INSERT/UPDATE.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'GuestCheckout_status_check'
    ) THEN
        ALTER TABLE "GuestCheckout"
            ADD CONSTRAINT "GuestCheckout_status_check"
            CHECK (status IN ('pending', 'paid', 'failed', 'converted'));
    END IF;
END
$$;

-- ─── Step 4: Row-Level Security ─────────────────────────────────────────
-- ENABLE + FORCE so even the table owner (the Supabase role used in
-- pgAdmin) cannot read or write rows unless a policy matches. We then
-- attach RESTRICTIVE deny-all policies for SELECT / INSERT / UPDATE /
-- DELETE. RESTRICTIVE policies AND with any other PERMISSIVE policies
-- attached later — without an explicit additional permissive policy,
-- non-service roles see exactly zero rows. The Prisma client connects as
-- the service role, which bypasses RLS entirely.

ALTER TABLE "GuestCheckout" ENABLE  ROW LEVEL SECURITY;
ALTER TABLE "GuestCheckout" FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guest_checkout_deny_all_select" ON "GuestCheckout";
DROP POLICY IF EXISTS "guest_checkout_deny_all_insert" ON "GuestCheckout";
DROP POLICY IF EXISTS "guest_checkout_deny_all_update" ON "GuestCheckout";
DROP POLICY IF EXISTS "guest_checkout_deny_all_delete" ON "GuestCheckout";

CREATE POLICY "guest_checkout_deny_all_select" ON "GuestCheckout"
    AS RESTRICTIVE
    FOR SELECT
    USING (false);

CREATE POLICY "guest_checkout_deny_all_insert" ON "GuestCheckout"
    AS RESTRICTIVE
    FOR INSERT
    WITH CHECK (false);

CREATE POLICY "guest_checkout_deny_all_update" ON "GuestCheckout"
    AS RESTRICTIVE
    FOR UPDATE
    USING (false)
    WITH CHECK (false);

CREATE POLICY "guest_checkout_deny_all_delete" ON "GuestCheckout"
    AS RESTRICTIVE
    FOR DELETE
    USING (false);

-- ─── Reversibility (P3-2) ───────────────────────────────────────────────
-- This migration is forward-only in production; the block below documents
-- the exact reverse order so an operator can roll back in dev/staging if
-- the storefront launch is aborted. Statements are commented out to keep
-- `prisma migrate deploy` happy.
--
-- ROLLBACK (reverse order — RLS → CHECK → table → CoachPackage columns):
--
-- DROP POLICY IF EXISTS "guest_checkout_deny_all_delete" ON "GuestCheckout";
-- DROP POLICY IF EXISTS "guest_checkout_deny_all_update" ON "GuestCheckout";
-- DROP POLICY IF EXISTS "guest_checkout_deny_all_insert" ON "GuestCheckout";
-- DROP POLICY IF EXISTS "guest_checkout_deny_all_select" ON "GuestCheckout";
-- ALTER TABLE "GuestCheckout" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "GuestCheckout" DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE "GuestCheckout" DROP CONSTRAINT IF EXISTS "GuestCheckout_status_check";
-- DROP INDEX IF EXISTS "GuestCheckout_stripe_payment_intent_id_idx";
-- DROP INDEX IF EXISTS "GuestCheckout_status_idx";
-- DROP INDEX IF EXISTS "GuestCheckout_package_id_idx";
-- DROP INDEX IF EXISTS "GuestCheckout_idempotency_key_key";
-- DROP INDEX IF EXISTS "GuestCheckout_stripe_payment_intent_id_key";
-- DROP TABLE IF EXISTS "GuestCheckout";
-- DROP INDEX IF EXISTS "CoachPackage_share_token_key";
-- ALTER TABLE "CoachPackage"
--     DROP COLUMN IF EXISTS "share_link_generated_at",
--     DROP COLUMN IF EXISTS "share_link_enabled",
--     DROP COLUMN IF EXISTS "share_token";
