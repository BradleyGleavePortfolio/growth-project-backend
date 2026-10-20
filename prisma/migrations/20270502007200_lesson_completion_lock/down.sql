-- Down for 20270502007200_lesson_completion_lock (LESSON-LOCK). Only for a
-- confirmed defect: it reopens the hole (a client can again point their own
-- completion at a lesson they never completed). Restores the state before
-- exactly: p_lessoncompletion_update with its 20261213000000 text and comment,
-- and UPDATE for authenticated (anon stays without it, 20270502001000). No data
-- change.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE POLICY "p_lessoncompletion_update" ON "LessonCompletion" AS PERMISSIVE FOR UPDATE TO public USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id()))))) WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_lessoncompletion_update" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion update: owner, the completing user, that user''s current coach, or the lesson''s owning coach.';
GRANT UPDATE ON public."LessonCompletion" TO authenticated;

COMMIT;
