AUDIT Claude Opus 5.5 — growth-project-backend#658 @ 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/0 new (prior Cs C-658-3, C-658-4, C-658-5 owner part still open as follow-ups)

Lens: AUD-OPUS-INV3-121 (agent 121). Tier T4 (tenancy, a CI gate file, RLS, PII deletion, package grants). Scope: my lens's prior findings at 08534e17 ([5964473420](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-5964473420)), then every line changed since that head: f97c621a (fix), 4de7a6dc (README), and the main merge fd8a0008. The merge has no conflict hunks (`git show --cc` is empty), and main changed nothing under src/invite-codes, src/invite-grant or the migration. I did not read the Sol lens for this round.

**Checks at head:** every required check is green, including build-and-test, community-live-tests (with coach-code-tools.live and the two new live cases), rls-live-tests, Schema parity, Forward migrations, Reversible migrations, CodeQL, danger, npm audit and rls-floor-guard. `mergeable_state` is behind: main 5da537d6 is 29 commits ahead, and `git merge-tree` against it is clean.

### My prior findings
| Finding | State | Evidence |
|---|---|---|
| B-658-1 team attribution | **Closed** | `create` writes `coach_id` = head and `invited_by_user_id` = sub (`coach-code-tools.service.ts:310-311`). `owns()` / `rowWhere()` / `ledgerWhere()` (`:827-846`) scope list, rotate, revoke and signups to the issuer. A sub-coach has no coach link (`:196-198`, and rotate returns 403 `coach_link_head_coach_only` at `:384-390`). Row rotation keeps the tenant and the issuer (`:464-465`). The attach writes `User.coach_id` = head because `row.coach_id` = head. Failing-before run 37346038154, plus the live case `B-658-1: a team sub-coach code attaches its client to the head coach and head ledger`. |
| C-658-2 erasure manifest | Closed | `account-deletion.manifest.ts:295-297`; erasure-manifest-coverage is green. |
| C-658-5 malformed key / replay during binding | Closed | `:244-253` returns 400 `idempotency_key_invalid`; the binding is written in the INSERT (B-658-6). |
| C-658-3, C-658-4, C-658-5 (owner profile) | Open, follow-up (FREEZE) | unchanged |

### Verified in the delta
- **Coach-link rotate (B-658-7).**
  - An `expected_code` mismatch writes nothing and replays the archived row's `successor_code`, but only for the same coach (`invite-codes.service.ts:683-692`). The expected code of another coach answers 409 and leaks nothing.
  - On an overlapping rotate, the second transaction's archive INSERT of the same code waits on the unique index, gets P2002 and retries. The retry sees the moved link and replays, so there is one successor (live `Promise.all` case).
  - The legacy regenerate (always on) goes through the same transaction with grace 0.
- **Create (B-658-6).** The package is decided before the INSERT. The P2002 winner is read in full, and keys are namespaced `${actor.id}:${key}` under the tenant unique index.
- **Ledger.** One row per NEW attach, inside the attach transaction. Production connects as service_role (BYPASSRLS), so the RLS on the new table cannot block the attach. The live RLS cases cover authenticated, anon and the client.
- **Migration 20270302000000.** It is additive and touches only InviteCode and the new InviteRedemption. Applied production holds 20270311000000_subscription_checkout_terms, which shares no object with it, so the out-of-order apply commutes (verified by reading; the lane has no Postgres).

### B-658-9 — the B-658-1 fix lets a team sub-coach give away the head coach's packages for $0
- **Where:** `src/invite-codes/coach-code-tools.service.ts:291-299`. For a sub-coach, `create` calls `grants.assertBindablePackage(scope.tenantId, input.package_id)`. `scope.tenantId` is the head coach, so a sub-coach can bind any active head-coach package with `grant_mode` `free` or `prepaid`.
- **Effect:**
  - Every signup with that code is attached to the head coach.
  - `grantForAttachedCode` then grants the head's package. It creates a ClientPurchase with `amount_cents: 0`, `source: invite_grant:free` (or prepaid) and `status: active` (`invite-grant.service.ts:406-424`).
