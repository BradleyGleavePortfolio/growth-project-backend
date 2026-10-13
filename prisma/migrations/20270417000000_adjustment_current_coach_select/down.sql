-- Reverse of 20270417000000_adjustment_current_coach_select. Only for a
-- confirmed defect: it lets a former coach read a moved client's workout
-- adjustment proposals and their events again through direct table access.

SET lock_timeout = '5s';

ALTER POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

RESET lock_timeout;
