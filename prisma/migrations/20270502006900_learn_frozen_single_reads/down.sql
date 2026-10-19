-- Down for 20270502006900_learn_frozen_single_reads (LEARN-FROZEN-SINGLE-READS).
-- Drops the kept-lesson read rule and its helper. No data changes: kept
-- lessons stay in the table, unreadable by their clients again.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "p_lesson_select_kept" ON "Lesson";
DROP FUNCTION IF EXISTS app.lesson_kept_by_current_user(text, text);

COMMIT;
