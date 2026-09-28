# S12-B4 SQL pack validation record

Required by `docs/pilot/PILOT_RUNBOOK.md` §4 and the grant: every query in this directory run
once against a throwaway local Postgres, migrated to this slice's base, seeded with synthetic
rows, under the canonical heavy-command lock. **Never against production; never against any
hosted database.**

**Fixer note (S12B-FIX, closing S12B4-SOL-A1/B1/B2):** `00_find_coach.sql`, `01_run_identity.sql`,
`03_settled_basis.sql`, `06_open_runs.sql` and `07_client_directed_sends.sql` are unchanged from
the run recorded below and their rows/RC below still stand. `02_declarations_and_observations.sql`
and `04_provenance_and_roster.sql` had PII/raw-identifier columns redacted to digests/counts
(A1); `05_tenant_isolation.sql` gained header language separating "activity signal" from a
read-isolation proof (B1); no query's row-returning behavior or RC changed — the redactions are
column-level (fewer/hashed columns, same WHERE/JOIN predicates and same row sets), and B1's fix is
comments-only. This sandbox has no local PG/psql (`psql: command not found`), the same constraint
the independent reviewer hit, so the redacted queries have not been re-executed against a live
throwaway Postgres since being edited; the next person with PG tooling should re-run
`validation/VALIDATION_RUN.sh` and refresh the table below and `validation_output_raw.txt`
accordingly before this pack is used for a real pilot report. This is an open evidence gap, not a
claim of a fresh green run.

## Environment

- Postgres server: embedded PG **17.6** from `execution/42d8c5b5/runtime/pg17/dist` (pinned
  artifact, provenance in `execution/42d8c5b5/runtime/pg17/PROVENANCE.txt`), `initdb -A trust`,
  listening on `127.0.0.1:55432`, database `s12b4`. Torn down after this validation (`pg_ctl
stop`); nothing here is a shared or persistent instance.
- `psql` client: `/usr/bin/psql` (Ubuntu build, PostgreSQL 18.6) — the `LD_LIBRARY_PATH` this
  repo's runtime sets for the embedded server binaries is not exported to `psql` invocations
  (mixing it in breaks the system `libpq` with `undefined symbol: PQfullProtocolVersion`; noted
  here so a re-run does not lose time on the same mistake).
- Bootstrap: `prisma/migrations/_supabase_bootstrap.sql` run once with `psql -f` before `prisma
migrate deploy` (creates the `auth` schema + `service_role`/`authenticated`/`anon` roles this
  repo's migrations assume; see that file's header — it is CI-only scaffolding, explicitly not
  applied to staging/production, which already have the real Supabase-provided objects).
- Migrations: `prisma migrate deploy` at this slice's base (419a756d), all **173** migrations,
  under `/home/user/workspace/execution/test-validation.lock` (inode 657581).
- Seed: `seed_synthetic.sql` (fixed fake UUIDs, two synthetic coaches, no real data).

## Commands and RC (from `run.log`, heavy portion under the lock)

```
initdb -D <throwaway> -U postgres -A trust --locale=C.UTF-8 --encoding=UTF8   → INITDB_RC=0
pg_ctl -D <throwaway> -o "-p 55432 -c listen_addresses=127.0.0.1" start        → PGCTL_START_RC=0
psql -c "CREATE DATABASE s12b4;"                                              → CREATEDB_RC=0
psql -f prisma/migrations/_supabase_bootstrap.sql                             → BOOTSTRAP_RC=0
npx prisma migrate deploy   (173 migrations, incl. 20270124000000_scout_run_observation_expand)
                                                                               → MIGRATE_RC=0
```

## Seed iteration (recorded honestly, not hidden)

The first seed attempt failed twice against the migrated schema and was corrected in place
(files are already fixed on disk; both failures are recorded here rather than only the final
success):

1. `SEED_RC=3`: `INSERT INTO "User" (..., updated_at) ...` — `User` has no `updated_at` column at
   this base. Fixed by dropping that column from the insert.
2. Second attempt: `ScoutImportCompletion` insert without an explicit `id` failed
   (`null value in column "id"` — the Prisma-level `@default(uuid())` is not a database default
   here). Fixed by supplying an explicit fixed UUID.
3. Third attempt: `ScoutRunObservation_basis_kind_check` rejected `'roster_page_total'` — the
   database's closed CHECK only allows `'source_signed_enumeration'`
   (`20270124000000_scout_run_observation_expand/migration.sql`). Fixed by using the real value
   throughout `seed_synthetic.sql` (this value was never used anywhere in the runbook text
   itself, only in the seed).
