-- HOME-BE: the coach Home's day (GET /coach/command-center/overview?include=home).
--
-- 1. "CoachMessage"."automated_by" (nullable, no default, so the ADD is a
--    catalog-only change with no table rewrite). Set only by
--    MessagingService.sendAsCoach's internal `automatedBy` option on messages
--    no person sent at that moment: 'coach_welcome' (the welcome scheduler)
--    and 'package_message' (a package's auto message, at purchase or on a
--    scheduled drop). The Home's Replies and Reach-outs rings skip those rows.
--    NULL for every message a person sent. Row security on "CoachMessage" is
--    unchanged (a new column takes the table's policies).
--
-- 2. Index on "ExerciseSet"."workout_id": the Home's lifting-best read joins a
--    client's WorkoutSession rows to their ExerciseSet rows by workout_id,
--    which has a foreign key but no index. Built inside this file's implicit
--    transaction (plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY must be
--    the only statement in a migration file, and fix round 1 puts the column
--    in this same migration). It holds a SHARE lock on "ExerciseSet" (reads go
--    on, set inserts wait) only while the index builds over today's rows.
--    The name is Prisma's for @@index([workout_id]), so `prisma migrate diff`
--    stays drift-free.
--
-- RE-RUN: IF NOT EXISTS on both. ROLLBACK: down.sql.

ALTER TABLE "CoachMessage" ADD COLUMN IF NOT EXISTS "automated_by" TEXT;

CREATE INDEX IF NOT EXISTS "ExerciseSet_workout_id_idx" ON "ExerciseSet"("workout_id");
