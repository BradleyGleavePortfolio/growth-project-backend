-- S8-D3 (1 of 4) rollback: reverse 20270125000000_scout_person_owned_schema exactly.
-- Run ONLY after the down files of 20270125000003, 20270125000002 and 20270125000001 (newest
-- first); this file drops no key that a later directory created and refuses to destroy data.
--
-- FAIL-CLOSED: refuses (atomically, nothing dropped) while ANY person-owned row exists on the five
-- parents, ANY Person is linked, ANY provenance row names a Person, or ANY link-rail row exists.
-- Person-owned history and link audit are never erased by a rollback; an operator must first move
-- or erase them under a separately authorized path. The refusal text is fixed.
--
-- POLICY RESTORE: the rewritten policies on CheckIn, ClientWorkoutAssignment, ExerciseSet,
-- HabitLog and ClientWorkoutAssignmentSnapshot are recreated with their pre-D3 text verbatim
-- (20260607000000, 20260702000000, 20260621000000, 20261213000000 x2, 20261215000000).
-- WorkoutSession, WeightLog and Habit had no in-tree policy before D3: their guarded policies are
-- dropped here. RLS stays ENABLED and FORCED on all four out-of-band tables (WorkoutSession,
-- WeightLog, Habit, CheckIn) — FAIL CLOSED: this rollback never widens direct database access.
-- After it, the three tables deny every non-bypass principal until an operator re-runs the
-- WeightLog / WorkoutSession / Habit sections of prisma/migrations/rls_fitness_backend.sql (the
-- unguarded pre-D3 posture); this file cannot know whether that file was ever applied. The
-- application path (service_role / BYPASSRLS) is unaffected either way.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Forced RLS must error rather than hide rows from the destructive safety check (precedent
-- 20270118000000 down.sql). This does not disable RLS or confer a bypass privilege.
SET LOCAL row_security = off;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."WorkoutSession" WHERE "person_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."WeightLog" WHERE "person_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."Habit" WHERE "person_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."CheckIn" WHERE "person_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" WHERE "person_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'S8-D3 refuses removal of person-owned rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public."Person" WHERE "linked_user_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public."ImportNativeProvenance" WHERE "person_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'S8-D3 refuses removal of assigned person provenance';
  END IF;
  IF EXISTS (SELECT 1 FROM public."PersonLink")
    OR EXISTS (SELECT 1 FROM public."PersonInvite")
    OR EXISTS (SELECT 1 FROM public."PersonInviteChallenge")
    OR EXISTS (SELECT 1 FROM public."PersonLinkProposal")
    OR EXISTS (SELECT 1 FROM public."PersonLinkOutbox")
  THEN
    RAISE EXCEPTION 'S8-D3 refuses removal of link audit rows';
  END IF;
END $$;

-- 1. Link-rail tables (one statement: their FKs reference each other).
DROP TABLE IF EXISTS
  public."PersonLinkOutbox",
  public."PersonLinkProposal",
  public."PersonLink",
  public."PersonInviteChallenge",
  public."PersonInvite";

-- 2. Restore the policy sets. RLS is deliberately left ENABLED + FORCED (see header).
DROP POLICY IF EXISTS "workout_session_owner_access" ON public."WorkoutSession";
DROP POLICY IF EXISTS "weight_log_owner_access" ON public."WeightLog";
DROP POLICY IF EXISTS "habit_owner_access" ON public."Habit";

DROP POLICY IF EXISTS "check_in_client_all" ON public."CheckIn";
CREATE POLICY "check_in_client_all" ON "CheckIn"
  FOR ALL TO public
  USING (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "user_id" = app.current_user_id()
    AND ("coach_id" IS NULL OR app.is_user_coached_by("user_id", "coach_id"))
  );
DROP POLICY IF EXISTS "check_in_coach_select" ON public."CheckIn";
CREATE POLICY "check_in_coach_select" ON "CheckIn"
  FOR SELECT TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());
DROP POLICY IF EXISTS "check_in_current_coach_insert" ON public."CheckIn";
CREATE POLICY "check_in_current_coach_insert" ON "CheckIn"
  FOR INSERT TO public
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("user_id")
  );
DROP POLICY IF EXISTS "check_in_current_coach_update" ON public."CheckIn";
CREATE POLICY "check_in_current_coach_update" ON "CheckIn"
  FOR UPDATE TO public
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())
  WITH CHECK (
    app.current_user_id() IS NOT NULL
    AND "coach_id" = app.current_user_id()
    AND app.is_current_coach_of("user_id")
  );

DROP POLICY IF EXISTS "assignment_coach_manage" ON public."ClientWorkoutAssignment";
CREATE POLICY "assignment_coach_manage"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR ALL
    TO PUBLIC
    USING (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
    )
    WITH CHECK (
        "assigned_by_coach_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
        AND EXISTS (
            SELECT 1
            FROM "User" u
            WHERE u."supabase_id" = auth.uid()::text
              AND u."role" IN ('coach', 'owner', 'sub_coach')
        )
        AND EXISTS (
            SELECT 1
            FROM "WorkoutPlan" wp
            WHERE wp."id" = "workout_plan_id"
              AND wp."coach_id" = (
                  SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
              )
        )
    );
