-- Down for 20270502006000_learn_courses (LEARN-BE1). Run 20270502006100's
-- down.sql first. Restores p_lesson_select as 20270502000900 left it.
-- Irreversible for data: every course, week, enrolment and progress row is
-- deleted, and course lessons lose their week, page text and video link.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "p_lesson_select_enrolled" ON "Lesson";
ALTER POLICY "p_lesson_select" ON "Lesson"
  USING ((app.is_owner() OR (app.current_user_id() IS NOT NULL AND ("coach_id" = app.current_user_id() OR app.is_user_coached_by(app.current_user_id(), "coach_id")))));
COMMENT ON POLICY "p_lesson_select" ON "Lesson" IS '20270502000900: owner admin, the lesson''s coach, or a current client of that coach reads the lesson.';
DROP TRIGGER IF EXISTS "Lesson_media_same_coach" ON "Lesson";
DROP FUNCTION IF EXISTS app.lesson_media_same_coach();
DROP FUNCTION IF EXISTS app.course_module_open(text);
ALTER TABLE "Lesson" DROP CONSTRAINT IF EXISTS "Lesson_module_id_coach_id_fkey";
ALTER TABLE "Lesson" DROP CONSTRAINT IF EXISTS "Lesson_media_asset_id_fkey";
DROP INDEX IF EXISTS "Lesson_module_id_idx";
ALTER TABLE "Lesson" DROP COLUMN IF EXISTS "module_id",
  DROP COLUMN IF EXISTS "kind",
  DROP COLUMN IF EXISTS "body_markdown",
  DROP COLUMN IF EXISTS "media_asset_id";
DROP TABLE IF EXISTS "LessonProgress";
DROP TABLE IF EXISTS "CourseEnrolment";
DROP TABLE IF EXISTS "CourseModule";
DROP TABLE IF EXISTS "Course";
DROP TYPE IF EXISTS "LessonKind";
DROP TYPE IF EXISTS "CourseEnrolmentSource";
DROP TYPE IF EXISTS "CourseStartRule";
DROP TYPE IF EXISTS "CourseWeekRule";
DROP TYPE IF EXISTS "CourseStatus";

COMMIT;
