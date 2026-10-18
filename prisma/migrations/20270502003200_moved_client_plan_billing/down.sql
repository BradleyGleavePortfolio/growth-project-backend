-- Reverse of 20270424000000_moved_client_plan_billing. Drops only what
-- migration.sql adds. The move dates are lost: renewal already turned off in
-- Stripe stays off, and ltv-metrics counts those plans by status again.
SET lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_delegation_end_marks_plans ON "SubCoachAssignment";
DROP FUNCTION IF EXISTS public.delegation_end_marks_plans();
DROP TRIGGER IF EXISTS trg_user_coach_move_marks_plans ON "User";
DROP FUNCTION IF EXISTS public.user_coach_move_marks_plans();
DROP FUNCTION IF EXISTS app.client_coach_chain(text, text);
DROP INDEX IF EXISTS "ClientPurchase_moved_away_at_idx";
ALTER TABLE "ClientPurchase" DROP COLUMN IF EXISTS "moved_away_at";
RESET lock_timeout;
