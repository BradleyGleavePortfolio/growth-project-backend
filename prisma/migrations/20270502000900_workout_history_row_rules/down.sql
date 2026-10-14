-- Reverse of 20270502000900_workout_history_row_rules. Only for a confirmed
-- defect: the current coach again reads none of a client's sessions, sets or
-- other coaches' assignments and snapshots, and a client again reads neither
-- their program copy nor their coach's lessons. Drops the two new policies,
-- restores the 20261213000000, 20261215000000 and 20270414000000 text
-- verbatim (policies and comments), then drops the helper.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "workout_session_current_coach_select" ON "WorkoutSession";
DROP POLICY IF EXISTS "assignment_current_coach_select" ON "ClientWorkoutAssignment";

ALTER POLICY "p_exerciseset_select" ON "ExerciseSet"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
ALTER POLICY "p_exerciseset_insert" ON "ExerciseSet"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
ALTER POLICY "p_exerciseset_update" ON "ExerciseSet"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))))
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
ALTER POLICY "p_exerciseset_delete" ON "ExerciseSet"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_select" ON "ExerciseSet" IS 'Child-via-session read: owner, the session owner (user_id), or that user''s current coach may SELECT.';
COMMENT ON POLICY "p_exerciseset_insert" ON "ExerciseSet" IS 'Child-via-session write: owner, the session owner, or that user''s current coach may INSERT.';
COMMENT ON POLICY "p_exerciseset_update" ON "ExerciseSet" IS 'Child-via-session update: owner, session owner, or current coach may UPDATE; CHECK reverifies the parent session.';
COMMENT ON POLICY "p_exerciseset_delete" ON "ExerciseSet" IS 'Child-via-session delete: owner, session owner, or current coach may DELETE.';

ALTER POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
ALTER POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))))
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
ALTER POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment write: owner admin, the assigning coach, or that client''s current coach/sub-coach may INSERT the snapshot (taken inside the assign tx).';
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment update: owner admin, the assigning coach, or that client''s coach/sub-coach may UPDATE; snapshots are immutable in practice but the policy keeps the parent check symmetric.';
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment delete: owner admin, the assigning coach, or that client''s coach/sub-coach may DELETE.';

ALTER POLICY "p_workoutprogram_select" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.workout_program_stays_in_tenant("id") AND ((app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()) OR (app.current_user_id() IS NOT NULL AND "visibility" = 'tenant_shared' AND (app.is_current_coach_of("coach_id") OR app.is_subcoach_of("coach_id") OR EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = app.current_user_id() AND (u."id" = "WorkoutProgram"."coach_id" OR u."coach_id" = "WorkoutProgram"."coach_id"))))))));
COMMENT ON POLICY "p_workoutprogram_select" ON "WorkoutProgram" IS '20270414000000: owner admin; or, while the program stays in its tenant (a master, or a copy whose clients have not left), the row owner or, for tenant_shared rows, a head coach / sub-coach in the same coach_id tenant.';

ALTER POLICY "p_lesson_select" ON "Lesson"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_lesson_select" ON "Lesson" IS 'PR-RLS-06 coach-self read: owner, or the lesson owning coach (coach_id = current user).';

DROP FUNCTION IF EXISTS app.caller_coaches_session_owner(text);

COMMIT;
