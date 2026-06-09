# AUDIT R1 PR #268 REPORT — RLS Helper Lockdown + HIBP

Verdict: **DIRTY**

Security posture: not merge-ready for HECTACORN-quality RLS. The PR improves the helper ACL and SECURITY DEFINER posture, but it still misses the strict pg_temp-last search_path requirement and does not make the live RLS regression suite a CI-enforced gate.

## Findings

| ID | Severity | File:line | Description | Fix recommendation |
|---|---:|---|---|---|
| R1-P1-001 | P1 | `prisma/migrations/20260704000000_rls01_helper_searchpath_hibp/migration.sql:58`, `:87`, `:116`, `:146`, `:200` | All five hardened functions set `search_path = pg_catalog, public, app` and omit `pg_temp` entirely. The audit brief explicitly requires `pg_temp` last or a documented rationale, and calls missing `pg_temp` a HECTACORN-quality failure mode. This is especially dangerous for `public.enforce_subcoach_head_cap()`, whose body uses an unqualified `TeamSubCoachAssignment` relation reference. | Change every hardened function to `SET search_path = pg_catalog, public, app, pg_temp` or provide a rigorous documented rationale plus complete schema qualification for all relation references. Update the spec and tests to require `pg_temp` last. |
| R1-P1-002 | P1 | `.github/workflows/ci.yml:42-43`, `test/rls/helper-functions.spec.ts:28-35`, `:64` | The live RLS helper regression suite is skipped in CI because the workflow runs `npm test` without `TEST_DATABASE_URL` or a provisioned database, while the test file gates all live checks behind `dbAvailable`. That means the positive/negative helper tests, ACL tests, trigger tests, and hostile search_path tests do not run in the default PR gate. | Add a CI job that provisions a Postgres/Supabase-compatible database, applies migrations, exports `TEST_DATABASE_URL`, and fails if the live suite cannot connect. Keep static SQL checks, but do not let them substitute for live RLS behavior tests. |
| R1-P1-003 | P1 | `test/rls/helper-functions.spec.ts:526-568` | Shadowing coverage is too narrow. The suite creates only `rls01_attacker.current_setting(text, boolean)` and exercises only `app.current_user_id()`. It does not perform the required same-named attacker-schema shadow tests per hardened helper, and it does not attempt a temp-relation shadow for the trigger helper. | Add attacker-schema same-name decoys for each targeted helper where feasible, call each hardened helper under `SET search_path = attacker_schema, public, app`, and add a `pg_temp` relation-shadow test for `public.enforce_subcoach_head_cap()`. |
| R1-P1-004 | P1 | `test/rls/helper-functions.spec.ts:435-463`, `:716-718` | Metadata assertions do not check the exact search_path string, order, or `pg_temp` last. The live metadata test only checks that `pg_catalog`, `public`, and `app` appear somewhere, and the static test hard-codes the unsafe string `SET search_path = pg_catalog, public, app`. This would pass the current missing-`pg_temp` defect. | Assert exact `proconfig` value and `pg_get_functiondef()` output for each function, including `search_path=pg_catalog, public, app, pg_temp`, with `pg_temp` last. |
| R1-P2-001 | P2 | `docs/SUPABASE_CONFIG.md:89` | The dashboard doc references migration `prisma/migrations/20260525000000_rls01_helper_searchpath_hibp`, but the PR migration path is `prisma/migrations/20260704000000_rls01_helper_searchpath_hibp`. This is a documentation mismatch. | Correct the migration path in the Supabase configuration doc. |

## What is right

- The migration uses `CREATE OR REPLACE FUNCTION`, not `DROP FUNCTION`, preserving dependent RLS policies and trigger bindings.
- The five target helpers are recreated with `SECURITY DEFINER`.
- Function signatures, return types, and volatility appear preserved for the five target helpers, including explicit `VOLATILE` on the trigger helper.
- `PUBLIC` execute is revoked and the PR documents why `anon` is explicitly revoked instead of granted.
- The HIBP documentation includes the dashboard path, manual smoke test, expected rejection behavior, k-anonymity framing, and a recurring detection/incident runbook.
- The CI floor guard is invoked by a workflow and does not use `|| true` to swallow failures.

## Test coverage assessment

The test file contains useful behavioral coverage for helper return values, trigger cap behavior, ACL checks, and static SQL checks. However, the live coverage is not CI-enforced, shadowing tests are not per-function, `pg_temp`/temp-relation shadowing is absent, and metadata checks do not assert the exact hardened search_path. Under the strict checklist, these are security test gaps, not cosmetic gaps.

## Checklist summary

- Migration SQL: **fails** because `pg_temp` is missing from all five search_path clauses.
- Test suite: **fails** because live tests are skipped by default in CI, per-function shadowing is incomplete, and exact search_path snapshots are absent.
- CI guard: **partial**; floor guard exists, but live helper RLS tests are not backed by a real DB in the workflow.
- HIBP docs: **pass** with one minor path typo outside the HIBP section.
- Spec doc: **partial**; it documents the threat model and rollback, but it encodes the same missing-`pg_temp` search_path pattern.
- Cross-cutting: no source-code paths outside the intended PR surface were found in the PR additions inspected.

## Verdict rationale

This is **DIRTY** because the PR still has P1 security gaps. The missing `pg_temp`-last hardening is a direct violation of the audit brief's strict RLS lockdown requirement, and the CI setup does not prove the live helper behavior before merge.

## Sign-off

Auditor: Dynasia G  
Model: GPT-5.5 R1 Auditor  
Timestamp: 2026-06-09T23:05:26Z
