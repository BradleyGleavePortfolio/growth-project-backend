-- Reverse of 20270416000000_macro_target_current_coach. Only for a confirmed
-- defect: it lets a former coach read and write a moved client's macro
-- targets again through direct table access.

SET lock_timeout = '5s';

ALTER POLICY "macro_target_coach_all" ON "MacroTarget"
  USING (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id())
  WITH CHECK (app.current_user_id() IS NOT NULL AND "coach_id" = app.current_user_id());

RESET lock_timeout;
