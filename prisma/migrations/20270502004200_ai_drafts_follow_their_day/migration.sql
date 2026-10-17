-- MOVEPROG-DRAFTS (owner 4, LS-1062 OWN-PR-B1): an AI draft that edits a
-- workout day goes with the day. The workout builder's AI edit stores its
-- changes and rationale with the day in payload.target_plan_id and no client
-- (subject_user_id NULL). ai_action_draft_participant_select and
-- ai_action_draft_tenant_decide_update (20270502000600) admit a draft naming
-- no client to all its participants, so after the client of a program copy
-- moved to another coach the former coach could still read and decide the
-- draft at the row layer, though WorkoutPlan_coach_owner already hides the
-- day from him (the copy's client has left his tenant).
--
-- One RESTRICTIVE policy ANDs with every AiActionDraft policy: a draft with a
-- target_plan_id is read, decided, written or deleted only by someone who can
-- read that day under WorkoutPlan's own row rules (the subquery runs as the
-- caller: WorkoutPlan_coach_owner = the day's coach while
-- app.workout_program_stays_in_tenant, or client_read_assigned_plans), or by
-- the owner. So the draft follows the same current-coach rule as the day, and
-- any later change to the day's rules carries over. A draft without a
-- target_plan_id is unchanged.
--
-- No data changes. service_role (the API) and the migration role bypass RLS;
-- the API applies the same rule in AiApprovalService (listPending, decide).
-- Reversible: down.sql drops the policy.
-- Live proof: test/rls/moved-client-plan-drafts.spec.ts (rls-live-tests).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "ai_action_draft_day_stays" ON "AiActionDraft";
CREATE POLICY "ai_action_draft_day_stays" ON "AiActionDraft" AS RESTRICTIVE FOR ALL TO public
  USING (
    "payload"->>'target_plan_id' IS NULL
    OR app.is_owner()
    OR EXISTS (SELECT 1 FROM "WorkoutPlan" d WHERE d."id" = "payload"->>'target_plan_id')
  );
COMMENT ON POLICY "ai_action_draft_day_stays" ON "AiActionDraft" IS
  '20270502004200: restrictive. A draft that edits a workout day (payload.target_plan_id) is reachable only by someone who can read that day under its own row rules, or the owner; a moved client''s copy takes its drafts with it.';

COMMIT;
