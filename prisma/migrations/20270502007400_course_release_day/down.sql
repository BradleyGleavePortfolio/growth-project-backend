-- Reverse of 20270502007400_course_release_day: course weeks open on the
-- database's CURRENT_DATE again (the 20270502006000 text) and
-- app.client_today goes. Row security on the course tables is untouched.
-- Deploy the server without the LEARN-BE2 release-day change first: it calls
-- app.client_today.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.course_module_open(module_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."CourseModule" m
    JOIN public."Course" c ON c."id" = m."course_id" AND c."status" = 'published'
    JOIN public."CourseEnrolment" e ON e."course_id" = c."id" AND e."user_id" = app.current_user_id()
    WHERE m."id" = module_id
      AND (
        e."opened_all_at" IS NOT NULL
        OR e."starts_on" + CASE WHEN c."week_rule" = 'all_at_once' THEN 0 ELSE m."opens_after_days" END
           <= LEAST(CURRENT_DATE, e."ended_at"::date)
      )
  )
$$;
COMMENT ON FUNCTION app.course_module_open(text) IS
  'LEARN-BE1 (20270502006000): true when the signed-in client is enrolled in this week''s published course and the week is open. False for a missing week or no user. Called by p_lesson_select_enrolled.';

DROP FUNCTION IF EXISTS app.client_today(text, timestamptz);

COMMIT;
