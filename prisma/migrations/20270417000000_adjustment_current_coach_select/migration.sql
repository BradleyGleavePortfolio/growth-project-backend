-- HIST3 (owner 4b, 139-13): a coach reads a client's workout adjustment
-- proposals, and through them their audit events, only while that client is
-- still theirs. p_workoutadjustmentproposal_select_coach (20270227000000)
-- checked only the author column, so after a move the former coach still read
-- the client's signals, before_exercises and applied_change.
--
-- Same rule and helper as GAPS1 (20270412000000) and READTESTS
-- (20270416000000): app.is_user_coached_by(client, coach), the existing
-- SECURITY DEFINER function (20260607000000). p_workoutadjustmentevent_select_coach
-- reads the proposal through an EXISTS subquery that is itself under this
-- policy, so the events follow without a change. No branch is added for the
-- new coach or the client (the proposal holds coach-private Roman text). The
-- server reads through Prisma's service-role connection, which bypasses RLS,
-- and its routes already scope proposals to the client's current coach, so no
-- app path changes. RLS stays enabled and forced. Reverse: down.sql.

SET lock_timeout = '5s';

ALTER POLICY "p_workoutadjustmentproposal_select_coach" ON "WorkoutAdjustmentProposal"
  USING (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_user_coached_by("client_id", "coach_id")
  );

RESET lock_timeout;
