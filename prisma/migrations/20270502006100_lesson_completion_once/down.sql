-- Down for 20270502006100_lesson_completion_once (LEARN-BE1). Restores the
-- 20261213000000 read and insert rules and drops the unique index. The
-- repeats the up step removed are not restored.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS "LessonCompletion_lesson_id_user_id_key";
ALTER POLICY "p_lessoncompletion_select" ON "LessonCompletion"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_lessoncompletion_select" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion read: owner, the completing user (user_id), that user''s current coach, or the lesson''s owning coach.';
ALTER POLICY "p_lessoncompletion_insert" ON "LessonCompletion"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id") OR EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id" AND l."coach_id" = app.current_user_id())))));
COMMENT ON POLICY "p_lessoncompletion_insert" ON "LessonCompletion" IS 'PR-RLS-06 lesson-completion insert: owner, the completing user, that user''s current coach, or the lesson''s owning coach.';

COMMIT;
