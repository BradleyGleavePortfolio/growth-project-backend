-- PR-RLS-04 — Tier 3 workout & build-week RLS enablement.
--
-- Enables + FORCEs Row Level Security on the 7 Tier-3 workout/build-week tables
-- and installs policies traceable to the canonical primitives in
-- RLS_REMEDIATION_PLAN.md §3. All ownership paths were verified against
-- prisma/schema.prisma (no column divergence):
--
--   WorkoutRoutine          -> creator-self           (creator_id)
--   RoutineExercise         -> child-via-routine      (routine_id -> WorkoutRoutine.creator_id)
--   ExerciseSet             -> child-via-session       (workout_id -> WorkoutSession.user_id, + coach)
--   ExerciseCatalogItem     -> public-catalog/owner-write (no owner col)
--   BuildWeekDay            -> public-catalog/owner-write (no owner col)
--   BuildWeekDayCompletion  -> child-via-enrollment    (enrollment_id -> BuildWeekEnrollment.user_id)
--   BuildWeekEnrollment     -> user-self               (user_id)
--
-- Helper convention (PR-RLS-FN): app.is_owner(), app.current_user_id(),
-- app.is_current_coach_of(text). service_role bypass is Primitive A.
--
-- Rollback: DROP the policies created here and, only on a confirmed P0 outage,
-- ALTER TABLE <t> DISABLE ROW LEVEL SECURITY. Otherwise fix forward.

BEGIN;

-- =====================================================================
-- 1) WorkoutRoutine — Tier 3; primitive: creator-self (creator_id).
-- =====================================================================
ALTER TABLE "WorkoutRoutine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutRoutine" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_workoutroutine_service_role_all" ON "WorkoutRoutine";
CREATE POLICY "p_workoutroutine_service_role_all" ON "WorkoutRoutine" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_workoutroutine_service_role_all" ON "WorkoutRoutine" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_workoutroutine_select" ON "WorkoutRoutine";
CREATE POLICY "p_workoutroutine_select" ON "WorkoutRoutine" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "creator_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutroutine_select" ON "WorkoutRoutine" IS 'Creator-self read: owner admin or the routine creator (creator_id) may SELECT.';

DROP POLICY IF EXISTS "p_workoutroutine_insert" ON "WorkoutRoutine";
CREATE POLICY "p_workoutroutine_insert" ON "WorkoutRoutine" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "creator_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutroutine_insert" ON "WorkoutRoutine" IS 'Creator-self write: only owner or the row''s own creator_id may INSERT.';

DROP POLICY IF EXISTS "p_workoutroutine_update" ON "WorkoutRoutine";
CREATE POLICY "p_workoutroutine_update" ON "WorkoutRoutine" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "creator_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "creator_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutroutine_update" ON "WorkoutRoutine" IS 'Creator-self update: owner or creator may UPDATE; CHECK prevents re-owning to another creator_id.';

DROP POLICY IF EXISTS "p_workoutroutine_delete" ON "WorkoutRoutine";
CREATE POLICY "p_workoutroutine_delete" ON "WorkoutRoutine" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "creator_id" = app.current_user_id())));
COMMENT ON POLICY "p_workoutroutine_delete" ON "WorkoutRoutine" IS 'Creator-self delete: owner or creator may DELETE.';

-- =====================================================================
-- 2) RoutineExercise — Tier 3; primitive: child-via-routine
--    (routine_id -> WorkoutRoutine.creator_id).
-- =====================================================================
ALTER TABLE "RoutineExercise" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoutineExercise" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_routineexercise_service_role_all" ON "RoutineExercise";
CREATE POLICY "p_routineexercise_service_role_all" ON "RoutineExercise" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_routineexercise_service_role_all" ON "RoutineExercise" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_routineexercise_select" ON "RoutineExercise";
CREATE POLICY "p_routineexercise_select" ON "RoutineExercise" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutRoutine" wr WHERE wr."id" = "RoutineExercise"."routine_id" AND wr."creator_id" = app.current_user_id()))));
COMMENT ON POLICY "p_routineexercise_select" ON "RoutineExercise" IS 'Child-via-routine read: owner or the parent WorkoutRoutine creator may SELECT.';

