-- LEARN-BE1 (agent 158, Learn A PR 1): course tables in Train > Learn
-- (#LEARN-COURSE-STYLE, option weeks). Additive: four tables, four lesson
-- columns, one read helper, one guard trigger. Single lessons outside a
-- course (module_id null) keep today's rules.
--
-- Row rules (RLS enabled and forced on all four new tables; anon has no table
-- access; the server's service-role connection bypasses RLS):
--   * Course and CourseModule: the coach does everything with their own rows;
--     a client reads a course once it is published and they are enrolled, and
--     its weeks while they can read the course.
--   * CourseEnrolment: the client and the client's current coach read it. No
--     write rule: only the server enrols (a package grant or the coach).
--   * LessonProgress: the client writes their own rows, only on a lesson they
--     can open; the client's current coach reads. A former coach reads none.
--   * Lesson: a course lesson is read by its coach, and by an enrolled client
--     once its week is open (app.course_module_open). The current-client
--     branch of p_lesson_select now covers single lessons only.
--   * A lesson stays in its own coach's weeks (composite key) and plays only
--     its own coach's media (trigger), for every writer including the server.
-- Reverse: down.sql. Live proof: test/rls/learn-courses-rls.spec.ts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "CourseStatus" AS ENUM ('draft', 'published', 'archived');
CREATE TYPE "CourseWeekRule" AS ENUM ('one_at_a_time', 'all_at_once');
CREATE TYPE "CourseStartRule" AS ENUM ('on_grant', 'next_monday');
CREATE TYPE "CourseEnrolmentSource" AS ENUM ('package', 'direct');
CREATE TYPE "LessonKind" AS ENUM ('video', 'page', 'both');

CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "summary" TEXT,
    "status" "CourseStatus" NOT NULL DEFAULT 'draft',
    "week_rule" "CourseWeekRule" NOT NULL DEFAULT 'one_at_a_time',
    "start_rule" "CourseStartRule" NOT NULL DEFAULT 'on_grant',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseModule" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "note" TEXT,
    "opens_after_days" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CourseModule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CourseModule_opens_after_days_check" CHECK ("opens_after_days" >= 0)
);

CREATE TABLE "CourseEnrolment" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "source" "CourseEnrolmentSource" NOT NULL,
    "source_id" TEXT,
    "opened_all_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "CourseEnrolment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LessonProgress" (
    "user_id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "position_seconds" INTEGER NOT NULL DEFAULT 0,
    "watched_seconds" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("user_id", "lesson_id"),
    CONSTRAINT "LessonProgress_seconds_check" CHECK ("position_seconds" >= 0 AND "watched_seconds" >= 0)
);

ALTER TABLE "Lesson" ADD COLUMN "module_id" TEXT,
ADD COLUMN "kind" "LessonKind" NOT NULL DEFAULT 'page',
ADD COLUMN "body_markdown" TEXT,
ADD COLUMN "media_asset_id" TEXT;

CREATE INDEX "Course_coach_id_idx" ON "Course"("coach_id");
CREATE UNIQUE INDEX "Course_id_coach_id_key" ON "Course"("id", "coach_id");
CREATE INDEX "CourseModule_course_id_idx" ON "CourseModule"("course_id");
CREATE UNIQUE INDEX "CourseModule_id_coach_id_key" ON "CourseModule"("id", "coach_id");
CREATE INDEX "CourseEnrolment_user_id_idx" ON "CourseEnrolment"("user_id");
CREATE UNIQUE INDEX "CourseEnrolment_course_id_user_id_key" ON "CourseEnrolment"("course_id", "user_id");
CREATE INDEX "Lesson_module_id_idx" ON "Lesson"("module_id");

