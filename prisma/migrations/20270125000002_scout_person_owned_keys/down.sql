-- S8-D3 (3 of 4) rollback: drop the FKs to Person / User and the Person(id, coach_id) constraint.
-- Run AFTER the 20270125000003 down and BEFORE the 20270125000001 down. Dropping the constraint
-- also drops the index it owns ("Person_id_coach_id_key"); the 2 of 4 down's IF EXISTS covers it.
-- Metadata only; no row is touched or checked (the FKs go away, nothing is orphaned by this).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public."Person" DROP CONSTRAINT IF EXISTS "Person_linked_user_id_fkey";
ALTER TABLE public."ImportNativeProvenance" DROP CONSTRAINT IF EXISTS "ImportNativeProvenance_person_id_fkey";
ALTER TABLE public."ClientWorkoutAssignment" DROP CONSTRAINT IF EXISTS "ClientWorkoutAssignment_person_id_fkey";
ALTER TABLE public."Habit" DROP CONSTRAINT IF EXISTS "Habit_person_id_fkey";
ALTER TABLE public."WeightLog" DROP CONSTRAINT IF EXISTS "WeightLog_person_id_fkey";
ALTER TABLE public."WorkoutSession" DROP CONSTRAINT IF EXISTS "WorkoutSession_person_id_fkey";

ALTER TABLE public."PersonLinkProposal" DROP CONSTRAINT IF EXISTS "PersonLinkProposal_person_id_coach_id_fkey";
ALTER TABLE public."PersonLink" DROP CONSTRAINT IF EXISTS "PersonLink_person_id_coach_id_fkey";
ALTER TABLE public."PersonInvite" DROP CONSTRAINT IF EXISTS "PersonInvite_person_id_coach_id_fkey";
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_person_id_coach_id_fkey";

ALTER TABLE public."Person" DROP CONSTRAINT IF EXISTS "Person_id_coach_id_key";

COMMIT;
