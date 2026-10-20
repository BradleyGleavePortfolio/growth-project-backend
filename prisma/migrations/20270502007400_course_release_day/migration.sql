-- LEARN-BE2 fix round 2 (b#1114, Sol B1): one release day for course weeks.
--
-- GAP: app.course_module_open (20270502006000) counted a week open against
-- the database's CURRENT_DATE (UTC), while the server's course routes count it
-- against the client's own calendar day. A client in Tokyo got a new week's
-- page from the server hours before the row rule let them read it, and a
-- client in Los Angeles the other way round after UTC midnight.
--
-- NOW: app.client_today(user) is the one "today" for a client, chosen the way
-- src/notifications/recipient-timezone.ts chooses a zone: the zone the client
-- supplied (NotificationPreferences.timezone, only when timezone_updated_at is
-- set), else their own CoachProfile zone, else their current coach's
-- CoachProfile zone; UTC aliases and names Postgres does not know are skipped;
-- UTC when nothing is usable. app.course_module_open uses it, and the server
-- asks the database for the same function's answer (ClientCoursesService), so
-- the routes and the row rule always agree. Only the open day changes: the
-- enrolment, published and open-all rules are as before. Row security on the
-- course tables stays enabled and forced; no policy text changes.
-- Reverse: down.sql. Live proof: test/rls/course-release-day-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.client_today(p_user text, p_at timestamptz DEFAULT now())
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  zone text;
BEGIN
  FOR zone IN
    SELECT btrim(c.z) FROM (
      SELECT 1 AS n, p."timezone" AS z FROM public."NotificationPreferences" p
        WHERE p."user_id" = p_user AND p."timezone_updated_at" IS NOT NULL
      UNION ALL
      SELECT 2, cp."timezone" FROM public."CoachProfile" cp WHERE cp."user_id" = p_user
      UNION ALL
      SELECT 3, cp."timezone" FROM public."User" u
        JOIN public."CoachProfile" cp ON cp."user_id" = u."coach_id"
        WHERE u."id" = p_user AND u."coach_id" <> p_user
    ) c
    WHERE length(btrim(c.z)) BETWEEN 1 AND 64
      AND upper(btrim(c.z)) NOT IN ('UTC', 'UCT', 'ZULU', 'UNIVERSAL', 'GMT', 'GMT0', 'GMT+0', 'GMT-0',
        'GREENWICH', 'ETC/UTC', 'ETC/UCT', 'ETC/ZULU', 'ETC/UNIVERSAL', 'ETC/GMT', 'ETC/GMT0',
        'ETC/GMT+0', 'ETC/GMT-0', 'ETC/GREENWICH')
    ORDER BY c.n
  LOOP
    BEGIN
      RETURN (p_at AT TIME ZONE zone)::date;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL; -- not a zone Postgres knows: try the next one
    END;
  END LOOP;
  RETURN (p_at AT TIME ZONE 'UTC')::date;
END
$$;
COMMENT ON FUNCTION app.client_today(text, timestamptz) IS
  'LEARN-BE2 (20270502007400): the client''s own calendar day (their zone, else their own or their coach''s CoachProfile zone, else UTC), the one day course weeks open on. Used by app.course_module_open and the server''s course routes.';
REVOKE ALL ON FUNCTION app.client_today(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.client_today(text, timestamptz) TO service_role;

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
           <= LEAST(app.client_today(e."user_id"), e."ended_at"::date)
      )
  )
$$;
COMMENT ON FUNCTION app.course_module_open(text) IS
  'LEARN-BE1 (20270502006000), day from LEARN-BE2 (20270502007400): true when the signed-in client is enrolled in this week''s published course and the week is open on the client''s own day (app.client_today). False for a missing week or no user. Called by p_lesson_select_enrolled.';

COMMIT;
