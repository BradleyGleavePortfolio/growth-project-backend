-- RLS policies for financial tables + CoachMessage NULL-sender fix
-- Migration: 20260606000003_rls_financial_tables
--
-- Column names verified against prisma/schema.prisma (as of 2026-06-06):
--   ClientPurchase  : client_user_id, coach_user_id
--   ConnectCustomer : client_user_id
--   ConnectAccount  : coach_user_id
--   Invoice         : coach_id  (no client_id column — platform invoice for coach billing)
--   CoachPackage    : coach_id
--   CoachMessage    : coach_id, client_id, sender_id  (all nullable / SET NULL on user delete)
--
-- SAFE TO RE-RUN: all DROP POLICY IF EXISTS statements precede every CREATE POLICY.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enable RLS on financial tables
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "ClientPurchase"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectCustomer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectAccount"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPackage"    ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ClientPurchase
--    • client_user_id — the buying client
--    • coach_user_id  — the selling coach
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "client_purchase_select" ON "ClientPurchase";
CREATE POLICY "client_purchase_select" ON "ClientPurchase"
  FOR SELECT USING (
    app.current_user_id() IS NOT NULL
    AND (
      "client_user_id" = app.current_user_id()
      OR "coach_user_id" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS "client_purchase_insert" ON "ClientPurchase";
CREATE POLICY "client_purchase_insert" ON "ClientPurchase"
  FOR INSERT WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_user_id" = app.current_user_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ConnectCustomer (Stripe Customer mirror per client)
--    • client_user_id — the client who owns the Stripe Customer record
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "connect_customer_select" ON "ConnectCustomer";
CREATE POLICY "connect_customer_select" ON "ConnectCustomer"
  FOR SELECT USING (
    app.current_user_id() IS NOT NULL
    AND "client_user_id" = app.current_user_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ConnectAccount (Stripe Express account per coach)
--    • coach_user_id — the coach who owns the Express account
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "connect_account_select" ON "ConnectAccount";
CREATE POLICY "connect_account_select" ON "ConnectAccount"
  FOR SELECT USING (
    app.current_user_id() IS NOT NULL
    AND "coach_user_id" = app.current_user_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Invoice (platform Stripe invoice for coach SaaS billing)
--    • coach_id — the coach billed; no client_id column in this table
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "invoice_select" ON "Invoice";
CREATE POLICY "invoice_select" ON "Invoice"
  FOR SELECT USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CoachPackage (coach's publicly-listable product offers)
--    • coach_id — the owning coach
--    Coaches manage their own packages (all operations).
--    Clients / unauthenticated visitors can read active packages (public catalog).
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "coach_package_coach_all" ON "CoachPackage";
CREATE POLICY "coach_package_coach_all" ON "CoachPackage"
  FOR ALL USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
  );

DROP POLICY IF EXISTS "coach_package_client_select" ON "CoachPackage";
CREATE POLICY "coach_package_client_select" ON "CoachPackage"
  FOR SELECT USING (true); -- public read — packages are publicly listable

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. CoachMessage — fix NULL-sender bug
--
--    PROBLEM: the old policy used IS NOT DISTINCT FROM which evaluates to TRUE
--    when BOTH sides are NULL. Because coach_id / client_id / sender_id are
--    nullable (SET NULL on user delete), a hard-deleted user leaves rows where
--    all three FKs are NULL. When app.current_user_id() also returns NULL
--    (unauthenticated session), every IS NOT DISTINCT FROM check passes and
--    ALL orphaned messages become visible to anonymous requests.
--
--    FIX: require a non-NULL current_user_id() before any FK comparison.
--    IS NOT DISTINCT FROM is preserved for the FK comparisons themselves
--    (needed to match non-null IDs) but the outer NULL guard prevents
--    unauthenticated access.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "coach_message_participant_access" ON "CoachMessage";
CREATE POLICY "coach_message_participant_access" ON "CoachMessage"
  FOR ALL TO public
  USING (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id"  = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  )
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND (
      "coach_id"  = app.current_user_id()
      OR "client_id" = app.current_user_id()
      OR "sender_id" = app.current_user_id()
    )
  );

COMMIT;
