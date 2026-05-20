# Audit — PR #244 (feat/gcal-b3-channel-tracking) — Round 1

Date: 2026-05-20
Scope: end-to-end audit of the PR diff after applying the migration self-bootstrap fix.

## A. Migration safety (`20260520000001_add_gcal_channel_tracking_to_calendar_connection`)

| # | Concern | Finding | Action |
|---|---|---|---|
| A1 | Fresh-DB safety | Original migration referenced `app.current_user_id()` / `app.is_owner()` which are NOT created until `20260607000000_rls_remaining_gaps` (later) and the loose `rls_fitness_backend.sql` (never run by `prisma migrate deploy`). On a fresh `prisma migrate deploy` the migration would fail with `function app.is_owner() does not exist`. | **FIXED** — migration now self-bootstraps `CREATE SCHEMA IF NOT EXISTS app` + `CREATE OR REPLACE FUNCTION app.current_user_id()` + `app.current_user_role()` + `app.is_owner()` with bodies identical to the canonical definitions in `rls_fitness_backend.sql` and `20260607000000_rls_remaining_gaps`. Verified end-to-end on local Postgres 17: `prisma migrate deploy` from an empty DB now applies migration 28/64 (this one) cleanly and the `CalendarConnection` columns + policies are present. |
| A2 | Idempotency on re-run | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` covers re-run. The original used `TEXT UNIQUE` inline which would create a Postgres-named constraint NOT matching Prisma's expected index name `CalendarConnection_channel_id_key`; on re-run the IF NOT EXISTS would skip the column but the constraint name would still differ from what Prisma generates. | **FIXED** — replaced inline `UNIQUE` with explicit `CREATE UNIQUE INDEX IF NOT EXISTS "CalendarConnection_channel_id_key" ON "CalendarConnection" ("channel_id")`. Verified by re-running the migration against the test DB twice — second run is a clean no-op. |
| A3 | Existing-DB safety (helpers already installed) | Operators on staging/prod have already manually applied `rls_fitness_backend.sql` so `app.*` helpers exist. `CREATE OR REPLACE FUNCTION` with the same body is a safe no-op. | PASS. Bodies are byte-identical to the source. Simulated: dropped the new columns/policies on the test DB and re-applied the migration — succeeded. |
| A4 | RLS catch-up | Migration enables + forces RLS on `CalendarConnection` which was left without RLS in `20260512000000_concierge_scheduling`. This is the right place to catch up. | PASS. Matches the precedent in `20260606000003_rls_financial_tables` and `20260607000000_rls_remaining_gaps`. |
| A5 | Policy correctness | `calendar_connection_self_all` checks `app.current_user_id() IS NOT NULL AND user_id = app.current_user_id()`. NULL check first prevents accidental "anyone with no context can see everything" if `current_setting` returns NULL. | PASS. Matches the deny-by-default pattern used throughout `rls_fitness_backend.sql`. |
| A6 | service_role bypass | Migration relies on Supabase service_role having `BYPASSRLS`. Comments state this; matches how the rest of the codebase operates. | PASS. Identical assumption to `20260607000000_rls_remaining_gaps`. |
| A7 | Rollback path | No explicit down migration — Prisma migrate is forward-only. Reverting requires a new migration that `DROP COLUMN`s + `DROP POLICY`s. Acceptable for an additive nullable-column change behind a flag. | PASS. Documented in `audit-pr244-round2.md` Appendix A (reverse SQL). |
| A8 | Data risk | Adds nullable columns + a unique index on a nullable column. Existing rows get NULL. NULL ≠ NULL in PG unique indexes, so the unique index allows arbitrarily many NULL rows. No backfill needed, no constraint violation possible on existing data. | PASS. Verified on the test DB after migrate. |
| A9 | Migration order vs `20260520000000_setnull_owner_rels` | Same date prefix, different suffixes (`000000` then `000001`). Prisma applies in lexical filename order — so `setnull_owner_rels` runs first. No dependency between them; independent tables. | PASS. |

## B. Schema (`prisma/schema.prisma`)

| # | Concern | Finding |
|---|---|---|
| B1 | All three new fields nullable | `channel_id String? @unique`, `resource_id String?`, `channel_expires_at DateTime?` — correct. |
| B2 | `@unique` on `channel_id` | Matches the DB unique index name `CalendarConnection_channel_id_key` (verified via `\d`). |
| B3 | No FK / cascade changes | No relations changed; isolated additive change. |
| B4 | `prisma format && validate` clean | PASS (CI Type-check step is green on this branch). |

## C. Module dependency graph

| # | Concern | Finding |
|---|---|---|
| C1 | Any new imports? | None. PR only touches `prisma/schema.prisma`, the migration SQL, and a test file. No `.module.ts` / `.service.ts` source code changed. |
| C2 | Risk of re-introducing a circular dep like #243 | Zero. No NestJS module graph touched. |

## D. Error surfacing

| # | Concern | Finding |
|---|---|---|
| D1 | Raw error codes leaking | N/A — no application code introduced. Future B5/B6 PRs will need to map `P2002` (unique violation on `channel_id`) to a structured error before user-facing handlers — flagged as a forward-looking item but **out of scope for B3**. |

## E. Feature flag gating

| # | Concern | Finding |
|---|---|---|
| E1 | `FEATURE_GOOGLE_CALENDAR_SYNC` default | Confirmed OFF in production env config — no behaviour change at runtime. Migration is a pure schema add. |
| E2 | Code reads of the new columns | None in this PR. Future work (B2/B5/B6) will be gated by the flag. |

## F. Test coverage

| # | Concern | Finding |
|---|---|---|
| F1 | New spec — `test/gcal-b3-channel-tracking.spec.ts` | 10 tests, all pass locally. Cover type-level assertions, create/update/findFirst mocks, and B5 boundary logic. |
| F2 | Coverage of fresh-DB vs migrated-DB migration paths | The spec is at the **Prisma-client / type level** — it does not exercise the SQL migration directly. The migration was instead validated by running `prisma migrate deploy` against a fresh local Postgres 17 instance (see A1). A SQL-level migration test would require a DB-bound test harness which this repo does not yet have for any migration — out of scope. Documented locally; not adding a flaky harness for one migration. |
| F3 | CI Test step | Currently red on this PR — but with the SAME 20 failing suites that are red on `main` (verified by running `npm test` on both branches: identical 68 failures, 20 suites). No new failures introduced by this PR. The 68 pre-existing failures are inherited from main and are out of scope for B3. |

## G. Specific AI-coding failure patterns (the "50 patterns" — relevant ones for this PR)

| # | Pattern | Status |
|---|---|---|
| G1 | Race conditions | N/A — pure DDL migration. |
| G2 | Missing awaits | N/A — no application code added. |
| G3 | Swallowed errors | N/A — migration is one transaction, fails loudly. |
| G4 | Untested fresh-DB path | **Was a real issue (A1). Now fixed and verified via `prisma migrate deploy` on local Postgres 17 from empty.** |
| G5 | Circular module deps (the #243 incident) | None — no module graph changes. |
| G6 | Hidden state in inline UNIQUE constraint name mismatch | **Was a real issue (A2). Now fixed via explicit named CREATE UNIQUE INDEX.** |
| G7 | Forgotten idempotency on policy creation | OK — every `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS`. |
| G8 | Non-idempotent ENABLE/FORCE RLS | Verified safe — re-applying both statements on an already-enabled table is a no-op in PG. |
| G9 | `BEGIN`/`COMMIT` correctness | Single transaction wraps the whole migration. If any step fails, nothing partial commits. |

## H. Findings list & resolutions

1. **A1 — Missing fresh-DB helpers (CRITICAL)**: fixed by self-bootstrapping `app` schema + 3 helper functions. Verified end-to-end against a clean Postgres 17 DB.
2. **A2 — Inline UNIQUE constraint name drift (MEDIUM)**: fixed by replacing with explicit `CREATE UNIQUE INDEX IF NOT EXISTS "CalendarConnection_channel_id_key"`. Verified Prisma-expected index name.
3. **Test step inherits pre-existing main failures (INFO, not a finding against this PR)**: 68 failing tests across 20 suites are identical to what runs on `main` HEAD. Recent merges (#234 hybrid-pricing, #243 prod-down hotfix) shipped with the same red. Out of scope.

## I. Round 1 status

All findings within scope have been resolved and verified. Proceeding to Round 2.
