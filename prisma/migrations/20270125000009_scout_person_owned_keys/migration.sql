-- S8-D3 step 10 of 12: the Person tenant key and the foreign keys to Person
-- (docs/decisions/2026-09-26-s8d-person-link.md §2.2 item 3, §2.5, §2.9 row D3-3).
--
-- WHAT:
--   1. Promote the CONCURRENTLY-built unique index Person(id, coach_id) (step 2) to the constraint
--      "Person_id_coach_id_key" with ADD CONSTRAINT ... UNIQUE USING INDEX (metadata only).
--      A FK may only reference columns covered by a non-partial unique constraint or index that
--      already exists (B7), so this is the FIRST statement.
--   2. Composite tenant FKs, all NOT VALID (no scan; validated in step 11):
--        CheckIn(person_id, coach_id)            -> Person(id, coach_id)
--        PersonInvite(person_id, coach_id)       -> Person(id, coach_id)
--        PersonLink(person_id, coach_id)         -> Person(id, coach_id)
--        PersonLinkProposal(person_id, coach_id) -> Person(id, coach_id)
--      MATCH SIMPLE: a user-owned row (person_id NULL) is not checked; a person-owned CheckIn
--      must name a coach (CHECK in step 1), so its coach_id is pinned to the Person's tenant.
--   3. Plain person_id -> Person(id) FKs, NOT VALID: WorkoutSession, WeightLog, Habit,
--      ClientWorkoutAssignment, ImportNativeProvenance; and Person.linked_user_id -> User(id).
--   All ON DELETE RESTRICT ON UPDATE CASCADE (Prisma's generated shape): a Person with owned rows,
--   provenance or link history is never silently dropped (erasure is an explicit path, §2.3).
--
-- ENTRY GATE (refuses, never repairs): the step-2 index must exist, be unique, valid, ready,
-- non-partial and on exactly (id, coach_id); otherwise the promotion would fail or, worse, adopt
-- a decoy. Raw reruns are refused by the constraint already existing (fixed text).
--
-- LOCKS: short ACCESS EXCLUSIVE per ALTER TABLE; NOT VALID skips the scan. Atomic.
-- ROLLBACK: down.sql (drops the FKs and the constraint; data untouched).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public."Person"'::regclass AND conname = 'Person_id_coach_id_key'
  ) THEN
    RAISE EXCEPTION 'S8-D3 keys already applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indexrelid = to_regclass('public."Person_id_coach_id_key"')
      AND i.indrelid = 'public."Person"'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = i.indnatts AND i.indpred IS NULL AND i.indexprs IS NULL
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX "Person_id_coach_id_key" ON public."Person" USING btree (id, coach_id)'
  ) THEN
    RAISE EXCEPTION 'S8-D3 unexpected Person tenant key prerequisite';
  END IF;
END $$;

-- 1. Promote the index (step 2) to the unique constraint the FKs reference.
ALTER TABLE public."Person" ADD CONSTRAINT "Person_id_coach_id_key" UNIQUE USING INDEX "Person_id_coach_id_key";

-- 2. Composite tenant FKs (NOT VALID).
ALTER TABLE public."CheckIn" ADD CONSTRAINT "CheckIn_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonInvite" ADD CONSTRAINT "PersonInvite_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonLink" ADD CONSTRAINT "PersonLink_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."PersonLinkProposal" ADD CONSTRAINT "PersonLinkProposal_person_id_coach_id_fkey"
  FOREIGN KEY ("person_id", "coach_id") REFERENCES public."Person"("id", "coach_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- 3. Plain FKs (NOT VALID).
ALTER TABLE public."WorkoutSession" ADD CONSTRAINT "WorkoutSession_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."WeightLog" ADD CONSTRAINT "WeightLog_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."Habit" ADD CONSTRAINT "Habit_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."ClientWorkoutAssignment" ADD CONSTRAINT "ClientWorkoutAssignment_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."ImportNativeProvenance" ADD CONSTRAINT "ImportNativeProvenance_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES public."Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE public."Person" ADD CONSTRAINT "Person_linked_user_id_fkey"
  FOREIGN KEY ("linked_user_id") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

COMMIT;
