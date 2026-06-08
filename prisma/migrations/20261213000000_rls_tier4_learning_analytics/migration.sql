-- PR-RLS-06 — Tier 4 learning, analytics, signals row-level security.
--
-- Enables (and FORCEs) RLS on eight previously-unprotected Tier 4 tables and
-- installs the canonical policy set for each. Every table gets:
--   * a service_role bypass policy (Primitive A) for server-side jobs/migrations,
--   * per-command (SELECT/INSERT/UPDATE/DELETE) policies for the `public` role
--     built from the canonical primitives in section 3 of RLS_REMEDIATION_PLAN.md,
--     with the table-specific owner columns substituted exactly.
--
-- Ownership model per table (see plan section 5.06):
--   Lesson                — coach-self: coach_id = current user (Primitive C),
--                           plus owner override. Catalog rows are coach-scoped,
--                           not globally public, so SELECT is gated on coach_id.
--   LessonCompletion      — lesson-completion: the completing user, that user's
--                           current coach, or the lesson's coach (Primitive C/D/E).
--   HolisticInsightCache  — user-self-current-coach-read: user_id self or current
--                           coach of user_id (Primitive C + is_current_coach_of).
--   ActivityEvent         — participant-event: actor_id / coach_id / client_id
--                           self, or current coach of client_id (Primitive C/D).
--   ClientSignal          — user-self-current-coach-read (as HolisticInsightCache).
--   ClientOutcome         — user-self-current-coach-read (as HolisticInsightCache).
--   PtmPrediction         — user-self-current-coach-read (as HolisticInsightCache).
--   AiRoadmap             — child-via-diagnostic-submission: access flows through
--                           DiagnosticSubmission.user_id via submission_id
--                           (Primitive E); AiRoadmap has no direct owner column.
--
-- Helpers (app.is_owner(), app.current_user_id(), app.is_current_coach_of(text))
-- are provided by prior migrations (20260531000000 / 20260607000000) and hardened
-- by 20261212000000_rls_helper_search_path. App schema USAGE + function EXECUTE
-- grants to service_role/anon/authenticated already exist (rls_fitness_backend.sql);
-- this migration only adds table policies.
--
-- Rollback: DROP the policies created here. Only run
--   ALTER TABLE <table> DISABLE ROW LEVEL SECURITY
-- if a P0 production outage is confirmed; otherwise fix forward with a policy
-- patch. Do NOT roll back the helper functions.
--
-- SAFE TO RE-RUN: every CREATE POLICY is preceded by DROP POLICY IF EXISTS, and
-- ENABLE/FORCE ROW LEVEL SECURITY are idempotent.

BEGIN;

-- =====================================================================
-- Lesson — coach-self (owner override). Primitive C on coach_id.
-- =====================================================================
ALTER TABLE "Lesson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lesson" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_lesson_service_role_all" ON "Lesson";
CREATE POLICY "p_lesson_service_role_all" ON "Lesson" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_lesson_select" ON "Lesson";
CREATE POLICY "p_lesson_select" ON "Lesson" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
DROP POLICY IF EXISTS "p_lesson_insert" ON "Lesson";
CREATE POLICY "p_lesson_insert" ON "Lesson" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
DROP POLICY IF EXISTS "p_lesson_update" ON "Lesson";
CREATE POLICY "p_lesson_update" ON "Lesson" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id()))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
DROP POLICY IF EXISTS "p_lesson_delete" ON "Lesson";
CREATE POLICY "p_lesson_delete" ON "Lesson" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())));
COMMENT ON POLICY "p_lesson_service_role_all" ON "Lesson" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_lesson_select" ON "Lesson" IS 'PR-RLS-06 coach-self read: owner, or the lesson owning coach (coach_id = current user).';
COMMENT ON POLICY "p_lesson_insert" ON "Lesson" IS 'PR-RLS-06 coach-self insert: owner, or coach inserting their own lesson (coach_id = current user).';
COMMENT ON POLICY "p_lesson_update" ON "Lesson" IS 'PR-RLS-06 coach-self update: owner, or coach editing their own lesson; WITH CHECK blocks reassigning coach_id away from self.';
COMMENT ON POLICY "p_lesson_delete" ON "Lesson" IS 'PR-RLS-06 coach-self delete: owner, or coach deleting their own lesson.';

