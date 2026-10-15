-- HB1 (agent 147): coach-set habits, safe edits, archive keeps history.
-- Second lock (RLS-MODE Option 1): the server reads and writes through
-- Prisma's service-role connection, which bypasses row security, and scopes
-- every habit query to the signed-in client itself. Additive; no row changes.
-- Reverse: down.sql.
--
-- Columns. Every existing habit reads as the client's own daily habit with no
-- reminder:
--   Habit: assigned_by_coach_id (the coach who set it; null for the client's
--   own), coach_note (up to 500), schedule_kind (daily, days, times_per_week),
--   schedule_days (0 = Sunday ... 6), times_per_week, reminder_enabled (off),
--   reminder_time (local "HH:mm"), starts_on, sort_order, archived_at.
--   HabitLog: client_log_id, unique per habit (the app's id for an offline tick).
--
-- One row rule for habits:
--   * The client keeps every right on all their habits, whoever set them
--     (habit_owner_access, 20270410000000, unchanged).
--   * The client's current coach reads them while the client shares
--     fitness.habits_progress with that coach: app.current_coach_has_scope,
--     the ConsentService.rowIsGranted test on the same consent row. A coach the
--     client moved away from, another coach and a sub-coach read none, at once;
--     the rows stay with the client.
--   * Under the same rule that coach sets habits (INSERT) and edits (UPDATE)
--     only rows naming themself as assigned_by_coach_id. No coach deletes.
--   * HabitLog follows its habit (found-not-fixed 6). Its SELECT rule reads
--     "Habit" under the caller's own row rules, so a log is readable exactly
--     when its habit is: no second guard. Before, the current coach read every
--     log (with no sharing check) and no habit name. Only the habit's client
--     writes logs. The owner-admin branch goes with the old rule.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "HabitScheduleKind" AS ENUM ('daily', 'days', 'times_per_week');

ALTER TABLE "Habit"
  ADD COLUMN "assigned_by_coach_id" TEXT,
  ADD COLUMN "coach_note" VARCHAR(500),
  ADD COLUMN "schedule_kind" "HabitScheduleKind" NOT NULL DEFAULT 'daily',
  ADD COLUMN "schedule_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "times_per_week" INTEGER,
  ADD COLUMN "reminder_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminder_time" TEXT,
  ADD COLUMN "starts_on" DATE,
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD CONSTRAINT "Habit_assigned_by_coach_id_fkey" FOREIGN KEY ("assigned_by_coach_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- Values every writer must keep, the API and the row layer alike.
  ADD CONSTRAINT "Habit_plan_values_check" CHECK (
    "schedule_days" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
    AND ("times_per_week" IS NULL OR "times_per_week" BETWEEN 1 AND 7)
    AND ("reminder_time" IS NULL OR "reminder_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  );

ALTER TABLE "HabitLog" ADD COLUMN "client_log_id" UUID;
CREATE UNIQUE INDEX "HabitLog_habit_id_client_log_id_key" ON "HabitLog"("habit_id", "client_log_id");

CREATE FUNCTION app.current_coach_has_scope(client_user_id text, consent_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.is_current_coach_of(client_user_id) AND EXISTS (
    SELECT 1
    FROM public."ClientCoachConsent" c
    WHERE c."client_id" = client_user_id
      AND c."coach_id" = app.current_user_id()
      AND c."scope" = consent_scope
      AND c."granted_at" IS NOT NULL
      AND (c."revoked_at" IS NULL OR c."revoked_at" < c."granted_at")
  )
$$;
COMMENT ON FUNCTION app.current_coach_has_scope(text, text) IS
  '20270502002500: true when the caller is the client''s current coach and the client shares the scope with them (granted, not revoked since).';
REVOKE ALL ON FUNCTION app.current_coach_has_scope(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_coach_has_scope(text, text) TO authenticated, service_role;

CREATE POLICY "habit_current_coach_select" ON "Habit"
  FOR SELECT TO public
  USING (app.current_coach_has_scope("user_id", 'fitness.habits_progress'));
COMMENT ON POLICY "habit_current_coach_select" ON "Habit" IS
  '20270502002500: the client''s current coach reads the habit while the client shares habits with them.';
CREATE POLICY "habit_current_coach_insert" ON "Habit"
  FOR INSERT TO public
  WITH CHECK ("assigned_by_coach_id" = app.current_user_id() AND app.current_coach_has_scope("user_id", 'fitness.habits_progress'));
COMMENT ON POLICY "habit_current_coach_insert" ON "Habit" IS
  '20270502002500: the client''s current coach sets a habit naming themself, while the client shares habits with them.';
CREATE POLICY "habit_current_coach_update" ON "Habit"
  FOR UPDATE TO public
  USING ("assigned_by_coach_id" = app.current_user_id() AND app.current_coach_has_scope("user_id", 'fitness.habits_progress'))
  WITH CHECK ("assigned_by_coach_id" = app.current_user_id() AND app.current_coach_has_scope("user_id", 'fitness.habits_progress'));
COMMENT ON POLICY "habit_current_coach_update" ON "Habit" IS
  '20270502002500: the client''s current coach edits a habit they set, while the client shares habits with them, before and after the change.';

ALTER POLICY "p_habitlog_select" ON "HabitLog"
  USING (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id"));
COMMENT ON POLICY "p_habitlog_select" ON "HabitLog" IS
  '20270502002500: a log is readable exactly when its habit is, under the caller''s own Habit row rules.';
ALTER POLICY "p_habitlog_insert" ON "HabitLog"
  WITH CHECK (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."user_id" = app.current_user_id()));
COMMENT ON POLICY "p_habitlog_insert" ON "HabitLog" IS
  '20270502002500: only the habit''s client writes a log.';
ALTER POLICY "p_habitlog_update" ON "HabitLog"
  USING (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."user_id" = app.current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."user_id" = app.current_user_id()));
COMMENT ON POLICY "p_habitlog_update" ON "HabitLog" IS
  '20270502002500: only the habit''s client updates a log, and keeps it on their own habit.';
ALTER POLICY "p_habitlog_delete" ON "HabitLog"
  USING (EXISTS (SELECT 1 FROM public."Habit" h WHERE h."id" = "HabitLog"."habit_id" AND h."user_id" = app.current_user_id()));
COMMENT ON POLICY "p_habitlog_delete" ON "HabitLog" IS
  '20270502002500: only the habit''s client deletes a log.';

COMMIT;
