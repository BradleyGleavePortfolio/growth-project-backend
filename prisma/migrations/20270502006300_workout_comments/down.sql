-- Down for 20270502005800_workout_comments (TRAIN-BE2). Drops the table (its
-- policies go with it). Irreversible for data: every coach comment on a
-- workout is deleted; the workouts stay.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "WorkoutComment";

RESET lock_timeout;
