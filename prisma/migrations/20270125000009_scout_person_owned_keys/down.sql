-- S8-D3 step 10 of 11 rollback: drop the FKs to Person / User and the Person(id, coach_id) constraint,
-- then restore the exact pre-step-10 state.
-- Run AFTER the 20270125000010 down and BEFORE the 20270125000008..01 downs.
-- Metadata only; no row is touched or checked (the FKs go away, nothing is orphaned by this).
--
-- WHY THE INDEX IS REBUILT HERE: `ADD CONSTRAINT ... UNIQUE USING INDEX` (step 10) takes ownership of
-- the step-2 index, so DROP CONSTRAINT also drops that index. The pre-step-10 state is "plain unique
-- index present, no constraint" — which is what step 10's entry gate requires and what step 2's own
-- down (DROP INDEX CONCURRENTLY IF EXISTS) reverses. A staged down must restore exactly that state,
-- otherwise steps 3..9 cannot be reversed and re-applied on their own (step 10 would refuse its
-- prerequisite). This is the defect the "New migrations are reversible" CI check caught on 1ae0303.
--
-- The rebuild runs OUTSIDE the transaction (CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block) and is the last statement of this file, so `psql -f` executes it at the top level after
-- COMMIT. Operators: this file is applied with psql, never through `prisma migrate deploy`.
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

-- Drops the constraint AND the index it owns.
ALTER TABLE public."Person" DROP CONSTRAINT IF EXISTS "Person_id_coach_id_key";

COMMIT;

-- Restore the step-2 state: the plain unique index, built CONCURRENTLY (SHARE UPDATE EXCLUSIVE;
-- never blocks DML). Same name and definition as 20270125000001/migration.sql, so step 10's entry
-- gate accepts it on re-apply and step 2's down removes it on a full rollback.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Person_id_coach_id_key"
  ON public."Person" ("id", "coach_id");