-- =====================================================================
-- LessonCompletion — completing user, that user's coach, or lesson coach.
-- Primitive C (user_id) + is_current_coach_of(user_id) + Primitive E (Lesson).
-- =====================================================================
ALTER TABLE "LessonCompletion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LessonCompletion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_lessoncompletion_service_role_all" ON "LessonCompletion";
CREATE POLICY "p_lessoncompletion_service_role_all" ON "LessonCompletion" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_lessoncompletion_select" ON "LessonCompletion";
CREATE POLICY "p_lessoncompletion_select" ON "LessonCompletion" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
DROP POLICY IF EXISTS "p_lessoncompletion_insert" ON "LessonCompletion";
CREATE POLICY "p_lessoncompletion_insert" ON "LessonCompletion" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
DROP POLICY IF EXISTS "p_lessoncompletion_update" ON "LessonCompletion";
CREATE POLICY "p_lessoncompletion_update" ON "LessonCompletion" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id()))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
DROP POLICY IF EXISTS "p_lessoncompletion_delete" ON "LessonCompletion";
CREATE POLICY "p_lessoncompletion_delete" ON "LessonCompletion" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_lessoncompletion_service_role_all" ON "LessonCompletion" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_lessoncompletion_select" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion read: owner, the completing user (user_id), that user''s current coach, or the lesson''s owning coach.';
COMMENT ON POLICY "p_lessoncompletion_insert" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion insert: owner, the completing user, that user''s current coach, or the lesson''s owning coach.';
COMMENT ON POLICY "p_lessoncompletion_update" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion update: owner, the completing user, that user''s current coach, or the lesson''s owning coach.';
COMMENT ON POLICY "p_lessoncompletion_delete" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion delete: owner, the completing user, that user''s current coach, or the lesson''s owning coach.';

-- =====================================================================
-- HolisticInsightCache — user-self-current-coach-read. Primitive C + coach.
-- =====================================================================
ALTER TABLE "HolisticInsightCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HolisticInsightCache" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_holisticinsightcache_service_role_all" ON "HolisticInsightCache";
CREATE POLICY "p_holisticinsightcache_service_role_all" ON "HolisticInsightCache" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_holisticinsightcache_select" ON "HolisticInsightCache";
CREATE POLICY "p_holisticinsightcache_select" ON "HolisticInsightCache" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_holisticinsightcache_insert" ON "HolisticInsightCache";
CREATE POLICY "p_holisticinsightcache_insert" ON "HolisticInsightCache" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_holisticinsightcache_update" ON "HolisticInsightCache";
CREATE POLICY "p_holisticinsightcache_update" ON "HolisticInsightCache" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_holisticinsightcache_delete" ON "HolisticInsightCache";
CREATE POLICY "p_holisticinsightcache_delete" ON "HolisticInsightCache" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_holisticinsightcache_service_role_all" ON "HolisticInsightCache" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_holisticinsightcache_select" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach read: owner, the user (user_id), or the user''s current coach.';
COMMENT ON POLICY "p_holisticinsightcache_insert" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_holisticinsightcache_update" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_holisticinsightcache_delete" ON "HolisticInsightCache" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

