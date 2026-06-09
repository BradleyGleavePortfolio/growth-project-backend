# Pre-Existing Red Test Suites — Outside PR #267 Scope

> **R10 RETIRED — 2026-05-26**
>
> R10 ("grandfathered failing tests on main are allowed to remain red
while a domain ticket exists") is **retired**. Investigation showed the
3 remaining grandfathered failures on `main` were all stale test-helper
bugs introduced when source code was hardened (audit IDs A1-C5-P1-1,
A1-C5-P1-3, A1-C5-P1-4). Source was correct in every case; the tests
needed updating. All 3 were fixed in branch
`chore/r10-cleanup-fix-stale-tests`:
>
> - `test/account-deletion.service.spec.ts` — `??` operator silently
>   substituted default Date for explicit `null` overrides (helper
>   bug, A1-C5-P1-4)
> - `test/email.service.spec.ts` — test expected graceful failed-return
>   but source was hardened to throw `BadRequestException`
>   (post-A1-C5-P1-1)
> - `test/recent-auth.guard.spec.ts` — JS default parameter substituted
>   valid secret for explicit `undefined` (helper bug,
>   A1-C5-P1-3 audit class)
>
> **New CLEAN bar (replaces R10 grandfathering):**
> CI green on main + 0 P0 + 0 P1 + 0 P2.
>
> No new grandfathered failures will be accepted. PRs introducing
failing tests on main must fix them in the same PR or open a P0/P1/P2
bug. This entry is left in place so old PRs and audits that reference
R10 remain traceable; the rationale below is historical only.

Audit finding reference: **P2-9** (FINDINGS_audit4_pr267.md).

This document enumerates the Jest suites that were already failing on
`origin/main` prior to PR #267 (`feat/tgp-storefront-backend`). Each entry
explains why the failure is **not** introduced by this PR, links the root
cause to the responsible domain, and names the owner/follow-up ticket that
should resolve it in a dedicated refactor PR.

The audit ruled (FINDINGS_audit3_pr267.md, line 12) that these suites are
red on committed HEAD before any storefront/share-link/invite-landing/
billing/connect work. The R41 self-diff for this PR confirms no SUT files
for the listed suites are modified by PR #267, so the failures cannot be
attributed to the storefront backend work.

## CI policy for this PR

- The **PR-scoped suites** (`storefront`, `billing`, `checkout`, `connect`,
  `invite-codes`, `coach-deletion`, `env-validation`, `roles-enforced` for
  `ShareLinkController`) MUST be green. They are gated by the targeted
  Jest command in `FIX_BRIEF_round4_pr267.md`.
- The **pre-existing red suites** listed below are quarantined for this PR
  and tracked separately. Merging PR #267 does not regress them; the
  failing assertions continue to fail with the same root causes on
  `origin/main`.

## Pre-existing red suites

### 1. `test/messages-safety.spec.ts` (Messaging safety)

- **Pre-existing reason (NOT this PR):** Asserts pre-existing Messaging
  domain invariants (sender/recipient symmetry, attachment safety). The
  Messaging service (`src/messaging/*`) is not touched by PR #267.
- **Domain owner:** Messaging.
- **Follow-up:** Open a Messaging-domain ticket to either fix the suite or
  align it with the current Messaging schema. Out of scope for storefront.

### 2. `test/v1-coach.spec.ts` (V1 Coach legacy contract)

- **Pre-existing reason (NOT this PR):** Validates the legacy V1 coach
  surface (`src/coach/*`, `src/v1/*`). PR #267 introduces no changes to
  the V1 coach controllers, services, or fixtures.
- **Domain owner:** Coach platform.
- **Follow-up:** Coach platform ticket — re-baseline the V1 contract or
  migrate the suite to the V2 coach surface.

### 3. `test/roles-enforced.spec.ts` (route-metadata contract)

- **Pre-existing reason (NOT this PR):** The suite enumerates routes
  missing `@Roles(...)` or `@Public()` metadata across the entire repo.
  PR #267's contribution to this suite — `ShareLinkController.mintShareLink`
  — was fixed in commit `f049feb1` (Round 3). The remaining failures are
  on legacy controllers outside PR scope (`src/coach/*`, `src/admin/*`,
  `src/ai/*`).
- **Domain owner:** Platform / security.
- **Follow-up:** Sweep-PR to add `@Roles(...)` annotations across the
  remaining controllers. Tracking ticket should reference R-route-metadata.

### 4. `test/cross-tenant-isolation.spec.ts` (WeightService, FastingService)

- **Pre-existing reason (NOT this PR):** Cross-tenant assertions against
  `WeightService` and `FastingService`. Neither service is touched by
  PR #267 (storefront flows operate on `GuestCheckout`, `ClientPurchase`,
  `Package`, `ConnectAccount`, `ShareLink` only).
- **Domain owner:** Health/tracking domain.
- **Follow-up:** Health-domain ticket to apply the tenant scoping pattern
  used by the storefront services to Weight/Fasting query paths.

### 5. `test/check-ins.spec.ts` (Check-ins legacy)

- **Pre-existing reason (NOT this PR):** Check-ins domain (`src/check-ins/*`,
  `src/checkins/*`) — not modified by PR #267.
- **Domain owner:** Check-ins / coach experience.
- **Follow-up:** Re-baseline the check-ins fixtures after the most recent
  schema migration; tracking ticket lives in the check-ins backlog.

