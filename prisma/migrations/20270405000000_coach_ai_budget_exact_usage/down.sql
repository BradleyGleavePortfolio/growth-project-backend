-- Reverse of 20270405000000_coach_ai_budget_exact_usage. Drops the exact
-- usage column. Only for a confirmed defect, and only after the code that
-- writes it is rolled back: actual_used_cents keeps the whole-cent figure,
-- so the pool keeps working, but debits round up per call again.

ALTER TABLE "CoachAIBudget" DROP COLUMN IF EXISTS "actual_used_micro_cents";
