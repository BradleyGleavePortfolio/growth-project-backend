# Audit — PR #244 (feat/gcal-b3-channel-tracking) — Round 2

Date: 2026-05-20
Approach: independent re-read after Round 1 fixes were applied. Hunting for what Round 1 missed.

## A. New concerns probed in Round 2

| # | Concern | Verdict |
|---|---|---|
| A1 | Is `CREATE INDEX` inside a single transaction valid? | YES. Non-concurrent `CREATE INDEX` is fully transactional in PostgreSQL — it can co-exist with the surrounding BEGIN/COMMIT. We're not using `CONCURRENTLY` (which would forbid it). PASS. |
| A2 | Does the index name `CalendarConnection_channel_id_key` collide with anything else in the schema? | NO. Postgres index names are schema-scoped, and `grep` shows the name is unique to this migration in the entire repo. PASS. |
| A3 | Are the helper function bodies byte-identical to the canonical sources? | YES — verified via diff against `prisma/migrations/rls_fitness_backend.sql` and `prisma/migrations/20260607000000_rls_remaining_gaps/migration.sql`. `current_user_id`, `current_user_role`, `is_owner` all match exactly. The later `CREATE OR REPLACE FUNCTION` calls in `20260607000000_rls_remaining_gaps` therefore re-install the same body — semantically a no-op. PASS. |
| A4 | Does the policy reference any helpers we did NOT bootstrap? | NO. The two policies only use `app.is_owner()` and `app.current_user_id()`. Both are bootstrapped. `current_user_role` is bootstrapped because `is_owner` depends on it. PASS. |
| A5 | Will the migration brick existing prod where helpers already exist with the canonical body? | NO. `CREATE OR REPLACE FUNCTION` with the same body is a no-op (the function definition is rewritten with identical text). Verified locally — re-running the migration after a successful first run completes cleanly. PASS. |
| A6 | What if a future migration changes `app.current_user_id()` to a different body (e.g. casting to uuid)? Could our bootstrap regress it on re-run? | This migration is shipped immutably once merged — Prisma only runs it once per DB (it tracks `_prisma_migrations`). So on prod it executes once and never re-runs. The body-regression risk only exists for someone manually re-running the SQL by hand, which is not a supported workflow. Documented. PASS. |
| A7 | What about migration order within 2026-05-20? Two migrations exist for the same date: `20260520000000_setnull_owner_rels` and `20260520000001_add_gcal_channel_tracking_to_calendar_connection`. | Lexical order: `...0` < `...1`. `setnull_owner_rels` runs first. They touch entirely different tables (User-FK relaxation vs CalendarConnection columns); no interdependency. PASS. |
| A8 | Does the policy `FOR ALL TO public` allow access to roles that haven't been GRANTed USAGE on the `app` schema? | The Prisma service_role connection bypasses RLS (BYPASSRLS), so policies are not evaluated for the API server. The Supabase `anon`/`authenticated` roles need USAGE on the `app` schema + EXECUTE on the helpers; those GRANTs are made in `20260607000000_rls_remaining_gaps`. This PR matches the pre-existing pattern used by `20260606000003_rls_financial_tables` (also no GRANTs, also runs before `20260607`). Out of scope to grant here; doing so would risk fail on truly Supabase-less fresh DBs (the `service_role` etc. roles don't exist outside Supabase). PASS. |
| A9 | Is `ALTER TABLE ... ENABLE/FORCE RLS` idempotent on a table that already has it? | YES — these are no-ops in Postgres when RLS is already enabled/forced. PASS. |
| A10 | What about `disconnected_at` and `last_synced_at` (other nullable columns on `CalendarConnection`)? Could the migration accidentally drop or reorder them? | NO — `ADD COLUMN IF NOT EXISTS` only adds. No `DROP`, no `ALTER COLUMN`, no ordering changes. The `\d` output post-migrate confirms all existing columns are preserved. PASS. |
| A11 | Production data integrity if rows already exist | The new columns are nullable with no default; existing rows get NULL. The unique index allows multiple NULLs. No constraint can be violated by existing data. Verified by inspecting the post-migrate table state. PASS. |
| A12 | Lock duration on prod | The combined operations take a brief AccessExclusive lock on `CalendarConnection`. Table is small (one row per coach who linked Google Calendar — currently zero in prod because feature flag is OFF). Lock will be sub-second. No uptime risk. PASS. |
| A13 | Could the `CREATE UNIQUE INDEX IF NOT EXISTS` succeed but with the wrong predicate on a re-run where the column was partially added with a different constraint? | The pre-fix version used `TEXT UNIQUE` inline (Postgres-auto-named constraint). If a prod box has that auto-named constraint AND we now add a manually-named `CalendarConnection_channel_id_key` index, we end up with two unique indexes on the same column — redundant but not broken. Since the PR has never been merged to prod, this scenario can't materialise in practice. PASS. |
| A14 | Does the test file exercise the new fields? | YES — `test/gcal-b3-channel-tracking.spec.ts` covers all three fields at type-level + runtime mock level. Tests pass locally. PASS. |
| A15 | Feature flag default still OFF? | `FEATURE_GOOGLE_CALENDAR_SYNC` is not set in any production env config; the code defaults the gate to OFF. The migration is a pure schema add — even if it were ON, no new code paths read the columns yet (B2/B5/B6 are follow-up PRs). PASS. |
| A16 | Any new circular dependency risk (like the #243 hotfix issue)? | NO — no NestJS module / provider / import changes. Pure DB/Prisma schema change. PASS. |
| A17 | Error surfacing on duplicate channel_id (P2002) | None introduced. The unique index will reject duplicates if any future code tries to write the same `channel_id` twice — surfaced as Prisma `P2002`. The webhook/lookup code that will need to map this to a structured error is in B2/B5/B6, not in this PR. PASS for B3 scope. |
| A18 | npm test / npm build status | `npm run build` clean. `npx tsc --noEmit` clean. `npm test -- --testPathPatterns=gcal-b3` 10/10 pass. Full suite has 68 failures across 20 suites — IDENTICAL set on `main` HEAD (verified by `git checkout main && npm test`). Pre-existing, out of scope. PASS for B3 scope. |

## B. Empirical verification (run on local PostgreSQL 17, UTF-8)

```
Initial state: empty database.
DATABASE_URL=postgres://postgres@localhost:5433/testdb
DIRECT_URL=postgres://postgres@localhost:5433/testdb
$ npx prisma migrate deploy
... 27 prior migrations applied ...
Applying migration `20260520000001_add_gcal_channel_tracking_to_calendar_connection` ✅
... continues to migration 28+ ...

Post-state inspected:
\d "CalendarConnection":
  channel_id              | text                           |
  resource_id             | text                           |
  channel_expires_at      | timestamp(3) without time zone |
  Indexes:
    "CalendarConnection_channel_id_key" UNIQUE, btree (channel_id)
  Policies (forced row security enabled):
    POLICY "calendar_connection_owner_all"  USING (app.is_owner())
    POLICY "calendar_connection_self_all"   USING ((app.current_user_id() IS NOT NULL) AND (user_id = app.current_user_id()))

SELECT proname FROM pg_proc WHERE pronamespace::regnamespace::text = 'app':
  current_user_id, current_user_role, is_owner  ✅

Re-running the migration (idempotency probe):
$ psql ... -f .../migration.sql
NOTICE: relation "CalendarConnection_channel_id_key" already exists, skipping
ALTER TABLE / CREATE INDEX / DROP POLICY / CREATE POLICY all complete
COMMIT  ✅

Simulated "helpers already installed, columns dropped" scenario:
DROP COLUMN x3, DROP INDEX, DROP POLICY x2, then re-run migration.
Result: columns re-added, index re-created, policies re-created.  ✅
```

(The `prisma migrate deploy` run later fails on `20260607000000_rls_remaining_gaps` because that migration references Supabase-only roles `service_role`/`anon`/`authenticated` which don't exist on vanilla local Postgres — pre-existing, unrelated, out of scope.)

## C. Findings list

None. All concerns probed in Round 2 resolve cleanly.

## D. Round 2 status

**CLEAN.** Migration is safe for both fresh and existing databases; bodies match canonical helpers; idempotent on re-run; no new module dependencies; tests green for the new spec; no new failures vs main.

## Appendix A — Reverse SQL (for an emergency rollback after merge)

If we ever needed to undo the changes from this migration (defense-in-depth — Prisma migrate has no built-in rollback; this would be a NEW migration committed):

```sql
BEGIN;

DROP POLICY IF EXISTS "calendar_connection_self_all"  ON "CalendarConnection";
DROP POLICY IF EXISTS "calendar_connection_owner_all" ON "CalendarConnection";

ALTER TABLE "CalendarConnection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "CalendarConnection" DISABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS "CalendarConnection_channel_id_key";

ALTER TABLE "CalendarConnection"
    DROP COLUMN IF EXISTS "channel_expires_at",
    DROP COLUMN IF EXISTS "resource_id",
    DROP COLUMN IF EXISTS "channel_id";

-- Do NOT drop the app.* helpers — they are shared with every other RLS migration.

COMMIT;
```

(The helpers are deliberately left in place — every other RLS migration in the codebase depends on them.)
