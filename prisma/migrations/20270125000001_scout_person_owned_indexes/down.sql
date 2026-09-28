-- S8-D3 (2 of 4) rollback: drop the CONCURRENTLY-built indexes, one statement each, outside any
-- transaction (DROP INDEX CONCURRENTLY cannot run inside a transaction block). Run AFTER the
-- 20270125000002 down (which drops the constraint that owns "Person_id_coach_id_key"; IF EXISTS
-- makes that drop a no-op here) and BEFORE the 20270125000000 down (which drops the columns).
-- Metadata and index data only; no row is touched.

DROP INDEX CONCURRENTLY IF EXISTS public."ImportNativeProvenance_person_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."Person_linked_user_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."ClientWorkoutAssignment_person_id_scheduled_for_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."CheckIn_person_id_date_key";
DROP INDEX CONCURRENTLY IF EXISTS public."Habit_person_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."WeightLog_person_id_date_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."WorkoutSession_person_id_date_idx";
DROP INDEX CONCURRENTLY IF EXISTS public."Person_id_coach_id_key";
