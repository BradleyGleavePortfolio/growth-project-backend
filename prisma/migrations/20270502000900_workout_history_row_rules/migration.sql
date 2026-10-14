-- RLSLIVE1c (RLS-ALL slice 11; RLSINV H09, H10, H11): workout history rows
-- follow the client in the row policies too. Second lock only (RLS-MODE
-- Option 1): the backend reads and writes through Prisma's service-role
-- connection, which bypasses RLS, and a Data API caller has no
-- app.current_user_id, so no app path changes. No data change; nothing is
-- deleted. Reverse: down.sql.
--
-- GAP:
--   * H09. WorkoutSession had only its owner policy (20270410000000), so the
--     client's current coach read none of the client's sessions, and the
--     coach branch of p_exerciseset_select read WorkoutSession under the
--     coach's own policies, so it never passed.
--   * H10. ClientWorkoutAssignment admitted a coach only for rows they
--     assigned (assignment_coach_manage), so after a move the new coach read
--     none of the assignments from the former coach's time, nor their
--     snapshots (p_clientworkoutassignmentsnapshot_select reads the
--     assignment under the caller's policies).
--   * H11. p_workoutprogram_select (20270414000000) had no branch for the
--     client of a program copy, and p_lesson_select (20261213000000) none for
--     the clients of the lesson's coach.
--
-- NOW:
--   * The client's current coach reads (SELECT only) the client's sessions,
--     their sets (through the SECURITY DEFINER helper
--     app.caller_coaches_session_owner, which reads no policy) and every
--     assignment of the client, from any coach's time. The snapshot SELECT
--     policy is unchanged: its current-coach branch now passes, because the
--     assignment it reads is visible to that coach. A former coach reads none
--     of it once the client has moved; another coach never did.
--   * Writes stay where they were. The coach branch of the ExerciseSet
--     write policies, and the bare assigning-coach branch of the snapshot
--     write policies, could only pass through a parent row the coach could
--     see. The new reads would make them pass for the current coach (sets)
--     and for the former coach's snapshots, so they now name the rule they
--     enforced in practice: the session owner writes their sets; the
--     assigning coach writes a snapshot while the client is still theirs.
--   * A client reads their own program copy (client_id) and the lessons of
--     their current coach. Every other WorkoutProgram and Lesson branch is
--     unchanged.
-- Unchanged: workout_session_owner_access, assignment_client_read,
-- assignment_coach_manage, app.caller_coaches_client and every
-- *_service_role_all policy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.caller_coaches_session_owner(target_workout_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public."WorkoutSession" ws
    WHERE ws."id" = target_workout_id
      AND app.is_current_coach_of(ws."user_id")
  )
$$;
COMMENT ON FUNCTION app.caller_coaches_session_owner(text) IS
  '20270502000900: true when the caller is the current coach of the user who logged the workout session. Reads no WorkoutSession policy.';
REVOKE ALL ON FUNCTION app.caller_coaches_session_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.caller_coaches_session_owner(text) TO authenticated, service_role;

-- H09: the current coach reads the client's sessions and sets.
DROP POLICY IF EXISTS "workout_session_current_coach_select" ON "WorkoutSession";
CREATE POLICY "workout_session_current_coach_select" ON "WorkoutSession"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("user_id"));
COMMENT ON POLICY "workout_session_current_coach_select" ON "WorkoutSession" IS '20270502000900: the client''s current coach reads the session.';

ALTER POLICY "p_exerciseset_select" ON "ExerciseSet"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."user_id" = app.current_user_id()) OR app.caller_coaches_session_owner("workout_id")))));
ALTER POLICY "p_exerciseset_insert" ON "ExerciseSet"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."user_id" = app.current_user_id()))));
ALTER POLICY "p_exerciseset_update" ON "ExerciseSet"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."user_id" = app.current_user_id()))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."user_id" = app.current_user_id()))));
ALTER POLICY "p_exerciseset_delete" ON "ExerciseSet"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND ws."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_exerciseset_select" ON "ExerciseSet" IS '20270502000900: owner admin, the user who logged the session, or that user''s current coach (app.caller_coaches_session_owner) reads the set.';
COMMENT ON POLICY "p_exerciseset_insert" ON "ExerciseSet" IS '20270502000900: owner admin, or the user who logged the session, adds a set.';
COMMENT ON POLICY "p_exerciseset_update" ON "ExerciseSet" IS '20270502000900: owner admin, or the user who logged the session, changes a set; CHECK re-verifies the session.';
COMMENT ON POLICY "p_exerciseset_delete" ON "ExerciseSet" IS '20270502000900: owner admin, or the user who logged the session, deletes a set.';

-- H10: the current coach reads every assignment of the client (history
-- follows the client); snapshot writes stay with the assigning coach while
-- the client is still theirs.
DROP POLICY IF EXISTS "assignment_current_coach_select" ON "ClientWorkoutAssignment";
CREATE POLICY "assignment_current_coach_select" ON "ClientWorkoutAssignment"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND app.is_current_coach_of("client_id"));
COMMENT ON POLICY "assignment_current_coach_select" ON "ClientWorkoutAssignment" IS '20270502000900: the client''s current coach reads the assignment, whoever assigned it. Read only.';

ALTER POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."assigned_by_coach_id" = app.current_user_id() AND (app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
ALTER POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."assigned_by_coach_id" = app.current_user_id() AND (app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))))
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."assigned_by_coach_id" = app.current_user_id() AND (app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
ALTER POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND cwa."assigned_by_coach_id" = app.current_user_id() AND (app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" IS '20270502000900: owner admin, or the assigning coach while the client is still theirs (current coach or sub-coach), inserts the snapshot.';
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" IS '20270502000900: owner admin, or the assigning coach while the client is still theirs (current coach or sub-coach), updates the snapshot, before and after the change.';
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" IS '20270502000900: owner admin, or the assigning coach while the client is still theirs (current coach or sub-coach), deletes the snapshot.';

-- H11: a client reads their own program copy and their coach's lessons.
ALTER POLICY "p_workoutprogram_select" ON "WorkoutProgram"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "client_id" = app.current_user_id()) OR (app.workout_program_stays_in_tenant("id") AND ((app.current_user_id() IS NOT NULL AND "owner_user_id" = app.current_user_id()) OR (app.current_user_id() IS NOT NULL AND "visibility" = 'tenant_shared' AND (app.is_current_coach_of("coach_id") OR app.is_subcoach_of("coach_id") OR EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = app.current_user_id() AND (u."id" = "WorkoutProgram"."coach_id" OR u."coach_id" = "WorkoutProgram"."coach_id"))))))));
COMMENT ON POLICY "p_workoutprogram_select" ON "WorkoutProgram" IS '20270502000900: owner admin; the client of a program copy (client_id), from any coach''s time; or, while the program stays in its tenant (a master, or a copy whose clients have not left), the row owner or, for tenant_shared rows, a head coach / sub-coach in the same coach_id tenant.';

ALTER POLICY "p_lesson_select" ON "Lesson"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR app.is_user_coached_by(app.current_user_id(), "coach_id")))));
COMMENT ON POLICY "p_lesson_select" ON "Lesson" IS '20270502000900: owner admin, the lesson''s coach, or a current client of that coach reads the lesson.';

COMMIT;