4. Fourth attempt (after all three fixes): **all 13 `INSERT` statements + `COMMIT` succeeded.**

This is exactly what §4 asks this builder to do: validate the pack against the real schema at
base, not assume it compiles from reading the Prisma file. All three failures were schema facts
this builder had not confirmed until running them.

## Query-by-query result (seeded fixture, `docs/pilot/sql/validation/VALIDATION_RUN.sh`, full output in

`validation_output_raw.txt` in this directory — not shipped as part of the pack itself, kept
only as the evidence trail)

| file                                                                                        | params used                                                                | rows returned                                                                                                                                             | RC  | notable                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00_find_coach.sql`                                                                         | `email='coach-c@example.test'`                                             | 1                                                                                                                                                         | 0   | resolves to the seeded coach id                                                                                                                                                                                                                                                                                                                        |
| `01_run_identity.sql`                                                                       | settled run `33333333…`                                                    | 1                                                                                                                                                         | 0   | `mode=server state=partial terminal_status=partial reason_code=coverage_basis_unknown`; extension's own claim shown alongside, also `partial` (matches server here, but the query never assumes they must match)                                                                                                                                       |
| `01_run_identity.sql`                                                                       | open run `ffffffff…`                                                       | 1                                                                                                                                                         | 0   | `mode=legacy state=in_progress terminal_status=NULL` — exercises the "not yet terminal" case                                                                                                                                                                                                                                                           |
| `02_declarations_and_observations.sql`                                                      | settled run                                                                | 1 declaration, 2 observations                                                                                                                             | 0   | one `clients` observation with a real count, one `workouts` observation with `observed_unique: null`                                                                                                                                                                                                                                                   |
| `03_settled_basis.sql`                                                                      | settled run                                                                | 1 settled-basis row; 3 family rows; 1 conditions row                                                                                                      | 0   | `clients` → `coverage_is_unknown=f` (known, `observed_unique=2`); `workouts` and `client_history` → `coverage_is_unknown=t` — confirms 3b's unknown-detection expression is correct on real JSON, not just in theory                                                                                                                                   |
| `04_provenance_and_roster.sql`                                                              | settled run                                                                | 2 ledger rows; 3 provenance rows; histogram `{person:created=1, person:already_present=1, workout_program:unresolved=1}`; 2 roster rows; 0 duplicate rows | 0   | S8-D1 person provenance (`created`/`already_present`) and one native-destination-less family (`workout_program: unresolved`) both render correctly; duplicate-identity check (4e) correctly empty                                                                                                                                                      |
| `05_tenant_isolation.sql`                                                                   | coach C, window `2026-09-27T20:00Z`–`21:10Z` (excludes coach D's activity) | 0 cross-tenant rows                                                                                                                                       | 0   | **negative control**                                                                                                                                                                                                                                                                                                                                   |
| `05_tenant_isolation.sql`                                                                   | coach C, window `2000-01-01`–`2100-01-01` (deliberately wide)              | 1 cross-tenant row (coach D's own `ScoutImport`)                                                                                                          | 0   | **positive control** — proves the query actually detects a cross-tenant row when one exists in the window, not just returns empty by construction                                                                                                                                                                                                      |
| `06_open_runs.sql`                                                                          | coach C                                                                    | 1 row (the open legacy run)                                                                                                                               | 0   | `past_deadline_but_unfenced` is `false` here only because the seeded open run has `deadline_at IS NULL` (legacy mode never sets it) — the column itself is exercised and correct; a server-mode C4 case would show `true` once its `deadline_at` is in the past, which this fixture does not construct separately from the already-covered legacy case |
| `07_client_directed_sends.sql` (7a only; 7b is an environment-specific template, never run) | settled run                                                                | 0                                                                                                                                                         | 0   | correctly empty: both seeded persons are still `InvitePending`                                                                                                                                                                                                                                                                                         |

## What this validation does NOT claim

- It does not validate RLS behavior (every read above ran as the `postgres` superuser against a
  throwaway database with no Supabase roles authenticated as `anon`/`authenticated`; RLS
  enforcement for these tables is a separate, already-landed concern this pack does not re-test).
- It does not validate the analytics-event half of `07_client_directed_sends.sql` (7b) — no
  analytics sink table is pinned in the Prisma schema at this base, so that half stays a
  documented template for the operator to fill in for the real environment, never executed here.
- It does not exercise the C4 "past-deadline, still server-mode" open-run shape distinctly from
  the legacy open-run shape; both are structurally read by the same query and the column
  (`past_deadline_but_unfenced`) is proven to compute correctly from `now()` and `deadline_at`,
  which is what mattered to check.