-- =====================================================================
-- ActivityEvent — participant-event. actor_id/coach_id/client_id self, or
-- current coach of client_id. Primitive C (three columns) + D (coach-of-client).
-- =====================================================================
ALTER TABLE "ActivityEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActivityEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_activityevent_service_role_all" ON "ActivityEvent";
CREATE POLICY "p_activityevent_service_role_all" ON "ActivityEvent" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_activityevent_select" ON "ActivityEvent";
CREATE POLICY "p_activityevent_select" ON "ActivityEvent" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
DROP POLICY IF EXISTS "p_activityevent_insert" ON "ActivityEvent";
CREATE POLICY "p_activityevent_insert" ON "ActivityEvent" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
DROP POLICY IF EXISTS "p_activityevent_update" ON "ActivityEvent";
CREATE POLICY "p_activityevent_update" ON "ActivityEvent" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
DROP POLICY IF EXISTS "p_activityevent_delete" ON "ActivityEvent";
CREATE POLICY "p_activityevent_delete" ON "ActivityEvent" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("actor_id" = app.current_user_id() OR "coach_id" = app.current_user_id() OR "client_id" = app.current_user_id() OR app.is_current_coach_of("client_id")))));
COMMENT ON POLICY "p_activityevent_service_role_all" ON "ActivityEvent" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_activityevent_select" ON "ActivityEvent" IS 'PR-RLS-06 participant-event read: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
COMMENT ON POLICY "p_activityevent_insert" ON "ActivityEvent" IS 'PR-RLS-06 participant-event insert: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
COMMENT ON POLICY "p_activityevent_update" ON "ActivityEvent" IS 'PR-RLS-06 participant-event update: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';
COMMENT ON POLICY "p_activityevent_delete" ON "ActivityEvent" IS 'PR-RLS-06 participant-event delete: owner, or a participant (actor_id/coach_id/client_id) or the current coach of client_id.';

-- =====================================================================
-- ClientSignal — user-self-current-coach-read. Primitive C + coach.
-- =====================================================================
ALTER TABLE "ClientSignal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientSignal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_clientsignal_service_role_all" ON "ClientSignal";
CREATE POLICY "p_clientsignal_service_role_all" ON "ClientSignal" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_clientsignal_select" ON "ClientSignal";
CREATE POLICY "p_clientsignal_select" ON "ClientSignal" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientsignal_insert" ON "ClientSignal";
CREATE POLICY "p_clientsignal_insert" ON "ClientSignal" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientsignal_update" ON "ClientSignal";
CREATE POLICY "p_clientsignal_update" ON "ClientSignal" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientsignal_delete" ON "ClientSignal";
CREATE POLICY "p_clientsignal_delete" ON "ClientSignal" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientsignal_service_role_all" ON "ClientSignal" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_clientsignal_select" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach read: owner, the user (user_id), or the user''s current coach.';
COMMENT ON POLICY "p_clientsignal_insert" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientsignal_update" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientsignal_delete" ON "ClientSignal" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

-- =====================================================================
-- ClientOutcome — user-self-current-coach-read. Primitive C + coach.
-- =====================================================================
ALTER TABLE "ClientOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientOutcome" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_clientoutcome_service_role_all" ON "ClientOutcome";
CREATE POLICY "p_clientoutcome_service_role_all" ON "ClientOutcome" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_clientoutcome_select" ON "ClientOutcome";
CREATE POLICY "p_clientoutcome_select" ON "ClientOutcome" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientoutcome_insert" ON "ClientOutcome";
CREATE POLICY "p_clientoutcome_insert" ON "ClientOutcome" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientoutcome_update" ON "ClientOutcome";
CREATE POLICY "p_clientoutcome_update" ON "ClientOutcome" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_clientoutcome_delete" ON "ClientOutcome";
CREATE POLICY "p_clientoutcome_delete" ON "ClientOutcome" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_clientoutcome_service_role_all" ON "ClientOutcome" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_clientoutcome_select" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach read: owner, the user (user_id), or the user''s current coach.';
COMMENT ON POLICY "p_clientoutcome_insert" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientoutcome_update" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_clientoutcome_delete" ON "ClientOutcome" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

