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
-- formula the old toSnapshot used in
-- src/ai-credits/coach-ai-budget.service.ts (now replaced by direct
-- column reads, but still the formula we backfill from at migration
-- deploy).
--
-- R2 NEW-P3-1 fix: MUST use HALF-TO-EVEN (banker's) rounding to match
-- the runtime in src/ai-credits/bankers-round.util.ts. Postgres's
-- `round(numeric)` is HALF-AWAY-FROM-ZERO, not half-to-even — see
-- https://www.postgresql.org/docs/current/functions-math.html
-- ("round(numeric) ... rounds halfway cases away from zero"). Only
-- `round(double precision)` uses banker's rounding ("round to
-- nearest, ties to even"). The earlier comment claiming
-- ROUND-on-NUMERIC is half-to-even was factually wrong.
--
-- Two correct implementations exist:
--   (a) cast to double precision and let Postgres do banker's:
--       round((pack_paid_cents::numeric / value_multiplier)::double precision)::int
--       — concise but introduces IEEE-754 conversion error on the
--       float path, which matters for the rare tie input.
--   (b) explicit NUMERIC half-to-even via CASE on the fractional
--       part. Exact, no float conversion, no IEEE-754 drift.
-- We pick (b) for the same reason bankers-round.util.ts handles ties
-- explicitly: financial rounding must be deterministic across
-- runtime environments (JS Number vs Postgres NUMERIC vs Postgres
-- double), not "mostly the same most of the time".
--
-- Algorithm:
--   q     = pack_paid_cents::numeric / value_multiplier   (exact NUMERIC)
--   floor = floor(q)                                       (NUMERIC)
--   diff  = q - floor                                      (NUMERIC in [0, 1))
--   if diff > 0.5: floor + 1
--   if diff < 0.5: floor
--   if diff = 0.5: floor when floor is even, else floor + 1  (half-to-even)
--
-- All quantities are non-negative here (pack_paid_cents > 0 by the
-- WHERE clause + value_multiplier > 0 by the CHECK constraint added
-- in the round-0 migration), so we do not need the negative-sign
-- branch the JS util carries.
--
-- Real-world impact: at first deploy, no rows have pack_paid_cents > 0
-- (this migration ships together with the round-0 tables), so this
-- UPDATE is a no-op. For any future replay against populated data
-- the result now matches bankers-round.util.ts byte-for-byte on every
-- input — including the tie cases the old SQL would have diverged on.
UPDATE "CoachAIBudget" AS b
SET "total_pack_actual_cents" = sub.banker_rounded
FROM (
  SELECT
    "id",
    (
      CASE
        WHEN diff > 0.5 THEN floor_q + 1
        WHEN diff < 0.5 THEN floor_q
        -- Tie: half-to-even. floor_q::bigint % 2 = 0 means floor is even.
        WHEN (floor_q::bigint % 2) = 0 THEN floor_q
        ELSE floor_q + 1
      END
    )::int AS banker_rounded
  FROM (
    SELECT
      "id",
      floor("pack_paid_cents"::numeric / "value_multiplier")::numeric AS floor_q,
      (
        ("pack_paid_cents"::numeric / "value_multiplier")
          - floor("pack_paid_cents"::numeric / "value_multiplier")
      )::numeric AS diff
    FROM "CoachAIBudget"
    WHERE "pack_paid_cents" > 0
  ) parts
) AS sub
WHERE b."id" = sub."id";