- **Why it is new authority:**
  - On main, the only way to bind a package to a code is `InviteGrantService.setBinding`, which refuses a sub-coach: `binding.coach_id` = head is not the caller, so the answer is 404 (`invite-grant.service.ts:321-328`).
  - Active sub-coaches are refused on every billing and financial surface (`src/common/guards/no-active-sub-coach.guard.ts`: "Sub-coaches cannot access billing or financial surfaces.").
  - At 08534e17 a sub-coach could bind only their own packages.
  - The PR's own test asserts the escalation: `test/coach-code-tools.service.spec.ts:606-613` (`package_id: 'pkg-1', // the head coach's package`, created by `sub-1` with `grant_mode: 'free'`).
  - The only gate is that the package belongs to the head coach. A package id is an identifier, not a secret, so it is no access control.
- **Probe:** `test/aud-opus-inv3-121.probe.spec.ts` uses the real CoachCodeToolsService, InviteCodesService and InviteGrantService.
  - **P1** expects a sub-coach create with the head's $500 package to be refused. It FAILS at this head: the create resolves and stores `{coach_id: head-1, invited_by_user_id: sub-1, package_id: <head pkg>, grant_mode: free}`.
  - **P2** passes: legacy `setBinding` refuses the same sub-coach on the same code with `INVITE_CODE_NOT_FOUND`.
  - **P3** passes and shows the cost: the sub-coach's code grants the head package at `amount_cents: 0`, `source: invite_grant:free`, `status: active`.
  - **P4** (B-658-1 replay) passes: a sub-coach cannot see, rotate or revoke the head's own code, and the head sees both codes and the link.
  - Evidence: lane audit/AUD-OPUS-INV3-121/658-1 ([run 37365771761](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365771761)) sat queued for more than 20 minutes in the GitHub Actions runner incident, so under operator item 11 I ran this single spec locally through ops/heavy.sh at 4de7a6dc + probe (13:12 PDT). Result: 1 failed (P1: `Expected: 403, Received: "resolved"`; stored `{"coach_id":"head-1","invited_by_user_id":"sub-1","package_id":"11111111-…","grant_mode":"free"}`), 3 passed. P3 printed `{"status":"created"}` with `amount_cents: 0`, `source: invite_grant:free`, `status: active`. No full suite ran locally. The probe file is kept at `ops/aud-121/AUD-OPUS-INV3-121/aud-opus-inv3-121.probe.spec.ts`; it was not pushed to the PR.
- **Fix rule:**
  - In `create`, when `scope.issuerId` is set and `input.package_id` or `input.grant_mode` is present, refuse before `assertBindablePackage` and write nothing. Answer `403 code_package_head_coach_only` with copy such as "Packages on codes are set by your head coach. Create the code without a package, or ask your head coach to add one."
  - The head coach keeps every binding path (A2 create, legacy setBinding).
  - Row rotation can stay as it is: it copies only a binding that the head set.
  - Tests:
    - Change the B-658-1 unit case, so a sub-coach with a head package gets 403 and no row.
    - Add P1 as the regression.
    - A sub-coach create without a package still lands in the head's tenant.
  - About 10 source lines plus tests. #658 is at 2,960/3,000; if the tests do not fit, shrink a test or move one into the live spec.
- **Operator decision (if a different product rule is wanted):** allowing sub-coaches to hand out the head's packages would be an owner money ruling. Recommended default: refuse, matching NoActiveSubCoachGuard and legacy setBinding.

### Notes for the operator (not blocking)
- Overlap with #657, unchanged: whichever lands second maps `code_revoked` / `code_expired` / `code_exhausted` in ATTACH_TO_COACHLESS.
- After the fix, a main merge is merge-only: the merge-tree is clean.

**Counts:** A0 / B1 (B-658-9) / C0 new. APPROVE once B-658-9 is closed with code, the P1 regression and green checks.

No push to the PR, no merge, dispatch or production action by this lens.
