-- SHARE-UNWIND (#SHARE-SIMPLE, #SHARE-JOIN op 1): check-ins and habits follow the coaching relationship,
-- like workouts, food logs and weigh-ins (20270502000700, 20270502000900): at the row layer the client's current
-- coach reads them and sets habits; a former coach, another coach and a sub-coach read none (a sub-coach reads through
-- the API during an open delegation, as for workouts). The old Check-ins and habits switch
-- (fitness.habits_progress) no longer counts; its rows stay as history. CheckIn already follows
-- app.is_current_coach_of (20270502000100). Body and the three Habit policy comments only: name, arguments, security,
-- search_path, grants and the Habit / HabitLog policies that call it are unchanged. Reverse: down.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app.current_coach_has_scope(client_user_id text, consent_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app.is_current_coach_of(client_user_id)
$$;
COMMENT ON FUNCTION app.current_coach_has_scope(text, text) IS
  '20270502004000: true when the caller is the client''s current coach; the consent scope no longer counts (SHARE-UNWIND).';
COMMENT ON POLICY "habit_current_coach_select" ON "Habit" IS '20270502004000: the client''s current coach reads the habit.';
COMMENT ON POLICY "habit_current_coach_insert" ON "Habit" IS '20270502004000: the client''s current coach sets a habit naming themself.';
COMMENT ON POLICY "habit_current_coach_update" ON "Habit" IS '20270502004000: the client''s current coach edits a habit they set, before and after the change.';

COMMIT;
