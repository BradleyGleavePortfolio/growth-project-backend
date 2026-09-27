# S12 pilot runbook (S12-B4)

Grant: `execution/42d8c5b5/s12b4/GRANT.md`. Rules: `execution/42d8c5b5/WORKER_RULES.md`. Scope:
`execution/fa72efb2/s12/S12_PILOT_READINESS.md` §2b row S12-B4 and §3 (esp. §3.4 pilot report).

This runbook is docs + read-only SQL. **It never connects to production and never runs against
production.** Every query in `docs/pilot/sql/` is validated only against a throwaway local
Postgres, migrated to this slice's base, with synthetic rows (§4). Running anything here against a
real database — including the pilot's own — is an operator action outside this grant, done by
Bradley or under his explicit direction, never by a builder.

## 1. Who this is for

The person who watches one pilot run (S12a, `S12_PILOT_READINESS.md` §1) and needs to answer,
truthfully and without guessing: what happened, what is still unknown, and whether anything
crossed a line that stops the pilot. That person reads the §3.4 sources through the queries in
§3 below and reports using the template in §5. Nothing here decides _whether_ to run a pilot —
that is the owner decision set in `S12_PILOT_READINESS.md` §4.

## 2. Before the coach starts (flag on / allowlist procedure)

The importer flags are **global**; only the S12-B1 allowlist scopes them to one coach
(`S12_PILOT_READINESS.md` §0.3, §3.1). Follow this order every time:

1. Confirm the deploy that carries S12-B1 and S12-B2 has fully rolled out (owner item 10,
   `S12_PILOT_READINESS.md` §4).
2. Get the pilot coach's `User.id` (UUID) from the database — never from memory or a support
   ticket. `sql/00_find_coach.sql` does this by email, read-only.
3. Set exactly one id: `fly secrets set FEATURE_SCOUT_PILOT_COACH_IDS=<uuid>` on the target app.
   This restarts the machines once (`fly-feature-flags-set.yml`). Do **not** add a second id
   during S12a (§0.3: one coach only).
4. Set the three importer flags to `'true'` in that order only after step 3 is confirmed (owner
   item 6, `S12_PILOT_READINESS.md` §4): `FEATURE_EXTENSION_PAIRING`, `FEATURE_SCOUT_INGEST`,
   `FEATURE_SCOUT_RECONSTRUCT`. `FEATURE_PERSON_LINK` stays **absent** (S12b only).
5. Every other coach is dark: off-list, empty-list, absent-list and malformed-list all fail
   **closed** — nobody is admitted, even with every flag on
   (`src/common/feature-flag/pilot-coach-allowlist.ts`). There is no allow-all spelling.
6. Verify with a real request from the pilot coach's token before telling them to proceed; do not
   trust the secret-set output alone.

Gated surface (identical set for the flag middleware and the allowlist guard — one registry,
`src/common/feature-flag/feature-flag-not-found.middleware.ts` `FEATURE_GATED_ROUTES`):

| pattern                                                                                                | flag                                                 |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `/api/scout` (all routes, incl. `/api/scout/runs/*`, `/api/scout/ingest*`, `/api/scout/import/status`) | `FEATURE_SCOUT_INGEST`                               |
| `/api/scout/reconstruct` (layered under the row above — needs **both** flags)                          | `FEATURE_SCOUT_INGEST` + `FEATURE_SCOUT_RECONSTRUCT` |
| `/api/extension/pair/*`                                                                                | `FEATURE_EXTENSION_PAIRING`                          |

`POST /api/extension/pair/redeem` is `@Public()` (no JWT), but it only accepts a code minted by
the gated `init` route, so it carries no separate exposure. An off-list, dark, or malformed-list
caller gets the exact same uniform 404 as a route that does not exist (R-DARK-1) — this is
intentional; it must never be "fixed" into a 401/403 that would leak which routes exist.

## 3. Flag off / kill switches (fastest first, `S12_PILOT_READINESS.md` §3.2)

1. **One run only:** the coach calls `POST /api/scout/runs/cancel` from the phone. Fences that run
   `cancelled` exactly once.
2. **The whole surface:** set any of the three importer flags to anything other than the literal
   string `'true'`. Every gated route (including `redeem`, because the flag is checked before the
   `@Public()` exemption) answers the same uniform 404. `fly secrets set` restarts the machines
   once. **A run that was open when the flag went dark stays open in the database** — nothing
   fences it just because the surface went dark.
