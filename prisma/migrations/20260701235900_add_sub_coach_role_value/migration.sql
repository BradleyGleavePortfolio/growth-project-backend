-- IRREVERSIBLE
-- Adds the 'sub_coach' value to the "Role" enum.
--
-- Required by 20260702000000_fix_workout_rls_coach_role, which compares
-- User.role (the "Role" enum) against the literal 'sub_coach'. The baseline
-- creates "Role" as ('coach','student'); 20260427000000 adds 'owner'. No
-- migration ever added 'sub_coach', so the comparison failed at apply time
-- with: invalid input value for enum "Role": "sub_coach" (SQLSTATE 22P02).
--
-- IRREVERSIBLE because PostgreSQL < 17 cannot DROP a value from an enum type,
-- so there is no safe down migration. ADD VALUE IF NOT EXISTS makes this safe
-- to run against environments (e.g. production) that may already have the
-- value via a prior manual fix.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- PostgreSQL versions; Prisma 6.19 runs each migration file outside a
-- transaction, so no COMMIT/BEGIN bookend is needed (and adding one would
-- re-break it).

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'sub_coach';
