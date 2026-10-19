-- TRAIN-BE2 (Coach's page, plan C2): a coach's comment on a client's logged
-- workout, one per coach per workout. Additive: one table, two read
-- policies, no data change.
--
-- Row rules (RLS enabled and forced; anon has no table access):
--   * the client reads every comment on their own workouts, a former coach's
--     included (history follows the client);
--   * a coach reads only their own comments, and only while the client is
--     theirs (app.is_current_coach_of); a new coach never reads a former
--     coach's;
--   * no API role writes: the server writes through Prisma's service-role
--     connection (bypasses RLS) behind the coach routes' roster gate.
-- Live proof: test/rls/workout-comments-history-rls.spec.ts (rls-live-tests).
-- Reverse: down.sql.

SET lock_timeout = '5s';

CREATE TABLE "WorkoutComment" (
    "id" TEXT NOT NULL,
    "workout_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkoutComment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkoutComment_workout_id_coach_id_key" ON "WorkoutComment"("workout_id", "coach_id");
CREATE INDEX "WorkoutComment_coach_id_idx" ON "WorkoutComment"("coach_id");

ALTER TABLE "WorkoutComment" ADD CONSTRAINT "WorkoutComment_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "WorkoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkoutComment" ADD CONSTRAINT "WorkoutComment_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkoutComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkoutComment" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WorkoutComment" FROM anon;

CREATE POLICY "WorkoutComment_client_select" ON "WorkoutComment" FOR SELECT TO public
  USING (EXISTS (SELECT 1 FROM public."WorkoutSession" ws
    WHERE ws."id" = "WorkoutComment"."workout_id" AND ws."user_id" = app.current_user_id()));
CREATE POLICY "WorkoutComment_author_select" ON "WorkoutComment" FOR SELECT TO public
  USING ("coach_id" = app.current_user_id() AND EXISTS (SELECT 1 FROM public."WorkoutSession" ws
    WHERE ws."id" = "WorkoutComment"."workout_id" AND app.is_current_coach_of(ws."user_id")));

RESET lock_timeout;