DROP POLICY IF EXISTS "p_routineexercise_insert" ON "RoutineExercise";
CREATE POLICY "p_routineexercise_insert" ON "RoutineExercise" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutRoutine" wr WHERE wr."id" = "RoutineExercise"."routine_id" AND wr."creator_id" = app.current_user_id()))));
COMMENT ON POLICY "p_routineexercise_insert" ON "RoutineExercise" IS 'Child-via-routine write: owner or parent routine creator may INSERT.';

DROP POLICY IF EXISTS "p_routineexercise_update" ON "RoutineExercise";
CREATE POLICY "p_routineexercise_update" ON "RoutineExercise" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutRoutine" wr WHERE wr."id" = "RoutineExercise"."routine_id" AND wr."creator_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutRoutine" wr WHERE wr."id" = "RoutineExercise"."routine_id" AND wr."creator_id" = app.current_user_id()))));
COMMENT ON POLICY "p_routineexercise_update" ON "RoutineExercise" IS 'Child-via-routine update: owner or parent routine creator may UPDATE; CHECK reverifies the parent after change.';

DROP POLICY IF EXISTS "p_routineexercise_delete" ON "RoutineExercise";
CREATE POLICY "p_routineexercise_delete" ON "RoutineExercise" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutRoutine" wr WHERE wr."id" = "RoutineExercise"."routine_id" AND wr."creator_id" = app.current_user_id()))));
COMMENT ON POLICY "p_routineexercise_delete" ON "RoutineExercise" IS 'Child-via-routine delete: owner or parent routine creator may DELETE.';

-- =====================================================================
-- 3) ExerciseSet — Tier 3; primitive: child-via-workout-session
--    (workout_id -> WorkoutSession.user_id; assigned coach may also access).
-- =====================================================================
ALTER TABLE "ExerciseSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseSet" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_exerciseset_service_role_all" ON "ExerciseSet";
CREATE POLICY "p_exerciseset_service_role_all" ON "ExerciseSet" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_exerciseset_service_role_all" ON "ExerciseSet" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_exerciseset_select" ON "ExerciseSet";
CREATE POLICY "p_exerciseset_select" ON "ExerciseSet" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_select" ON "ExerciseSet" IS 'Child-via-session read: owner, the session owner (user_id), or that user''s current coach may SELECT.';

DROP POLICY IF EXISTS "p_exerciseset_insert" ON "ExerciseSet";
CREATE POLICY "p_exerciseset_insert" ON "ExerciseSet" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_insert" ON "ExerciseSet" IS 'Child-via-session write: owner, the session owner, or that user''s current coach may INSERT.';

DROP POLICY IF EXISTS "p_exerciseset_update" ON "ExerciseSet";
CREATE POLICY "p_exerciseset_update" ON "ExerciseSet" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id")))))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_update" ON "ExerciseSet" IS 'Child-via-session update: owner, session owner, or current coach may UPDATE; CHECK reverifies the parent session.';

DROP POLICY IF EXISTS "p_exerciseset_delete" ON "ExerciseSet";
CREATE POLICY "p_exerciseset_delete" ON "ExerciseSet" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."WorkoutSession" ws WHERE ws."id" = "ExerciseSet"."workout_id" AND (ws."user_id" = app.current_user_id() OR app.is_current_coach_of(ws."user_id"))))));
COMMENT ON POLICY "p_exerciseset_delete" ON "ExerciseSet" IS 'Child-via-session delete: owner, session owner, or current coach may DELETE.';

-- =====================================================================
-- 4) ExerciseCatalogItem — Tier 3; primitive: public-catalog-read/owner-write.
-- =====================================================================
ALTER TABLE "ExerciseCatalogItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExerciseCatalogItem" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_exercisecatalogitem_service_role_all" ON "ExerciseCatalogItem";
CREATE POLICY "p_exercisecatalogitem_service_role_all" ON "ExerciseCatalogItem" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_exercisecatalogitem_service_role_all" ON "ExerciseCatalogItem" IS 'Primitive A: service_role bypass for server-side jobs/migrations (catalog seeding/enrichment).';

DROP POLICY IF EXISTS "p_exercisecatalogitem_select" ON "ExerciseCatalogItem";
CREATE POLICY "p_exercisecatalogitem_select" ON "ExerciseCatalogItem" AS PERMISSIVE FOR SELECT TO public USING (true);
COMMENT ON POLICY "p_exercisecatalogitem_select" ON "ExerciseCatalogItem" IS 'Public-catalog read: the exercise picker is a public reference catalog; anyone (incl. anon) may SELECT.';

