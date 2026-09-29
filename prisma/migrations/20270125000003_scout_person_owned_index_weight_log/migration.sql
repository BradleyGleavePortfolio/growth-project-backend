-- S8-D3 step 4 of 12: person-owned index, built CONCURRENTLY
-- (docs/decisions/2026-09-26-s8d-person-link.md §2.1, §2.9 row D3-2).
--
-- WHAT: WeightLog(person_id, date): hot-path mirror of the user-owned index, leading with person_id so it
-- also serves the FK lookup.
--
-- WHY ONE STATEMENT PER DIRECTORY (Prisma 6.19): CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. Prisma's engine sends a migration file as one simple-query message, and
-- PostgreSQL runs a multi-statement message as ONE implicit transaction block (SQLSTATE 25001 —
-- this is exactly how the first cut of this step failed on GitHub). A single-statement file runs at
-- the top level, as the precedent 20260704000001_coach_brief_cwa_index_concurrent does. Steps 2-9
-- are therefore eight one-statement directories. No BEGIN/COMMIT bookend (it would re-break this).
--
-- LOCKS: SHARE UPDATE EXCLUSIVE; never blocks DML.
--
-- WHY IT IS SAFE TO RE-RUN: IF NOT EXISTS makes the CREATE idempotent. If a previous CONCURRENTLY
-- build failed mid-way, Postgres leaves an INVALID index that IF NOT EXISTS sees as already-present.
-- Operators should run `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` after deploy
-- and DROP INDEX CONCURRENTLY any invalid leftovers before re-running, per the Postgres docs.
--
-- ROLLBACK: down.sql (DROP INDEX CONCURRENTLY IF EXISTS, one statement, no transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "WeightLog_person_id_date_idx"
  ON public."WeightLog" ("person_id", "date");
