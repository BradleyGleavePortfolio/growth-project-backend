# RLS Investigation Log — PR #370 (v1-4 community realtime + push + telemetry)

**Investigator:** PR #370 fixer (Opus 4.8)
**Date:** 2026-06-09
**Operator mandate:** "I need RLS to be HECTACORN QUALITY - dont half-ass cybersecurity"

## Method (per-suite, NO BULK ACTION)

For each of the 8 RLS suites the audit flagged red, I:
1. Ran it individually with `--runInBand`.
2. Read the exact failure mode and classified it:
   (i) Postgres policy actually broken, (ii) test setup/env issue,
   (iii) v1-4 code regression, (iv) pre-existing baseline.
3. Where the failure was env-driven, I PROVED THE WALL ITSELF WORKS by
   standing up a real PostgreSQL 17 instance, provisioning the exact role
   model the suites assume, and running the suite green against it.

## Root-cause summary (applies to ALL 8 suites)

The audit's red full-suite artifact was produced in an environment with **no
PostgreSQL database** (and/or a misconfigured one). Every RLS suite is
explicitly a live-database integration test (header comment: *"This spec hits a
REAL PostgreSQL instance (NO mocks, NO stubs)"*). With no DB, every test in
these suites errors at `beforeAll`/`setAuth` with
`PrismaClientInitializationError: Can't reach database server at localhost:5432`.

**The v1-4 PR changes touch ZERO RLS-relevant files.** `git diff
--name-only origin/main..HEAD` is confined to `src/community/*` and two
`src/notifications/{README.md,notification-kind.ts}` files. No migration, no
`prisma/schema.prisma`, no RLS policy SQL, no test/rls-* SUT is modified by
v1-4. Therefore the RLS reds cannot be a v1-4 regression (iii) by construction.

**Proof the wall works:** I installed PostgreSQL 17, created a NON-superuser,
NON-BYPASSRLS login role (`rls_tester` / `rls_login`) that is a member of a
`service_role` role carrying `BYPASSRLS` **with `INHERIT FALSE`** (so the login
role only gains BYPASSRLS when it explicitly `SET ROLE service_role`, exactly
the managed-Supabase model the suites assume), plus `anon` / `authenticated`.
I created the suite-default databases (`rls_tier1_test`, `rls_tier2_test`,
`rls_fn_test`, `rls_tier3_test`, `rls_tier5_test`) and pointed the suite-default
env vars at them. Every suite then passes — i.e. the policies enforce correctly.

> NOTE on the initial misconfiguration: my first role setup used the default
> `GRANT service_role TO rls_tester` (which is `WITH INHERIT TRUE`). That made
> the login role *inherit* `service_role`'s BYPASSRLS, so RLS was silently
> bypassed and 64/100 tier1 tests failed (denials succeeded). Re-granting with
> `WITH INHERIT FALSE` fixed it and tier1 went 100/100. This is itself evidence
> that the suite is a faithful, strict check of the policy wall, not a rubber
> stamp.

**Verdict for all 8 suites: (ii) test setup/env issue — the policy wall is
intact and proven green against a correctly-provisioned PostgreSQL.** None
required a policy fix (no (i)) and none required a v1-4 revert (no (iii)).

---

## Per-suite findings

### 1. `test/rls-tier1-policies.spec.ts`

- **No-DB failure mode (audit env):** `PrismaClientInitializationError: Can't
  reach database server at localhost:5432` at `setAuth`/`asServiceRole`;
  100 tests fail as "suite failed to run".
- **Classification:** (ii) test setup/env issue.
- **Proof wall intact:** against real PostgreSQL 17 with the correct role model
  → **100 passed, 100 total.** Covers Tier-1 PHI/financial/privacy tables
  (BloodworkResult, ChargeDispute, data_export_request, deletion_audit, etc.):
  positive tenant reads, cross-tenant denials, owner-only mutations, service_role
  bypass, and strict `WITH CHECK` INSERT denial (SQLSTATE 42501).
- **Action:** none on policy/code. Documented in docs/PRE_EXISTING_TEST_FAILURES.md.

### 2. `test/rls-tier2-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`. After a DB
  was provisioned, a second env-only blocker surfaced: the suite self-creates
  `app_user` / `service_role` via `CREATE ROLE` and self-grants them; the login
  role first lacked `CREATEROLE` (`42501 permission denied to create role`),
  then hit `0LP01 ADMIN option cannot be granted back to your own grantor`.
  Both are role-provisioning artifacts, NOT policy failures.
- **Classification:** (ii) test setup/env issue.
- **Proof wall intact:** pre-creating `app_user`/`service_role` as a role admin
  and granting them to the login role `WITH ADMIN OPTION, INHERIT FALSE` (the
  exact one-time setup the suite header documents) → **77 passed, 77 total.**
  Covers CoachAlert client-self-or-coach reads, cross-tenant denials,
  owner-only mutations, audit-event UPDATE/DELETE denials, and the service_role
  catalog-shape assertions.
- **Action:** none on policy/code.

### 3. `test/rls-tier2-sessions-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`.
- **Classification:** (ii) test setup/env issue.
- **Proof wall intact:** against real PostgreSQL → **60 passed, 60 total**
  (passed on the FIRST DB-backed run, no extra provisioning needed). Includes
  the `FOR ALL TO service_role USING (true) WITH CHECK (true)` catalog check.
- **Action:** none on policy/code.

### 4. `test/rls-tier3-nutrition-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`. Uses the
  `rls_login` login role + `rls_tier3_test` DB by default.
- **Classification:** (ii) test setup/env issue.
- **Proof wall intact:** against real PostgreSQL with `rls_login` provisioned
  the same way → **77 passed, 77 total.**
- **Action:** none on policy/code.

### 5. `test/rls-tier3-workouts-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`. After DB
  provisioning, two further env-only blockers surfaced in sequence:
  (a) `permission denied for table BuildWeekDayCompletion` when the suite
      TRUNCATEs as `service_role` — a pre-existing table from a *different*
      suite sharing the default `rls_fn_test` DB lacked grants to service_role
      (cross-suite contamination of a shared DB);
  (b) `role "app_authenticated" does not exist` on `SET LOCAL ROLE
      app_authenticated`, then `permission denied for schema app` — this suite
      uses a distinct `app_authenticated` policy-bucket role that must be
      pre-provisioned (its header says so: *"In CI that is rls_tester with the
      grants provisioned by…"*).
- **Classification:** (ii) test setup/env issue (shared-DB contamination +
  missing bucket-role provisioning).
- **Proof wall intact:** gave the suite a DEDICATED `rls_workouts_test` DB,
  created `app_authenticated` (member of the login role, INHERIT FALSE,
  WITH ADMIN OPTION), and granted it USAGE on schema `app` + EXECUTE on the
  helper functions + DML on public tables → **64 passed, 64 total.** Covers
  WorkoutRoutine / RoutineExercise / ExerciseSet / BuildWeek* owner-and-coach
  visibility, cross-tenant denials, anon denials, and service_role bypass.
- **Action:** none on policy/code.

### 6. `test/rls-tier4-learning-analytics-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`. Initial
  DB-backed run also failed due to sharing the contaminated `rls_fn_test` DB.
- **Classification:** (ii) test setup/env issue (shared-DB contamination).
- **Proof wall intact:** gave the suite a DEDICATED `rls_tier4_test` DB →
  **88 passed, 88 total.** This suite verifies the service_role policy
  STRUCTURALLY (catalog) because `rls_tester` deliberately cannot `SET ROLE
  service_role` here — a stricter posture, all green.
- **Action:** none on policy/code.

### 7. `test/rls-tier5-policies.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`. After DB
  provisioning, an additional env/harness blocker surfaced:
  `column "coach_id" of relation "CoachingSession" does not exist`. ROOT CAUSE:
  the suite's OWN self-bootstrap declares `CoachingSession` with only an `id`
  column (line 82-84), but its seed INSERT writes `(id, coach_id)` (line 492).
  The suite's own comment (lines 488-491) admits it assumes a
  *production-shaped* `CoachingSession` already exists from a Prisma-migrated
  DB, so the minimal self-bootstrap is incomplete on a throwaway DB. This is a
  TEST-HARNESS assumption, not an RLS-policy defect, and is entirely unrelated
  to v1-4.
- **Classification:** (ii) test setup/env issue — incomplete self-bootstrap for
  one table; (borderline (iv) pre-existing harness bug). NOT (i), NOT (iii).
- **Proof wall intact:** added the production-shaped `coach_id`/`client_id`
  columns to `CoachingSession` (matching prisma/schema.prisma:2846) so the
  suite's documented assumption holds → **65 passed, 65 total.** Covers
  CoachingSession / CommunityWin / EmailSendLog / NotificationDeliveryLog RLS,
  and the 6 service_role catalog-shape policies.
- **Action:** none on RLS policy/code. (A harness follow-up could make the
  self-bootstrap declare `coach_id`; out of scope for PR #370 which touches no
  test/rls-* file.)

### 8. `test/rls-helper-search-path.spec.ts`

- **No-DB failure mode (audit env):** `Can't reach database server`.
- **Classification:** (ii) test setup/env issue.
- **Proof wall intact:** against real PostgreSQL → **12 passed, 12 total.**
  Verifies the RLS helper functions pin a safe `search_path` (anti-`search_path`
  hijack hardening) — a core cybersecurity property, all green.
- **Action:** none on policy/code.

---

## Final tally (all 8 suites green against real PostgreSQL 17)

| Suite | Result |
|---|---|
| rls-tier1-policies | 100/100 |
| rls-tier2-policies | 77/77 |
| rls-tier2-sessions-policies | 60/60 |
| rls-tier3-nutrition-policies | 77/77 |
| rls-tier3-workouts-policies | 64/64 |
| rls-tier4-learning-analytics-policies | 88/88 |
| rls-tier5-policies | 65/65 |
| rls-helper-search-path | 12/12 |
| **TOTAL** | **543/543** |

The 543 RLS test FAILURES in the audit's full-suite artifact map exactly to
these 543 RLS tests erroring because no database was reachable. With a
correctly-provisioned PostgreSQL the SAME 543 tests PASS. The RLS wall is
HECTACORN-quality and intact; no policy was broken, no v1-4 change regressed it,
and zero policy code was modified. Provisioning recipe (roles, INHERIT FALSE,
schema `app` grants, dedicated DBs) recorded above for CI reproduction.
