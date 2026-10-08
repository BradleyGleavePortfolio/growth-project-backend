-- CREDIT-METER-130: the coach AI pool keeps the exact provider cost.
--
-- Additive only. Reverse: down.sql. No backfill: every existing row gets 0,
-- and the service reads a row whose exact total is below its whole-cent
-- figure as (actual_used_cents - 1) cents plus one millionth, so no coach
-- ever sees less used than before; at most under one cent is not counted,
-- once per existing row, until the next monthly rollover resets both columns.
-- (Production read-only count on 2026-10-07 19:37 PDT: 1 CoachAIBudget row, 0 with usage.)
--
-- "CoachAIBudget"."actual_used_micro_cents": the period's actual provider
-- spend in millionths of a cent. Each debit adds its exact cost here and sets
-- actual_used_cents to the ceiling of this total, so a period rounds up once
-- instead of on every call. Written only by CoachAIBudgetService.recordUsage
-- and reset to 0 by the monthly rollover.
--
-- Constant default, so on Postgres 11+ ADD COLUMN is a catalog-only change
-- (no table rewrite). RLS on "CoachAIBudget" is unchanged.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "CoachAIBudget" ADD COLUMN "actual_used_micro_cents" BIGINT NOT NULL DEFAULT 0;

RESET lock_timeout;
