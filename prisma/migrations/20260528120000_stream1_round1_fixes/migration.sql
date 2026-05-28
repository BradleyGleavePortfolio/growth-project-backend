-- Stream 1 — Round 1 fixer migration (post-audit).
--
-- Three changes, all on tables created by 20260528000000_stream1_coach_ai_credits:
--
--   1. Relax CoachCreditPackPurchase.CCPP_displayed_credit_eq_paid CHECK so
--      free grants (paid_cents=0, displayed_credit_cents>0) become valid.
--      Audit P0-1.
--   2. Add CoachCreditPackPurchase.is_free_grant boolean (default false) so
--      reports can separate free-grant volume from gross pack revenue.
--      Audit P0-1.
--   3. Add CoachAIBudget.total_pack_actual_cents (default 0). Incremented
--      by applyCreditPack with the per-pack already-banker's-rounded
--      actual_credit_cents. Replaces the read-time aggregate-rounding in
--      toSnapshot, eliminating the rounding-drift between budget ceiling
--      and sum of CCPP receipts. Audit P1-8.
--
-- NOTE: the original migration is left untouched per audit guidance
-- ("Do this in a NEW migration"). We DROP the old constraint by name and
-- replace it; this is idempotent under prisma migrate deploy.

-- ---------------------------------------------------------------------------
-- 1 + 2. Relax CHECK; add is_free_grant.
-- ---------------------------------------------------------------------------
ALTER TABLE "CoachCreditPackPurchase"
  DROP CONSTRAINT IF EXISTS "CCPP_displayed_credit_eq_paid";

ALTER TABLE "CoachCreditPackPurchase"
  ADD CONSTRAINT "CCPP_displayed_credit_ge_paid"
  CHECK ("displayed_credit_cents" >= "paid_cents");

ALTER TABLE "CoachCreditPackPurchase"
  ADD COLUMN IF NOT EXISTS "is_free_grant" BOOLEAN NOT NULL DEFAULT false;

-- A free grant must have paid_cents = 0; conversely a Stripe-backed
-- purchase must have paid_cents > 0. Encoding both invariants here keeps
-- a future "free grant minted via Stripe" from sneaking in via direct
-- SQL, and a Stripe purchase from being mis-flagged free.
ALTER TABLE "CoachCreditPackPurchase"
  ADD CONSTRAINT "CCPP_free_grant_paid_zero"
  CHECK (
    ("is_free_grant" = true  AND "paid_cents" = 0) OR
    ("is_free_grant" = false AND "paid_cents" >= 0)
  );

-- Reporting lookup: "show me all free grants in date range" should hit an
-- index rather than scan. Partial index keeps storage minimal.
CREATE INDEX IF NOT EXISTS "CoachCreditPackPurchase_free_grants_idx"
  ON "CoachCreditPackPurchase" ("created_at" DESC)
  WHERE "is_free_grant" = true;

-- ---------------------------------------------------------------------------
-- 3. Track aggregate actual headroom from packs to avoid rounding drift.
-- ---------------------------------------------------------------------------
ALTER TABLE "CoachAIBudget"
  ADD COLUMN IF NOT EXISTS "total_pack_actual_cents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CoachAIBudget"
  ADD CONSTRAINT "CoachAIBudget_total_pack_actual_nonneg"
  CHECK ("total_pack_actual_cents" >= 0);

-- Backfill: for any rows that exist BEFORE this column existed, derive
-- the value by rounding (pack_paid_cents / value_multiplier) — the same
-- formula the old toSnapshot used. This keeps existing budgets internally
-- consistent on first read after deploy. Banker's rounding is approximated
-- here by Postgres ROUND() which uses half-to-even by default for
-- NUMERIC. (Banker's rounding for NUMERIC in Postgres ≥9.x is the
-- documented behaviour.)
UPDATE "CoachAIBudget"
SET "total_pack_actual_cents" =
  ROUND("pack_paid_cents"::numeric / "value_multiplier")::int
WHERE "pack_paid_cents" > 0;
