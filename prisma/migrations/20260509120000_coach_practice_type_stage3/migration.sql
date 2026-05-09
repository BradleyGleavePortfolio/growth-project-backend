-- Stage 3 — Cross-pillar federation gate.
--
-- Adds a single nullable `coach_practice_type` enum column to the User
-- table. Existing rows are left as NULL, which the coach-facing
-- cross-pillar federation surface treats as "not yet selected" and
-- returns 403 PRACTICE_NOT_SELECTED for. The mobile app routes those
-- coaches through the Stage-3 practice-selection flow on next open.
--
-- Additive change only — no backfill, no data risk. Single-pillar
-- coaches never need this column populated; only coaches who pick
-- "Both" trigger the cross-pillar UI.

CREATE TYPE "CoachPracticeType" AS ENUM ('fitness_only', 'finance_only', 'both');

ALTER TABLE "User"
  ADD COLUMN "coach_practice_type" "CoachPracticeType";