ALTER TABLE "Course" ADD CONSTRAINT "Course_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseModule" ADD CONSTRAINT "CourseModule_course_id_coach_id_fkey" FOREIGN KEY ("course_id", "coach_id") REFERENCES "Course"("id", "coach_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CourseEnrolment" ADD CONSTRAINT "CourseEnrolment_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseEnrolment" ADD CONSTRAINT "CourseEnrolment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LessonProgress" ADD CONSTRAINT "LessonProgress_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_module_id_coach_id_fkey" FOREIGN KEY ("module_id", "coach_id") REFERENCES "CourseModule"("id", "coach_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "CoachMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A course week is open to the signed-in client when they are enrolled in its
-- published course and the week's day has come: start day + opens_after_days
-- (0 for an all-at-once course), counted up to today or the day the
-- enrolment ended, whichever is first. A coach's open-all opens every week.
-- The server's course routes mirror this rule.
CREATE FUNCTION app.course_module_open(module_id text)
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
REVOKE ALL ON FUNCTION app.course_module_open(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.course_module_open(text) TO anon, authenticated, service_role;

-- A lesson plays only its own coach's media. Same answer for a missing asset
-- and another coach's asset.
CREATE FUNCTION app.lesson_media_same_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."CoachMediaAsset" a
    WHERE a."id" = NEW."media_asset_id" AND a."coach_id" = NEW."coach_id"
  ) THEN
    RAISE EXCEPTION 'lesson media must belong to the lesson''s coach' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.lesson_media_same_coach() FROM PUBLIC;
CREATE TRIGGER "Lesson_media_same_coach"
  BEFORE INSERT OR UPDATE OF "media_asset_id", "coach_id" ON "Lesson"
  FOR EACH ROW WHEN (NEW."media_asset_id" IS NOT NULL)
  EXECUTE FUNCTION app.lesson_media_same_coach();

ALTER TABLE "Course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Course" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CourseModule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourseModule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CourseEnrolment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourseEnrolment" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LessonProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LessonProgress" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "Course", "CourseModule", "CourseEnrolment", "LessonProgress" FROM anon;

CREATE POLICY "Course_coach_all" ON "Course" FOR ALL TO public
  USING ("coach_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id());
CREATE POLICY "Course_enrolled_select" ON "Course" FOR SELECT TO public
  USING ("status" = 'published' AND EXISTS (
    SELECT 1 FROM public."CourseEnrolment" e
    WHERE e."course_id" = "Course"."id" AND e."user_id" = app.current_user_id()));

CREATE POLICY "CourseModule_coach_all" ON "CourseModule" FOR ALL TO public
  USING ("coach_id" = app.current_user_id())
  WITH CHECK ("coach_id" = app.current_user_id());
CREATE POLICY "CourseModule_course_select" ON "CourseModule" FOR SELECT TO public
  USING (EXISTS (SELECT 1 FROM public."Course" c WHERE c."id" = "CourseModule"."course_id"));

CREATE POLICY "CourseEnrolment_select" ON "CourseEnrolment" FOR SELECT TO public
  USING ("user_id" = app.current_user_id() OR app.is_current_coach_of("user_id"));

CREATE POLICY "LessonProgress_owner_all" ON "LessonProgress" FOR ALL TO public
  USING ("user_id" = app.current_user_id())
  WITH CHECK ("user_id" = app.current_user_id() AND EXISTS (
    SELECT 1 FROM public."Lesson" l WHERE l."id" = "LessonProgress"."lesson_id"));
CREATE POLICY "LessonProgress_current_coach_select" ON "LessonProgress" FOR SELECT TO public
  USING (app.is_current_coach_of("user_id"));

ALTER POLICY "p_lesson_select" ON "Lesson"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR ("module_id" IS NULL AND app.is_user_coached_by(app.current_user_id(), "coach_id"))))));
COMMENT ON POLICY "p_lesson_select" ON "Lesson" IS '20270502006000: owner admin, the lesson''s coach, or (for a single lesson outside a course) a current client of that coach reads the lesson.';
CREATE POLICY "p_lesson_select_enrolled" ON "Lesson" FOR SELECT TO public
  USING ("module_id" IS NOT NULL AND app.course_module_open("module_id"));
COMMENT ON POLICY "p_lesson_select_enrolled" ON "Lesson" IS '20270502006000: an enrolled client reads a course lesson once its week is open.';

COMMIT;
