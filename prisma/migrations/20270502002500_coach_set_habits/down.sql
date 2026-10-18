-- Reverse of 20270502002500_coach_set_habits, for a confirmed defect only.
-- The HabitLog rules go back to their 20261213000000 text and comments, the
-- coach policies on Habit and the sharing helper go, then the new columns,
-- the index and the type. The ownership guard goes first. Lost: who set each
-- habit, coach notes, schedules, reminders, the client's order (the sort_order
-- backfill goes with its column; the old GET /habits reads no order column),
-- archive dates (archived habits list again) and offline tick ids.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER "habitlog_ownership_guard" ON "HabitLog";
DROP TRIGGER "habit_ownership_guard" ON "Habit";
DROP FUNCTION app.habit_ownership_guard();

ALTER POLICY "p_habitlog_select" ON "HabitLog"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_select" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may read a habit log.';
ALTER POLICY "p_habitlog_insert" ON "HabitLog"
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_insert" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may write a habit log.';
ALTER POLICY "p_habitlog_update" ON "HabitLog"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))))
  WITH CHECK ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_update" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may update a habit log.';
ALTER POLICY "p_habitlog_delete" ON "HabitLog"
  USING ((app.is_owner() OR (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND (h."user_id" = app.current_user_id() OR app.is_current_coach_of(h."user_id"))))));
COMMENT ON POLICY "p_habitlog_delete" ON "HabitLog" IS
  'PR-RLS-07: habit owner or that owner''s current coach (or backend owner) may delete a habit log.';

DROP POLICY "habit_current_coach_select" ON "Habit";
DROP POLICY "habit_current_coach_insert" ON "Habit";
DROP POLICY "habit_current_coach_update" ON "Habit";
DROP FUNCTION app.current_coach_has_scope(text, text);

DROP INDEX "HabitLog_habit_id_client_log_id_key";
ALTER TABLE "HabitLog" DROP COLUMN "client_log_id";
ALTER TABLE "Habit"
  DROP CONSTRAINT "Habit_plan_values_check",
  DROP CONSTRAINT "Habit_assigned_by_coach_id_fkey",
  DROP COLUMN "assigned_by_coach_id",
  DROP COLUMN "coach_note",
  DROP COLUMN "schedule_kind",
  DROP COLUMN "schedule_days",
  DROP COLUMN "times_per_week",
  DROP COLUMN "reminder_enabled",
  DROP COLUMN "reminder_time",
  DROP COLUMN "starts_on",
  DROP COLUMN "sort_order",
  DROP COLUMN "archived_at";
DROP TYPE "HabitScheduleKind";

COMMIT;