## Verification

- Run the PR-scoped targeted gate:
  ```bash
  npx jest --runInBand --detectOpenHandles \
    --testPathPattern='(storefront|billing|checkout|connect|invite-codes|coach-deletion)'
  ```
  All suites in this set MUST be green for PR #267 to merge.
- Run `git diff origin/main...HEAD --stat` to confirm none of the SUT
  files for the listed suites are modified.

## Re-evaluation criteria

Each pre-existing red suite is allowed to remain red ONLY while:

1. PR #267 does not modify the suite's SUT (verified via R41 self-diff).
2. The suite's failure pre-dates this branch on `origin/main`.
3. A domain ticket exists for it (or is opened concurrent with this PR).

If any of those conditions changes — for example, a future fix round
edits `src/messaging/*` — the corresponding suite MUST be re-evaluated
and either green or explicitly re-quarantined in this document with a
new justification.

---

# RLS integration suites — DB-dependent, env-driven reds (PR #370)

**Added:** 2026-06-09 by the PR #370 fixer (v1-4 community realtime + push +
telemetry). **Not a grandfathered policy bug — a live-DB environment
requirement, with the policy wall PROVEN green.**

## Suites

- `test/rls-tier1-policies.spec.ts`
- `test/rls-tier2-policies.spec.ts`
- `test/rls-tier2-sessions-policies.spec.ts`
- `test/rls-tier3-nutrition-policies.spec.ts`
- `test/rls-tier3-workouts-policies.spec.ts`
- `test/rls-tier4-learning-analytics-policies.spec.ts`
- `test/rls-tier5-policies.spec.ts`
- `test/rls-helper-search-path.spec.ts`

## Exact failure (no database present)

Each suite is explicitly a live-PostgreSQL integration test ("This spec hits a
REAL PostgreSQL instance (NO mocks, NO stubs)"). In an environment with no
reachable database, every test errors at `beforeAll` / `setAuth` /
`asServiceRole` with:

```
PrismaClientInitializationError: Can't reach database server at `localhost:5432`
```

This accounts for all 543 "failed" RLS tests in the full-suite artifact: they
are erroring to connect, not asserting a policy hole.

## Proof the policy wall is intact (not (i), not (iii))

The PR #370 fixer stood up a real PostgreSQL 17, provisioned the role model the
suites assume (a NON-superuser, NON-BYPASSRLS login role member of a BYPASSRLS
`service_role` **with INHERIT FALSE**, plus `app_user` / `app_authenticated` /
`authenticated` / `anon` policy-bucket roles, granted WITH ADMIN OPTION by a
role admin), created the suite-default databases, and ran each suite
individually. Result:

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
| **TOTAL** | **543/543 PASS** |

Full per-suite investigation, exact errors, and the provisioning recipe are in
`RLS_INVESTIGATION_LOG.md` at repo root.

## Why this is NOT a v1-4 regression

`git diff --name-only origin/main..HEAD` for PR #370 is confined to
`src/community/*` and two `src/notifications/{README.md,notification-kind.ts}`
files. No migration, no `prisma/schema.prisma`, no RLS policy SQL, and no
`test/rls-*` SUT is modified. The RLS reds therefore cannot be attributed to
v1-4 (R41 self-diff posture). The schema SHA is unchanged:
`f4a70e7064d874426b1ca9c57e3f7addc36d72ca33b2076f70ca513285cb416a`.

## CI requirement to turn these green

Provision a PostgreSQL with the role model above and set the per-suite DB env
vars (`RLS_TIER1_TEST_DATABASE_URL`, `RLS_TIER2_TEST_DATABASE_URL`,
`RLS_FN_TEST_DATABASE_URL`, `RLS_TIER3_TEST_DATABASE_URL`,
`RLS_TIER4_TEST_DATABASE_URL`, `RLS_TIER5_TEST_DATABASE_URL`). One harness
follow-up (out of PR #370 scope): make `rls-tier5-policies` self-bootstrap a
`coach_id` column on `CoachingSession` rather than assuming a production-shaped
table.

## R66 full-suite note: `test/openapi-spec.spec.ts` (DB-bootstrap dependency)

SKIP-BECAUSE / RED-BECAUSE: In a bare sandbox where the default
`DATABASE_URL` points at an empty `test` database (0 tables, no migrations
applied), `test/openapi-spec.spec.ts` fails in its `beforeAll` hook. The hook
boots the full `AppModule` (`app.init()`), which eagerly issues
`this.prisma.wearableMetricDef.findMany()` during startup; against an
unmigrated DB this raises `PrismaClientKnownRequestError` and every assertion
in the suite errors out as a consequence.

Classification: category (ii) test-environment / no-migrated-DB — NOT a
broken contract (i) and NOT a v1-4 regression (iii). Evidence:
- The file is byte-identical to `origin/main` (last touched by unrelated
  commit `91bb892`, well before PR #370); it is absent from
  `git diff --name-only origin/main..HEAD`.
- PR #370's commit (`db87c07`) modifies none of `src/app.module.ts`,
  `src/common/openapi*`, `prisma/*`, or any wearables code path.
- The error is a Prisma data-layer invocation failure, not an OpenAPI
  contract assertion failure.

CI requirement to turn green: run R66 against a migrated database (the CI lane
applies Prisma migrations before the suite). The 251 non-RLS suites that do not
require a migrated production schema all pass in the bare sandbox.
