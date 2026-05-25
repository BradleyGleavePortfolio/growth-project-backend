# Pre-Existing Red Test Suites — Outside PR #267 Scope

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
