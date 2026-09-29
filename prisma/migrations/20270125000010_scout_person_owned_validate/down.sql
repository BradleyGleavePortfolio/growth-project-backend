-- S8-D3 step 11 of 12 rollback: return each constraint to its NOT VALID state (PostgreSQL has no
-- "unvalidate", so each is dropped and re-added NOT VALID with the identical definition from
-- step 1 / step 10). Run SECOND in the S8-D3 down chain (after 20270125000011/down.sql). Metadata only; no row is touched; the
-- constraints keep enforcing new writes throughout.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public."WorkoutSession" DROP CONSTRAINT IF EXISTS "WorkoutSession_owner_xor_check";
ALTER TABLE public."WorkoutSession" ADD CONSTRAINT "WorkoutSession_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;
ALTER TABLE public."WeightLog" DROP CONSTRAINT IF EXISTS "WeightLog_owner_xor_check";
ALTER TABLE public."WeightLog" ADD CONSTRAINT "WeightLog_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;
ALTER TABLE public."Habit" DROP CONSTRAINT IF EXISTS "Habit_owner_xor_check";
ALTER TABLE public."Habit" ADD CONSTRAINT "Habit_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_owner_xor_check";
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_owner_xor_check"
  CHECK (("user_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;
ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_person_coach_check";
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_person_coach_check"
  CHECK ("person_id" IS NULL OR "coach_id" IS NOT NULL) NOT VALID;
ALTER TABLE public."ClientWorkoutAssignment" DROP CONSTRAINT IF EXISTS "ClientWorkoutAssignment_owner_xor_check";
ALTER TABLE public."ClientWorkoutAssignment" ADD CONSTRAINT "ClientWorkoutAssignment_owner_xor_check"
  CHECK (("client_id" IS NULL) <> ("person_id" IS NULL)) NOT VALID;

ALTER TABLE public."CheckIn" DROP CONSTRAINT IF EXISTS "CheckIn_person_id_coach_id_fkey";
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonInvite" DROP CONSTRAINT IF EXISTS "PersonInvite_person_id_coach_id_fkey";
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonLink" DROP CONSTRAINT IF EXISTS "PersonLink_person_id_coach_id_fkey";
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonLinkProposal" DROP CONSTRAINT IF EXISTS "PersonLinkProposal_person_id_coach_id_fkey";
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE public."WorkoutSession" DROP CONSTRAINT IF EXISTS "WorkoutSession_person_id_fkey";
ALTER TABLE public."WorkoutSession" ADD CONSTRAINT "WorkoutSession_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."WeightLog" DROP CONSTRAINT IF EXISTS "WeightLog_person_id_fkey";
ALTER TABLE public."WeightLog" ADD CONSTRAINT "WeightLog_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."Habit" DROP CONSTRAINT IF EXISTS "Habit_person_id_fkey";
ALTER TABLE public."Habit" ADD CONSTRAINT "Habit_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."ClientWorkoutAssignment" DROP CONSTRAINT IF EXISTS "ClientWorkoutAssignment_person_id_fkey";
ALTER TABLE public."ClientWorkoutAssignment" ADD CONSTRAINT "ClientWorkoutAssignment_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."ImportNativeProvenance" DROP CONSTRAINT IF EXISTS "ImportNativeProvenance_person_id_fkey";
ALTER TABLE public."ImportNativeProvenance" ADD CONSTRAINT "ImportNativeProvenance_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."Person" DROP CONSTRAINT IF EXISTS "Person_linked_user_id_fkey";
ALTER TABLE public."Person" ADD CONSTRAINT "Person_linked_user_id_fkey"
  FOREIGN KEY ("linked_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

COMMIT;
