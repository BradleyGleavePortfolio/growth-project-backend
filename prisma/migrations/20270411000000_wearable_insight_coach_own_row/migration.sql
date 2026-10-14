-- WearableInsightCache: a coach reads only the coach-side row cached for them
-- (owner 4, A1H follow-up). Since backend #947 a coach-side row is stored as
-- side 'coach:<coachId>' and served only to that coach. "wic_coach_select"
-- (20260531000000) admitted every row of a client to the client's current
-- coach, so with direct table access a new coach could read the coach-side
-- row cached for the client's old coach (its hypothesis and message draft).
--
-- Now the current coach reads:
--   * the client's own client-side row (side 'client'), as before;
--   * the coach-side row whose side is 'coach:' || their own User.id.
-- No coach reads another coach's row or a legacy shared 'coach' row: the
-- backend no longer reads those (#947) and the next wearable sync deletes them.
-- Unchanged: the client reads only their client-side row
-- ("wic_client_select"), owners read every row ("wic_owner_all"). The server
-- reads and writes this table through Prisma, which bypasses RLS, so no app
-- path changes. RLS stays on and forced (20260531000000). Reverse: down.sql.

SET lock_timeout = '5s';

ALTER POLICY "wic_coach_select" ON "WearableInsightCache"
  USING (
    app.is_current_coach_of("user_id")
    AND ("side" = 'client' OR "side" = ('coach:' || app.current_user_id()))
  );

RESET lock_timeout;
