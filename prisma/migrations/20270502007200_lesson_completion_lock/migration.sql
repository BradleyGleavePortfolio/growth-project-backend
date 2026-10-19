-- LESSON-LOCK (agent 160): nobody signed in rewrites a lesson completion.
--
-- Rule: a completion mark is the entitlement behind a kept lesson
-- (p_lesson_select_kept, 20270502006900, and LessonsService), so a mark is
-- made only where its client could open the lesson, and never changes.
--
-- GAP: p_lessoncompletion_update (20261213000000, FOR UPDATE TO public) let a
-- client update their own mark, and a current coach their client's mark, to
-- any lesson_id and user_id, and authenticated held UPDATE on the table (the
-- grant floor, 20270502001000, took writes from anon only). A client with any
-- mark could point it at a deleted coach's single lesson they never completed,
-- then read that lesson.
--
-- NOW: no UPDATE policy for the API roles and no UPDATE grant for anon or
-- authenticated. A mark is made only by INSERT on a lesson the client can read
-- (p_lessoncompletion_insert, 20270502006100) or by the server's
-- POST /lessons/:id/complete (the same check, then create), and is only ever
-- deleted after that (the client, their current coach or the lesson's coach;
-- lesson deletion and account deletion on the server); a delete only takes
-- access away. No app path updates a mark. The server's service_role policy is
-- unchanged. Metadata only: no data change.
-- Reverse: down.sql. Live proof: test/rls/learn-frozen-single-reads-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY IF EXISTS "p_lessoncompletion_update" ON "LessonCompletion";
REVOKE UPDATE ON public."LessonCompletion" FROM anon, authenticated;

-- A REVOKE by a role that did not make the grant only warns: fail closed if
-- UPDATE (table or any column) survived it.
DO $$ BEGIN
  IF has_any_column_privilege('authenticated', 'public."LessonCompletion"', 'UPDATE')
     OR has_any_column_privilege('anon', 'public."LessonCompletion"', 'UPDATE')
  THEN RAISE EXCEPTION '20270502007200: UPDATE on "LessonCompletion" survived the REVOKE'; END IF; END $$;

COMMIT;