-- =====================================================================
-- PtmPrediction — user-self-current-coach-read. Primitive C + coach.
-- =====================================================================
ALTER TABLE "PtmPrediction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PtmPrediction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_ptmprediction_service_role_all" ON "PtmPrediction";
CREATE POLICY "p_ptmprediction_service_role_all" ON "PtmPrediction" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_ptmprediction_select" ON "PtmPrediction";
CREATE POLICY "p_ptmprediction_select" ON "PtmPrediction" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_ptmprediction_insert" ON "PtmPrediction";
CREATE POLICY "p_ptmprediction_insert" ON "PtmPrediction" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_ptmprediction_update" ON "PtmPrediction";
CREATE POLICY "p_ptmprediction_update" ON "PtmPrediction" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
DROP POLICY IF EXISTS "p_ptmprediction_delete" ON "PtmPrediction";
CREATE POLICY "p_ptmprediction_delete" ON "PtmPrediction" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_ptmprediction_service_role_all" ON "PtmPrediction" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_ptmprediction_select" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach read: owner, the user (user_id), or the user''s current coach.';
COMMENT ON POLICY "p_ptmprediction_insert" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach insert: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_ptmprediction_update" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach update: owner, the user, or the user''s current coach.';
COMMENT ON POLICY "p_ptmprediction_delete" ON "PtmPrediction" IS 'PR-RLS-06 user-self-current-coach delete: owner, the user, or the user''s current coach.';

-- =====================================================================
-- AiRoadmap — child-via-diagnostic-submission. No direct owner column; access
-- flows through DiagnosticSubmission.user_id via submission_id. Primitive E.
-- =====================================================================
ALTER TABLE "AiRoadmap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiRoadmap" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "p_airoadmap_service_role_all" ON "AiRoadmap";
CREATE POLICY "p_airoadmap_service_role_all" ON "AiRoadmap" AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "p_airoadmap_select" ON "AiRoadmap";
CREATE POLICY "p_airoadmap_select" ON "AiRoadmap" AS PERMISSIVE FOR SELECT TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DiagnosticSubmission" ds WHERE ds."id" = "AiRoadmap"."submission_id" AND ds."user_id" = app.current_user_id()))));
DROP POLICY IF EXISTS "p_airoadmap_insert" ON "AiRoadmap";
CREATE POLICY "p_airoadmap_insert" ON "AiRoadmap" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DiagnosticSubmission" ds WHERE ds."id" = "AiRoadmap"."submission_id" AND ds."user_id" = app.current_user_id()))));
DROP POLICY IF EXISTS "p_airoadmap_update" ON "AiRoadmap";
CREATE POLICY "p_airoadmap_update" ON "AiRoadmap" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DiagnosticSubmission" ds WHERE ds."id" = "AiRoadmap"."submission_id" AND ds."user_id" = app.current_user_id())))) WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DiagnosticSubmission" ds WHERE ds."id" = "AiRoadmap"."submission_id" AND ds."user_id" = app.current_user_id()))));
DROP POLICY IF EXISTS "p_airoadmap_delete" ON "AiRoadmap";
CREATE POLICY "p_airoadmap_delete" ON "AiRoadmap" AS PERMISSIVE FOR DELETE TO public USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."DiagnosticSubmission" ds WHERE ds."id" = "AiRoadmap"."submission_id" AND ds."user_id" = app.current_user_id()))));
COMMENT ON POLICY "p_airoadmap_service_role_all" ON "AiRoadmap" IS 'PR-RLS-06 Primitive A: service_role bypass for server-side jobs and migrations.';
COMMENT ON POLICY "p_airoadmap_select" ON "AiRoadmap" IS 'PR-RLS-06 child-via-diagnostic-submission read: owner, or the user who owns the parent DiagnosticSubmission (submission_id -> user_id).';
COMMENT ON POLICY "p_airoadmap_insert" ON "AiRoadmap" IS 'PR-RLS-06 child-via-diagnostic-submission insert: owner, or the user who owns the parent DiagnosticSubmission.';
COMMENT ON POLICY "p_airoadmap_update" ON "AiRoadmap" IS 'PR-RLS-06 child-via-diagnostic-submission update: owner, or the user who owns the parent DiagnosticSubmission.';
COMMENT ON POLICY "p_airoadmap_delete" ON "AiRoadmap" IS 'PR-RLS-06 child-via-diagnostic-submission delete: owner, or the user who owns the parent DiagnosticSubmission.';

COMMIT;
