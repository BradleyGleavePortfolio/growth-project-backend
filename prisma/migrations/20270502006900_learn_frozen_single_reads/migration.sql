-- LEARN-FROZEN-SINGLE-READS (agent 160): a client keeps reading the single
-- lessons they kept when their coach deleted their account.
--
-- Rule (#1096): clients keep assigned content when their coach deletes. The
-- deletion keeps a single lesson (module_id null) that a client completed
-- (ERASURE_MANIFEST, Lesson entries), but p_lesson_select lets a client read
-- a single lesson only while its coach is their current coach, and the
-- deletion detaches every client. So the kept row stayed in the database and
-- no client could read it.
--
-- Fix: one more permissive SELECT policy on "Lesson". A single lesson is read
-- by a signed-in user who completed it, once the lesson's coach account is
-- deleted (User.deleted_at set by the finalizer). Nobody else gains a row:
--   * a client who did not complete it, another coach's client, another coach
--     and anon read nothing;
--   * a past coach who still has an account stays closed (moving coach does
--     not carry the old coach's lessons, LEARN-B);
--   * course lessons are unchanged (p_lesson_select_enrolled already lets an
--     enrolled client read them with no coach link).
-- p_lesson_select is not changed: a current coach's and current client's
-- reads stay as they are.
--
-- The helper is SECURITY DEFINER because a detached client cannot read the
-- deleted coach's User row; it answers one yes/no and returns no row data.
-- Fixed search_path; parameter names differ from every column it reads.
-- The coach id is passed in so the helper never reads "Lesson" (no policy
-- recursion). The server applies the same rule in LessonsService.
-- Reverse: down.sql. Live proof: test/rls/learn-frozen-single-reads-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.lesson_kept_by_current_user(kept_lesson_id text, lesson_coach_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."LessonCompletion" c
    JOIN public."User" coach ON coach."id" = lesson_coach_id AND coach."deleted_at" IS NOT NULL
    WHERE c."lesson_id" = kept_lesson_id
      AND c."user_id" = app.current_user_id()
  )
$$;
COMMENT ON FUNCTION app.lesson_kept_by_current_user(text, text) IS
  'LEARN-FROZEN-SINGLE-READS (20270502006900): true when the signed-in user completed this lesson and its coach account is deleted. False for no user. Called by p_lesson_select_kept.';
REVOKE ALL ON FUNCTION app.lesson_kept_by_current_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lesson_kept_by_current_user(text, text) TO anon, authenticated, service_role;

CREATE POLICY "p_lesson_select_kept" ON "Lesson" FOR SELECT TO public
  USING ("module_id" IS NULL AND app.lesson_kept_by_current_user("id", "coach_id"));
COMMENT ON POLICY "p_lesson_select_kept" ON "Lesson" IS '20270502006900: a client reads a single lesson they completed once its coach account is deleted (they kept it).';

COMMIT;