DROP POLICY IF EXISTS "p_exercisecatalogitem_insert" ON "ExerciseCatalogItem";
CREATE POLICY "p_exercisecatalogitem_insert" ON "ExerciseCatalogItem" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_exercisecatalogitem_insert" ON "ExerciseCatalogItem" IS 'Owner-write: only owner (or service_role) may INSERT catalog rows.';

DROP POLICY IF EXISTS "p_exercisecatalogitem_update" ON "ExerciseCatalogItem";
CREATE POLICY "p_exercisecatalogitem_update" ON "ExerciseCatalogItem" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_exercisecatalogitem_update" ON "ExerciseCatalogItem" IS 'Owner-write: only owner (or service_role) may UPDATE catalog rows.';

DROP POLICY IF EXISTS "p_exercisecatalogitem_delete" ON "ExerciseCatalogItem";
CREATE POLICY "p_exercisecatalogitem_delete" ON "ExerciseCatalogItem" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_exercisecatalogitem_delete" ON "ExerciseCatalogItem" IS 'Owner-write: only owner (or service_role) may DELETE catalog rows.';

-- =====================================================================
-- 5) BuildWeekDay — Tier 3; primitive: public-catalog-read/owner-write.
-- =====================================================================
ALTER TABLE "BuildWeekDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BuildWeekDay" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_buildweekday_service_role_all" ON "BuildWeekDay";
CREATE POLICY "p_buildweekday_service_role_all" ON "BuildWeekDay" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_buildweekday_service_role_all" ON "BuildWeekDay" IS 'Primitive A: service_role bypass for server-side jobs/migrations (curriculum seeding).';

DROP POLICY IF EXISTS "p_buildweekday_select" ON "BuildWeekDay";
CREATE POLICY "p_buildweekday_select" ON "BuildWeekDay" AS PERMISSIVE FOR SELECT TO public USING (true);
COMMENT ON POLICY "p_buildweekday_select" ON "BuildWeekDay" IS 'Public-catalog read: build-week curriculum is shared reference content; anyone (incl. anon) may SELECT.';

DROP POLICY IF EXISTS "p_buildweekday_insert" ON "BuildWeekDay";
CREATE POLICY "p_buildweekday_insert" ON "BuildWeekDay" AS PERMISSIVE FOR INSERT TO public WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_buildweekday_insert" ON "BuildWeekDay" IS 'Owner-write: only owner (or service_role) may INSERT curriculum days.';

DROP POLICY IF EXISTS "p_buildweekday_update" ON "BuildWeekDay";
CREATE POLICY "p_buildweekday_update" ON "BuildWeekDay" AS PERMISSIVE FOR UPDATE TO public USING (app.is_owner()) WITH CHECK (app.is_owner());
COMMENT ON POLICY "p_buildweekday_update" ON "BuildWeekDay" IS 'Owner-write: only owner (or service_role) may UPDATE curriculum days.';

DROP POLICY IF EXISTS "p_buildweekday_delete" ON "BuildWeekDay";
CREATE POLICY "p_buildweekday_delete" ON "BuildWeekDay" AS PERMISSIVE FOR DELETE TO public USING (app.is_owner());
COMMENT ON POLICY "p_buildweekday_delete" ON "BuildWeekDay" IS 'Owner-write: only owner (or service_role) may DELETE curriculum days.';

-- =====================================================================
-- 6) BuildWeekDayCompletion — Tier 3; primitive: child-via-buildweek-enrollment
--    (enrollment_id -> BuildWeekEnrollment.user_id).
-- =====================================================================
ALTER TABLE "BuildWeekDayCompletion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BuildWeekDayCompletion" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_buildweekdaycompletion_service_role_all" ON "BuildWeekDayCompletion";
CREATE POLICY "p_buildweekdaycompletion_service_role_all" ON "BuildWeekDayCompletion" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_buildweekdaycompletion_service_role_all" ON "BuildWeekDayCompletion" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_buildweekdaycompletion_select" ON "BuildWeekDayCompletion";
CREATE POLICY "p_buildweekdaycompletion_select" ON "BuildWeekDayCompletion" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BuildWeekEnrollment" bwe WHERE bwe."id" = "BuildWeekDayCompletion"."enrollment_id" AND bwe."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_buildweekdaycompletion_select" ON "BuildWeekDayCompletion" IS 'Child-via-enrollment read: owner or the enrollment''s user (user_id) may SELECT their completion rows.';

