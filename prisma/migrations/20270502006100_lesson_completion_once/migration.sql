-- LEARN-BE1 (agent 158, Learn A PR 1): one completion per client per lesson,
-- and completions follow the client.
--   * Keeps each client's first completion of a lesson and removes later
--     repeats (a double tap could write two), then makes (lesson_id, user_id)
--     unique. IRREVERSIBLE: the removed repeats are not restored; they carried
--     nothing but a later completed_at.
--   * Read: the client and the client's current coach. The lesson's-coach
--     branch is gone, so a former coach reads none of a moved client's
--     completions, including on their own course lessons.
--   * Insert: only the client, only on a lesson they can open (the Lesson
--     policies decide). Update and delete are unchanged; they reach only rows
--     the caller can read.
-- The server's service-role connection bypasses RLS. Reverse: down.sql.
-- Live proof: test/rls/learn-courses-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DELETE FROM "LessonCompletion" c
USING "LessonCompletion" k
WHERE k."lesson_id" = c."lesson_id" AND k."user_id" = c."user_id"
  AND (k."completed_at", k."id") < (c."completed_at", c."id");

CREATE UNIQUE INDEX "LessonCompletion_lesson_id_user_id_key" ON "LessonCompletion"("lesson_id", "user_id");

ALTER POLICY "p_lessoncompletion_select" ON "LessonCompletion"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id")))));
COMMENT ON POLICY "p_lessoncompletion_select" ON "LessonCompletion" IS '20270502006100: owner admin, the completing client, or that client''s current coach reads the completion.';
ALTER POLICY "p_lessoncompletion_insert" ON "LessonCompletion"
  WITH CHECK ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND "user_id" = app.current_user_id() AND EXISTS (SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonCompletion"."lesson_id"))));
COMMENT ON POLICY "p_lessoncompletion_insert" ON "LessonCompletion" IS '20270502006100: owner admin, or the client on a lesson they can read.';

COMMIT;
