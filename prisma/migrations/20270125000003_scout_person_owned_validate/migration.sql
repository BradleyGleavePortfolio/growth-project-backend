-- S8-D3 (4 of 4): validate every NOT VALID constraint from 1 of 4 and 3 of 4
-- (docs/decisions/2026-09-26-s8d-person-link.md §2.9 row D3-4).
--
-- WHAT: ALTER TABLE ... VALIDATE CONSTRAINT, one statement each, for the six CHECKs (1 of 4) and the
-- ten foreign keys (3 of 4). Every existing row is user-owned with person_id NULL, so every CHECK
-- holds trivially and every FK has nothing to match; the scan is a proof, not a repair. If a row
-- ever violated one, this file fails and nothing is changed (no backfill, no deletion).
--
-- LOCKS: SHARE UPDATE EXCLUSIVE per statement (full scan, no write block). Atomic; a rerun is a
-- no-op (validating an already-valid constraint does nothing).
-- ROLLBACK: down.sql (drops and re-adds each constraint NOT VALID — the only way to return a
-- constraint to its unvalidated state).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public."WorkoutSession" VALIDATE CONSTRAINT "WorkoutSession_owner_xor_check";
ALTER TABLE public."WeightLog" VALIDATE CONSTRAINT "WeightLog_owner_xor_check";
ALTER TABLE public."Habit" VALIDATE CONSTRAINT "Habit_owner_xor_check";
ALTER TABLE public."CheckIn" VALIDATE CONSTRAINT "CheckIn_owner_xor_check";
ALTER TABLE public."CheckIn" VALIDATE CONSTRAINT "CheckIn_person_coach_check";
ALTER TABLE public."ClientWorkoutAssignment" VALIDATE CONSTRAINT "ClientWorkoutAssignment_owner_xor_check";

ALTER TABLE public."CheckIn" VALIDATE CONSTRAINT "CheckIn_person_id_coach_id_fkey";
ALTER TABLE public."PersonInvite" VALIDATE CONSTRAINT "PersonInvite_person_id_coach_id_fkey";
ALTER TABLE public."PersonLink" VALIDATE CONSTRAINT "PersonLink_person_id_coach_id_fkey";
ALTER TABLE public."PersonLinkProposal" VALIDATE CONSTRAINT "PersonLinkProposal_person_id_coach_id_fkey";

ALTER TABLE public."WorkoutSession" VALIDATE CONSTRAINT "WorkoutSession_person_id_fkey";
ALTER TABLE public."WeightLog" VALIDATE CONSTRAINT "WeightLog_person_id_fkey";
ALTER TABLE public."Habit" VALIDATE CONSTRAINT "Habit_person_id_fkey";
ALTER TABLE public."ClientWorkoutAssignment" VALIDATE CONSTRAINT "ClientWorkoutAssignment_person_id_fkey";
ALTER TABLE public."ImportNativeProvenance" VALIDATE CONSTRAINT "ImportNativeProvenance_person_id_fkey";
ALTER TABLE public."Person" VALIDATE CONSTRAINT "Person_linked_user_id_fkey";

COMMIT;