DROP POLICY IF EXISTS "p_buildweekdaycompletion_insert" ON "BuildWeekDayCompletion";
CREATE POLICY "p_buildweekdaycompletion_insert" ON "BuildWeekDayCompletion" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BuildWeekEnrollment" bwe WHERE bwe."id" = "BuildWeekDayCompletion"."enrollment_id" AND bwe."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_buildweekdaycompletion_insert" ON "BuildWeekDayCompletion" IS 'Child-via-enrollment write: owner or the enrollment''s user may INSERT completion rows.';

DROP POLICY IF EXISTS "p_buildweekdaycompletion_update" ON "BuildWeekDayCompletion";
CREATE POLICY "p_buildweekdaycompletion_update" ON "BuildWeekDayCompletion" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BuildWeekEnrollment" bwe WHERE bwe."id" = "BuildWeekDayCompletion"."enrollment_id" AND bwe."user_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BuildWeekEnrollment" bwe WHERE bwe."id" = "BuildWeekDayCompletion"."enrollment_id" AND bwe."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_buildweekdaycompletion_update" ON "BuildWeekDayCompletion" IS 'Child-via-enrollment update: owner or the enrollment''s user may UPDATE; CHECK reverifies the parent enrollment.';

DROP POLICY IF EXISTS "p_buildweekdaycompletion_delete" ON "BuildWeekDayCompletion";
CREATE POLICY "p_buildweekdaycompletion_delete" ON "BuildWeekDayCompletion" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."BuildWeekEnrollment" bwe WHERE bwe."id" = "BuildWeekDayCompletion"."enrollment_id" AND bwe."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_buildweekdaycompletion_delete" ON "BuildWeekDayCompletion" IS 'Child-via-enrollment delete: owner or the enrollment''s user may DELETE their completion rows.';

-- =====================================================================
-- 7) BuildWeekEnrollment — Tier 3; primitive: user-self (user_id).
-- =====================================================================
ALTER TABLE "BuildWeekEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BuildWeekEnrollment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "p_buildweekenrollment_service_role_all" ON "BuildWeekEnrollment";
CREATE POLICY "p_buildweekenrollment_service_role_all" ON "BuildWeekEnrollment" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON POLICY "p_buildweekenrollment_service_role_all" ON "BuildWeekEnrollment" IS 'Primitive A: service_role bypass for server-side jobs/migrations.';

DROP POLICY IF EXISTS "p_buildweekenrollment_select" ON "BuildWeekEnrollment";
CREATE POLICY "p_buildweekenrollment_select" ON "BuildWeekEnrollment" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_buildweekenrollment_select" ON "BuildWeekEnrollment" IS 'User-self read: owner or the enrolling user (user_id) may SELECT their enrollment.';

DROP POLICY IF EXISTS "p_buildweekenrollment_insert" ON "BuildWeekEnrollment";
CREATE POLICY "p_buildweekenrollment_insert" ON "BuildWeekEnrollment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_buildweekenrollment_insert" ON "BuildWeekEnrollment" IS 'User-self write: only owner or the enrolling user may INSERT (own row).';

DROP POLICY IF EXISTS "p_buildweekenrollment_update" ON "BuildWeekEnrollment";
CREATE POLICY "p_buildweekenrollment_update" ON "BuildWeekEnrollment" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_buildweekenrollment_update" ON "BuildWeekEnrollment" IS 'User-self update: owner or the enrolling user may UPDATE; CHECK prevents re-owning to another user_id.';

DROP POLICY IF EXISTS "p_buildweekenrollment_delete" ON "BuildWeekEnrollment";
CREATE POLICY "p_buildweekenrollment_delete" ON "BuildWeekEnrollment" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id())));
COMMENT ON POLICY "p_buildweekenrollment_delete" ON "BuildWeekEnrollment" IS 'User-self delete: owner or the enrolling user may DELETE their enrollment.';

COMMIT;
