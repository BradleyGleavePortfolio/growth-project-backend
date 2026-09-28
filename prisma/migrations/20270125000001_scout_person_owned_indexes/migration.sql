-- S8-D3 (2 of 4): person-owned indexes, built CONCURRENTLY
-- (docs/decisions/2026-09-26-s8d-person-link.md §2.1, §2.9 row D3-2).
--
-- WHAT: one statement per index, CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS, on the
-- populated tables 1 of 4 widened:
--   * Person(id, coach_id) UNIQUE — the key the composite tenant FKs (3 of 4) reference. B7
--     ordering: this index exists and is promoted to a constraint BEFORE any FK names it.
--   * Hot-path mirrors of the user-owned indexes, leading with person_id so they also serve the
--     FK lookups: WorkoutSession(person_id, date), WeightLog(person_id, date), Habit(person_id),
--     ClientWorkoutAssignment(person_id, scheduled_for).
--   * CheckIn(person_id, date) UNIQUE WHERE person_id IS NOT NULL — the one-per-day rule for
--     person-owned rows (a unique index treats NULLs as distinct, so the existing (user_id, date)
--     key alone would not constrain them); it also serves person_id lookups.
--   * Person(linked_user_id), ImportNativeProvenance(person_id).
--
-- TRANSACTION HANDLING (Prisma 6.19, precedent 20260704000001_coach_brief_cwa_index_concurrent):
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Prisma 6.19's migration
--   engine does NOT wrap a migration file in a transaction, so these statements run at the top
--   level as required. No BEGIN/COMMIT bookend (it would re-break this, SQLSTATE 25001).
--
-- LOCKS: SHARE UPDATE EXCLUSIVE per index; never blocks DML.
--
-- WHY IT IS SAFE TO RE-RUN:
--   IF NOT EXISTS makes each CREATE idempotent. If a previous CONCURRENTLY build failed mid-way,
--   Postgres leaves an INVALID index that IF NOT EXISTS sees as already-present. Operators should
--   run:
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   after deploy and DROP INDEX CONCURRENTLY any invalid leftovers before re-running, per the
--   Postgres docs. 3 of 4 refuses to promote an invalid Person(id, coach_id) index.
--
-- ROLLBACK: down.sql (DROP INDEX CONCURRENTLY IF EXISTS, one statement each, no transaction).

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Person_id_coach_id_key"
  ON public."Person" ("id", "coach_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkoutSession_person_id_date_idx"
  ON public."WorkoutSession" ("person_id", "date");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "WeightLog_person_id_date_idx"
  ON public."WeightLog" ("person_id", "date");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Habit_person_id_idx"
  ON public."Habit" ("person_id");

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "CheckIn_person_id_date_key"
  ON public."CheckIn" ("person_id", "date") WHERE "person_id" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ClientWorkoutAssignment_person_id_scheduled_for_idx"
  ON public."ClientWorkoutAssignment" ("person_id", "scheduled_for");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Person_linked_user_id_idx"
  ON public."Person" ("linked_user_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImportNativeProvenance_person_id_idx"
  ON public."ImportNativeProvenance" ("person_id");