3. **This pilot coach only:** remove their id from `FEATURE_SCOUT_PILOT_COACH_IDS` (leave the
   flags on for a later pilot coach, or turn them off too per #2).
4. **Client-facing (S12b only):** set `FEATURE_PERSON_LINK` off. Out of scope for S12a, which never
   turns it on.

### C4 — an open run outlives its coach leaving the allowlist

(S12-B1 review finding, `execution/42d8c5b5/s12b1/REVIEW_B.md` "C4"). Removing a coach's id from
the allowlist (kill switch #3) does **not** fence any run that coach has open. The run's row is
untouched — it just becomes unreachable to that coach (and everyone else) because every route
under `/api/scout` and `/api/extension/pair` now answers the off-list 404 for them. The run stays
open, silently, until:

- the coach is **re-listed** and reads `GET /api/scout/import/status` again, at which point the
  **lazy deadline** check fences it `timed_out` if `deadline_at` has passed (`S12_PILOT_READINESS.md`
  §3.2 item 2; this is the same lazy-fence mechanism as a global flag-off, not a new one); or
- nobody ever re-lists them, in which case the row simply stays `in_progress` forever with no
  fence and no terminal. `sql/06_open_runs.sql` finds these.

This is not a bug to patch under this grant (T1/T2, docs + SQL only) — it is a real operational
property the runbook must record so nobody reports a coach as "removed cleanly" while a run of
theirs is still open. If a pilot coach is removed mid-run, note the run's `intent_id` and either
re-list them briefly to let it fence, or record it as **open, unresolved, not cancelled** in the
pilot report (§3.6 "unknown does NOT silently become zero" applies to _state_, not only counts:
an open-but-abandoned run is reported as open, never folded into `cancelled` or `timed_out` before
the deadline check has actually run).

## 4. Validating these queries (what this grant requires before trusting any of them)

Every query in `sql/` was run once, under the canonical heavy-command lock
(`/home/user/workspace/execution/test-validation.lock`), against a **throwaway local Postgres**
(embedded PG 17.6 from this exec's runtime, never a shared or persistent instance) migrated with
`prisma migrate deploy` at this slice's base commit, then seeded with hand-written synthetic rows
(`sql/seed_synthetic.sql` — fake UUIDs, no real coach, no real source data). Outputs are recorded
in `sql/VALIDATION.md` alongside the exact commands and their exit codes. **No query here has ever
been run against any hosted database, staging or production.** Re-running the validation after any
schema change is required before trusting the pack again.

## 5. Producing the §3.4 pilot report

Run the queries in `sql/` in order (01 → 05) for the one `(coach_id, intent_id)` pair being
reported on, substituting the coach's allow-listed UUID and the run's intent id everywhere a
query takes them as parameters. Then fill in this template. Every blank must be filled from a
query result — never from memory, the extension's push copy, or "it looked done."

```
## Pilot report — <intent_id> — <coach_id> — generated <UTC timestamp>

Run identity        : mode=<legacy|server> phase=<phase|"—"> epoch=<n>
Terminal             : <terminal_status | "not yet terminal"> reason_code=<code | "—">
Accepted at / deadline: <accepted_start_at | "unknown"> / <deadline_at | "unknown">
Last observed at     : <last_observed_at | "unknown">
Extension claim (self-reported, NOT the verdict): <terminal_status from ScoutImportCompletion | "none recorded">

Declaration          : source_platform=<platform | "none declared"> declared_at=<ts | "—">
Observations received: <n rows, by family — "none" if zero, never blank>

Settled basis (families[]):
  <family>: known=<true|false> completeness_basis=<basis_kind|"none"> observed_unique=<n|"unknown">
  ... one line per family; a family with known=false or observed_unique NULL is written
      "unknown (<reason>)" — never 0, never "none", never "complete".

Native provenance (incl. S8-D1 person handoff):
  person: created=<n> already_present=<n> unresolved=<n, by reason>
  <other native_kind rows...>
  "not imported: no destination" families (staged but no native writer): <list | "none">

Roster (Person rows this run produced, invite-pending): <n> — "not known yet" if the reconstruct
  read was never made, never "0 people".

Tenant isolation check: <PASS — zero rows/reads for any other coach_id | list any exception>

Deviations from an honest partial (if any): <describe, or "none observed">
```

**Never**: report a null/absent count as `0`; report `timed_out`/`cancelled` as "failed"; round a
`partial` up to `complete`; treat the `import.complete` push or the extension's own claim as the
server verdict (`S12_PILOT_READINESS.md` §3.4, §3.6). A missing declaration, observation, or
settled-basis row is "not known", never "no".

## 6. Stop-immediately triggers (§3.5 of `S12_PILOT_READINESS.md`)

If any query surfaces one of these, stop and report class A or B immediately, flag off, preserve
everything — do not try to "fix" it by re-running or reinterpreting the row:

- any row for a `coach_id` other than the pilot coach appearing in a query scoped to the pilot
  coach (cross-tenant leak);
- a `terminal_status = 'complete'` on a row whose `source_platform` is a real platform (only
  synthetic/test platforms may legitimately reach `complete` at this base, and S12-B2 should have
  refused those outside development/test already — a real-platform `complete` here means that
  refusal did not hold);
- a settled-basis family reported with a count where the underlying coverage fact says
  `known: false` (a 0-for-unknown substitution);
- two `ImportNativeProvenance` "created" rows for the same `(coach_id, source_namespace,
entity_type, source_id)` after a replay (duplicate native identity);
- any row in `sql/07_client_directed_sends.sql` for this run (client-directed message sent from
  S12a, which must send none).

## 7. What this pack intentionally does not do

- It does not run anything. Every file under `sql/` is read-only `SELECT` (enforced by review —
  no `INSERT`/`UPDATE`/`DELETE`/`COPY`/DDL appears anywhere in this directory), parameterised by
  `coach_id`/`intent_id`, meant to be run by a human with `psql` against whichever database they
  have already decided to point at. This runbook and this builder never make that connection.
- It does not decide the platform, the account, consent, retention, deploy target, or any other
  owner-reserved question in `S12_PILOT_READINESS.md` §2c / §4.
- It does not touch the RLS check (S12-B5, a different, separately-scoped read-only script) or the
  workflow change that would push `FEATURE_SCOUT_PILOT_COACH_IDS` through CI (S12-B6).
