-- Stream 1 — Coach AI Credits + Metering + Upsell
-- Operator override 2026-05-28: multiplier 3.125x, displayed allowance $125,
-- pack tiers $10 / $25 / $99 / Custom (min $10 max $500).
-- ENGINEERING_RULES §2: tables AND their RLS policies ship in the SAME
-- migration. Doing them in separate migrations leaves a window where the
-- table exists without policies and authenticated reads would bypass
-- tenant scope.

-- ---------------------------------------------------------------------------
-- CoachAIBudget — one row per head coach per period.
-- ---------------------------------------------------------------------------
CREATE TABLE "CoachAIBudget" (
  "id"                      TEXT NOT NULL,
  "coach_user_id"           TEXT NOT NULL,
  "period_start"            TIMESTAMP(3) NOT NULL,
  "period_end"              TIMESTAMP(3) NOT NULL,
  "base_actual_cents"       INTEGER NOT NULL DEFAULT 4000,
  "value_multiplier"        DECIMAL(6,3) NOT NULL DEFAULT 3.125,
  "base_displayed_cents"    INTEGER NOT NULL DEFAULT 12500,
  "pack_paid_cents"         INTEGER NOT NULL DEFAULT 0,
  "pack_displayed_cents"    INTEGER NOT NULL DEFAULT 0,
  "actual_used_cents"       INTEGER NOT NULL DEFAULT 0,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  "last_rollover_at"        TIMESTAMP(3),
  CONSTRAINT "CoachAIBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachAIBudget_coach_user_id_key" ON "CoachAIBudget"("coach_user_id");
CREATE INDEX "CoachAIBudget_period_end_idx" ON "CoachAIBudget"("period_end");

ALTER TABLE "CoachAIBudget"
  ADD CONSTRAINT "CoachAIBudget_coach_user_id_fkey"
  FOREIGN KEY ("coach_user_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Spend invariants. Negative cents are nonsensical; the WHERE-clause guard
-- in CoachAIBudgetService.recordUsage prevents overshoot but a CHECK
-- constraint backstops a service bug or a hand-rolled SQL update.
ALTER TABLE "CoachAIBudget"
  ADD CONSTRAINT "CoachAIBudget_actual_used_nonneg" CHECK ("actual_used_cents" >= 0),
  ADD CONSTRAINT "CoachAIBudget_pack_paid_nonneg"   CHECK ("pack_paid_cents" >= 0),
  ADD CONSTRAINT "CoachAIBudget_base_actual_nonneg" CHECK ("base_actual_cents" >= 0),
  ADD CONSTRAINT "CoachAIBudget_period_bounds"      CHECK ("period_end" > "period_start");

-- ---------------------------------------------------------------------------
-- CoachCreditPackPurchase — one row per Stripe checkout session.
-- ---------------------------------------------------------------------------
CREATE TABLE "CoachCreditPackPurchase" (
  "id"                          TEXT NOT NULL,
  "coach_user_id"               TEXT NOT NULL,
  "budget_id"                   TEXT NOT NULL,
  "stripe_checkout_session_id"  TEXT,
  "stripe_invoice_id"           TEXT,
  "stripe_payment_intent_id"    TEXT,
  "paid_cents"                  INTEGER NOT NULL,
  "actual_credit_cents"         INTEGER NOT NULL,
  "displayed_credit_cents"      INTEGER NOT NULL,
  "status"                      TEXT NOT NULL,
  "applied_at"                  TIMESTAMP(3),
  "refunded_at"                 TIMESTAMP(3),
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoachCreditPackPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachCreditPackPurchase_stripe_checkout_session_id_key"
  ON "CoachCreditPackPurchase"("stripe_checkout_session_id");
CREATE UNIQUE INDEX "CoachCreditPackPurchase_stripe_invoice_id_key"
  ON "CoachCreditPackPurchase"("stripe_invoice_id");
CREATE INDEX "CoachCreditPackPurchase_coach_user_id_created_at_idx"
  ON "CoachCreditPackPurchase"("coach_user_id", "created_at");
CREATE INDEX "CoachCreditPackPurchase_status_idx"
  ON "CoachCreditPackPurchase"("status");

ALTER TABLE "CoachCreditPackPurchase"
  ADD CONSTRAINT "CoachCreditPackPurchase_coach_user_id_fkey"
  FOREIGN KEY ("coach_user_id") REFERENCES "User"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "CoachCreditPackPurchase"
  ADD CONSTRAINT "CoachCreditPackPurchase_budget_id_fkey"
  FOREIGN KEY ("budget_id") REFERENCES "CoachAIBudget"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- Pack money invariants. paid_cents must equal displayed_credit_cents
-- (packs display face value, no multiplier subsidy). status is a small
-- closed set; CHECK constraint guards against typos in a future migration.
ALTER TABLE "CoachCreditPackPurchase"
  ADD CONSTRAINT "CCPP_paid_nonneg"         CHECK ("paid_cents" >= 0),
  ADD CONSTRAINT "CCPP_actual_credit_nonneg" CHECK ("actual_credit_cents" >= 0),
  ADD CONSTRAINT "CCPP_displayed_credit_eq_paid" CHECK ("displayed_credit_cents" = "paid_cents"),
  ADD CONSTRAINT "CCPP_status_valid" CHECK ("status" IN ('pending','paid','refunded','failed'));

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- RLS helpers (app.current_user_id, app.is_owner, app.current_user_role)
-- are defined in prior migrations (see rls_fitness_backend.sql and
-- 20260520000001_add_gcal_channel_tracking_to_calendar_connection). We
-- reference them here.

-- CoachAIBudget --------------------------------------------------------------
ALTER TABLE "CoachAIBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachAIBudget" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CoachAIBudget_owner_all" ON "CoachAIBudget";
CREATE POLICY "CoachAIBudget_owner_all" ON "CoachAIBudget"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- Coach can SELECT their own row (the budget is theirs).
DROP POLICY IF EXISTS "CoachAIBudget_self_select" ON "CoachAIBudget";
CREATE POLICY "CoachAIBudget_self_select" ON "CoachAIBudget"
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_user_id" = app.current_user_id()
  );

-- Writes (INSERT/UPDATE/DELETE) are owner-only. The application path that
-- needs to mutate (CoachAIBudgetService.recordUsage / applyCreditPack /
-- rollover cron) runs under the service-role connection that bypasses
-- RLS entirely (Supabase service-role JWT). This keeps coaches strictly
-- read-only at the database surface — no end-user code path can ever
-- INSERT or UPDATE a CoachAIBudget row, satisfying ENGINEERING_RULES §2
-- "financial table write-scope".

-- CoachCreditPackPurchase ---------------------------------------------------
ALTER TABLE "CoachCreditPackPurchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachCreditPackPurchase" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CCPP_owner_all" ON "CoachCreditPackPurchase";
CREATE POLICY "CCPP_owner_all" ON "CoachCreditPackPurchase"
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (app.is_owner())
  WITH CHECK (app.is_owner());

-- Coach can SELECT their own pack purchases (powers the receipts view).
DROP POLICY IF EXISTS "CCPP_self_select" ON "CoachCreditPackPurchase";
CREATE POLICY "CCPP_self_select" ON "CoachCreditPackPurchase"
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_user_id" = app.current_user_id()
  );

-- No coach-scoped INSERT/UPDATE policy: pack rows are written exclusively
-- by the webhook path (service-role) and admin tooling (also service-role
-- via the admin guard). A coach attempting a direct INSERT/UPDATE under
-- their authenticated JWT will fail the FORCE RLS check.

-- ---------------------------------------------------------------------------
-- CoachBrief.read_at — dormancy guard input.
-- ---------------------------------------------------------------------------
-- The AI cost-protection cron uses the last 3 briefs' read_at to decide
-- whether to auto-generate. NULL = unread. Index by (coach_id, brief_date)
-- already exists; the new column is folded into the existing index plan
-- via a partial unread-only index that keeps the dormancy check cheap.
ALTER TABLE "CoachBrief" ADD COLUMN IF NOT EXISTS "read_at" TIMESTAMP(3);

-- Partial index for the dormancy lookup: only rows where read_at IS NULL
-- (the "unread" tail). Postgres only stores the matching rows, so the
-- index stays small even at long brief histories.
CREATE INDEX IF NOT EXISTS "CoachBrief_coach_unread_idx"
  ON "CoachBrief" ("coach_id", "brief_date" DESC)
  WHERE "read_at" IS NULL;