DROP POLICY IF EXISTS "assignment_client_read" ON public."ClientWorkoutAssignment";
CREATE POLICY "assignment_client_read"
    ON "ClientWorkoutAssignment"
    AS PERMISSIVE
    FOR SELECT
    TO PUBLIC
    USING (
        "client_id" = (
            SELECT "id" FROM "User" WHERE "supabase_id" = auth.uid()::text
        )
    );

DROP POLICY IF EXISTS "p_exerciseset_select" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_select" ON "ExerciseSet" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_select" ON "ExerciseSet" IS 'Child-via-session read: owner, the session owner (user_id), or that user''s current coach may SELECT.';
DROP POLICY IF EXISTS "p_exerciseset_insert" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_insert" ON "ExerciseSet" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_insert" ON "ExerciseSet" IS 'Child-via-session write: owner, the session owner, or that user''s current coach may INSERT.';
DROP POLICY IF EXISTS "p_exerciseset_update" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_update" ON "ExerciseSet" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_update" ON "ExerciseSet" IS 'Child-via-session update: owner, session owner, or current coach may UPDATE; CHECK reverifies the parent session.';
DROP POLICY IF EXISTS "p_exerciseset_delete" ON public."ExerciseSet";
CREATE POLICY "p_exerciseset_delete" ON "ExerciseSet" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_delete" ON "ExerciseSet" IS 'Child-via-session delete: owner, session owner, or current coach may DELETE.';

DROP POLICY IF EXISTS "p_habitlog_select" ON public."HabitLog";
CREATE POLICY "p_habitlog_select" ON "HabitLog" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_select" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may read a habit log.';
DROP POLICY IF EXISTS "p_habitlog_insert" ON public."HabitLog";
CREATE POLICY "p_habitlog_insert" ON "HabitLog" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_insert" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may write a habit log.';
DROP POLICY IF EXISTS "p_habitlog_update" ON public."HabitLog";
CREATE POLICY "p_habitlog_update" ON "HabitLog" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_update" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may update a habit log.';
DROP POLICY IF EXISTS "p_habitlog_delete" ON public."HabitLog";
CREATE POLICY "p_habitlog_delete" ON "HabitLog" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_delete" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may delete a habit log.';

DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_select" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_select" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."client_id" = app.current_user_id() OR cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_select" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment read: owner admin, the assigned client, the assigning coach, or that client''s current coach/sub-coach may SELECT the snapshot.';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_insert" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_insert" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment write: owner admin, the assigning coach, or that client''s current coach/sub-coach may INSERT the snapshot (taken inside the assign tx).';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_update" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_update" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment update: owner admin, the assigning coach, or that client''s coach/sub-coach may UPDATE; snapshots are immutable in practice but the policy keeps the parent check symmetric.';
DROP POLICY IF EXISTS "p_clientworkoutassignmentsnapshot_delete" ON public."ClientWorkoutAssignmentSnapshot";
CREATE POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."ClientWorkoutAssignment" cwa WHERE cwa."id" = "ClientWorkoutAssignmentSnapshot"."assignment_id" AND (cwa."assigned_by_coach_id" = app.current_user_id() OR app.is_current_coach_of(cwa."client_id") OR app.is_subcoach_of(cwa."client_id"))))));
COMMENT ON POLICY "p_clientworkoutassignmentsnapshot_delete" ON "ClientWorkoutAssignmentSnapshot" IS 'Child-via-assignment delete: owner admin, the assigning coach, or that client''s coach/sub-coach may DELETE.';

-- 3. Parents: CHECKs, NOT NULL back (the guard above proved every row is user-owned), columns.
ALTER TABLE public."WorkoutSession" DROP CONSTRAINT IF EXISTS "WorkoutSession_owner_xor_check";
ALTER TABLE public."WorkoutSession" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE public."WorkoutSession" DROP COLUMN IF EXISTS "person_id";

ALTER TABLE public."WeightLog" DROP CONSTRAINT IF EXISTS "WeightLog_owner_xor_check";
ALTER TABLE public."WeightLog" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE public."WeightLog" DROP COLUMN IF EXISTS "person_id";

ALTER TABLE public."Habit" DROP CONSTRAINT IF EXISTS "Habit_owner_xor_check";
ALTER TABLE public."Habit" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE public."Habit" DROP COLUMN IF EXISTS "person_id";

ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_person_coach_check";
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_owner_xor_check";
ALTER TABLE public."CheckIn" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE public."CheckIn" DROP COLUMN IF EXISTS "person_id";

ALTER TABLE public."ClientWorkoutAssignment" DROP CONSTRAINT IF EXISTS "ClientWorkoutAssignment_owner_xor_check";
ALTER TABLE public."ClientWorkoutAssignment" ALTER COLUMN "client_id" SET NOT NULL;
ALTER TABLE public."ClientWorkoutAssignment" DROP COLUMN IF EXISTS "person_id";

-- 4. Person.linked_user_id / ImportNativeProvenance.person_id.
ALTER TABLE public."Person" DROP COLUMN IF EXISTS "linked_user_id";
ALTER TABLE public."ImportNativeProvenance" DROP COLUMN IF EXISTS "person_id";

COMMIT;
