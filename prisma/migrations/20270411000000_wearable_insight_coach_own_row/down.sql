-- Reverse of 20270411000000_wearable_insight_coach_own_row. Only for a
-- confirmed defect: it lets a client's current coach read every coach-side
-- insight row of that client again, including rows cached for other coaches.

SET lock_timeout = '5s';

ALTER POLICY "wic_coach_select" ON "WearableInsightCache"
  USING (app.is_current_coach_of("user_id"));

RESET lock_timeout;
