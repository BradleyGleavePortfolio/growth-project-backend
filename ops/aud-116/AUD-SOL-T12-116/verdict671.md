AUDIT GPT-6.1 Sol — growth-project-backend#671 @ a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/0

Independent full-depth T4 audit of T1 only, including its entire 14-file / 1,727-line diff, populated-reader compatibility, both migration/up/down pairs, RLS, deletion coverage, one-trial transitions, capability, copy/view and test boundaries. [Candidate and size assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5975772646)

### Prior findings and evidence applicability

No approved-code audit evidence is reused: this lens never APPROVED original #656; the complete T1 diff received fresh review. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/656#issuecomment-5972091723)

T1's part of **B-656-7 closes**: `trialErrorClass`, `trialPushCode` and `trialHttpCode` use closed membership/range mappings rather than arbitrary names/codes, and the exact inherited helpers passed independent canary controls at T2. [Diagnostic helpers](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/src%2Fpackages%2Ftrials%2Ftrial-diagnostics.ts) [Independent controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173068713)

The separate nullable `billed_alerted_at` receipt required by **B-656-6** is present in schema and migration; the conflict worker's alert-transition closure belongs to T3 and is not decided by this T1 verdict. [Schema](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/prisma%2Fschema.prisma) [Truth migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/prisma%2Fmigrations%2F20270313000000_package_trial_truth%2Fmigration.sql)

Original round-5 behavioral evidence was checked, not accepted as an approval: before 8 failed / 31 passed, after 96/96; T1 files are byte-identical to the fixed original except its explicitly deferred PackagesModule assertion/import, which T2 restores. [Failing before](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144505127) [Passing after](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144528941) [Documented piece boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671)

### B-671-1 — concurrent starts of the same unreserved purchase are misclassified as a second trial

**File:line:** `src/packages/trials/trial-usage.service.ts:240–242,264–310`, specifically the post-insert collision branch at `283–310`. [Affected transition](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/src%2Fpackages%2Ftrials%2Ftrial-usage.service.ts)

**Executed counterexample:** two concurrent `markStarted()` calls for the same purchase, with no existing reservation, both read no owner; one inserts its started row, the other's `skipDuplicates` insert loses, then the latter finds that same purchase's started row and still returns `conflict`. [Exact-head service probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173069078)

The observed result is `['owned','conflict']`, not `['owned','owned']`, with exactly one started ledger row for the correct purchase; all 20 candidate controls pass. [Executed failure and controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173069078)

This contradicts the method's explicit support for subscriptions minted without reservations and its promise to report conflict only when **another purchase** owns the trial; once wired, the false conflict is a denial/cancellation signal for the legitimate subscription, not harmless duplicate suppression. [Method and outcome contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/src%2Fpackages%2Ftrials%2Ftrial-usage.service.ts) [Original lifecycle consequence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/656#issuecomment-5965268813)

**Minimal fix rule:** after a skipped insert or lost takeover, reconcile the holder against the requested purchase before declaring a cross-purchase conflict; same-purchase started ownership must return `owned`, and same-purchase reserved/released transitions must use the existing fenced transition rules.

**Verification:** retain this failing probe, add duplicate starts around insert/takeover plus different-purchase loser controls, and exercise separate database transactions so the unique-insert wait followed by a fresh holder read is covered.

### Remaining review and CI boundaries

The migrations are additive/defaulted/nullable, the three new direct user-ID fields have deletion-manifest entries, the usage key guards `(client,coach)` plus unique purchase, and new tables enable/force RLS with restrictive anonymous denial; down files expressly disclose lost ledger data rather than claiming data restoration. [Trial migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/prisma%2Fmigrations%2F20270228000000_package_free_trials%2Fmigration.sql) [Trial down](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/prisma%2Fmigrations%2F20270228000000_package_free_trials%2Fdown.sql) [Truth down](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/prisma%2Fmigrations%2F20270313000000_package_trial_truth%2Fdown.sql) [Deletion manifest](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a6a2b589c7b641bb3d2e53f4b7445de0d52ddda4/src%2Faccount-deletion%2Faccount-deletion.manifest.ts)

All 11 required candidate-head checks are SUCCESS, including build/test and live RLS; migration forward-application/reversibility and parity checks are also SUCCESS, while the deliberate independent negative probe is **1 failed / 20 passed**. [Candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148198296) [Migration checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148198288) [Schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148198283) [Negative probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173069078)

T1 is inert until later wiring, not proof of live free-trial checkout; land the trials stack as one, deploy only after T3, and preserve the composed recurring/trial acceptance gate carried as C-656-1. [Operator landing rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/671#issuecomment-5975772646) [Integration carry](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/656#issuecomment-5972091723)

Only test-only audit branches were pushed; no candidate edit, merge, production/provider action or local heavy command.
