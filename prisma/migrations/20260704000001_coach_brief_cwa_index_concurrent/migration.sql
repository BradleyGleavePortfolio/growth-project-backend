-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260704000001_coach_brief_cwa_index_concurrent
--
-- WHAT:  Create the (assigned_by_coach_id, approved_by_coach_at) index on
--        ClientWorkoutAssignment that supports the Coach Brief
--        "workouts pending coach approval" query path.
--
-- WHY CONCURRENTLY (Audit #4, P2-1):
--   ClientWorkoutAssignment is a hot, populated production table. A standard
--   CREATE INDEX takes an ACCESS EXCLUSIVE lock for the duration of the index
--   build, which blocks INSERT/UPDATE/DELETE on the entire table. On a large
--   table that can mean tens of seconds to minutes of write downtime — bad
--   enough to cause request timeouts in the assignment flow.
--
--   CREATE INDEX CONCURRENTLY builds the index without blocking writes. It
--   takes longer in wall-clock time and uses more I/O, but only takes a
--   ShareUpdateExclusive lock that does not conflict with normal DML.
--
-- WHY THE COMMIT / BEGIN BOOKENDS:
--   Prisma migrate deploy wraps every migration file in a single transaction.
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The
--   accepted Prisma 5 workaround is to break out of the implicit transaction
--   with COMMIT, run the concurrent index build at the top level, and then
--   start a fresh transaction so Prisma's wrapping COMMIT still has something
--   to close. This is documented in:
--     https://github.com/prisma/prisma/issues/12940
--     https://github.com/prisma/prisma/issues/13672
--
-- WHY IT IS SAFE TO RE-RUN:
--   IF NOT EXISTS makes the CREATE idempotent. If a previous CONCURRENTLY
--   build failed mid-way, Postgres leaves an INVALID index that IF NOT EXISTS
--   will see as already-present. Operators should run:
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   after deploy and DROP INDEX CONCURRENTLY any invalid leftovers before
--   re-running, per Postgres docs.
--
-- ROLLBACK:
--   COMMIT;
--   DROP INDEX CONCURRENTLY IF EXISTS
--     "ClientWorkoutAssignment_assigned_by_coach_id_approved_by_coa_idx";
--   BEGIN;
-- ─────────────────────────────────────────────────────────────────────────────

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "ClientWorkoutAssignment_assigned_by_coach_id_approved_by_coa_idx"
  ON "ClientWorkoutAssignment" ("assigned_by_coach_id", "approved_by_coach_at");

BEGIN;
