-- R81 BACKFILL CLEANUP — revert tail of PR #395 / PR #402 (the
-- CoachFirstPaymentNotification first-payment ledger).
--
-- The original additive migration 20260614065425_add_coach_first_payment_notification
-- is being removed from main as part of the R81 revert of PR #395 (and its
-- follow-up PR #402). The Prisma model + its source were reverted in the same
-- change set; this forward migration drops the table the original migration
-- created so the database schema stays in lock-step with the reverted Prisma
-- schema. The original migration is NOT edited (R77 / immutable-history) — this
-- is a new, forward migration ordered strictly after 20261218000000_add_coach_reviewed_at.
--
-- The feature shipped behind FEATURE_ROMAN_FIRST_PAYMENT (default OFF) and the
-- only write path is the Stripe webhook handler, which was reverted, so the
-- table is empty in every environment. A clean DROP is therefore safe.
--
-- Non-empty-environment preflight (PR #405 re-audit N1 safety pattern). The DROP
-- below is empty-table-only; this guard makes that contract EXECUTABLE. If the
-- ledger holds rows, abort the transaction loudly and redirect to the R82
-- tracking issue
-- (https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/407)
-- backfill path BEFORE any destructive DROP — never lose data silently.
-- to_regclass(...) IS NOT NULL keeps it safe when the table is absent (fresh
-- environment / never-applied original migration), preserving idempotency.
--
-- The rebuilt feature (PR replacing #395+#402, with N1 push-throttle fix) ships
-- its OWN forward migration that recreates this table with identical DDL, ordered
-- strictly after this drop.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.coach_first_payment_notification') IS NOT NULL
     AND EXISTS (SELECT 1 FROM "coach_first_payment_notification" LIMIT 1) THEN
    RAISE EXCEPTION 'Refusing to drop coach_first_payment_notification: table is non-empty; stop and follow GitHub issue #407 backfill path before applying 20261220000000';
  END IF;
END $$;

-- IF EXISTS keeps the migration idempotent (table may never have been created in
-- environments where the original additive migration was not yet applied). The
-- FK, unique index, and RLS policies created by the original migration are owned
-- by this table and are removed by the DROP.
DROP TABLE IF EXISTS "coach_first_payment_notification";

COMMIT;
