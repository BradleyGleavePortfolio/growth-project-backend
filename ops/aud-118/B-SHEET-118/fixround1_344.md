FIX ROUND 1 (restack) (B-SHEET-118, agent 118) — growth-project-mobile#344 @ e7fcc5d2504e8c3948494ee847e16ff4937b78c3

Tier T4 (payments). Restack onto #343 FIX ROUND 1 (`fd739d58`, issuecomment-5982491752): merge commit, no conflicts, plus ONE test-only commit, so this round is not strictly merge-only.

- Merge `d9e7da55`: #343 head `fd739d58` merged into this branch (no conflicts, no S3 source change).
- Test-only commit `e7fcc5d2`: `PackageSelectionSheet.recur3.test.tsx` (TRIAL_PLAN) and `PackageSelectionSheet.subscription.test.tsx` (setup-mode trial) pinned `trial_ends_at` to the fixed instant 2026-10-10T12:00Z. #343 B-343-4 now reviews a resumed trial whose pinned first-charge date differs from the date the sheet shows (today + 7), so those fixtures matched only on one calendar day and then cascaded into later cases through unconsumed mocks. The fixtures now follow today + 7, and the subscription case asserts the formatted date of that instant. No source file of this PR changed.

Size: +1,839 / -247 = 2,086 changed lines against #343 (tests included), inside the 1,500-3,000 band. Stated per the size rule.

| Finding | Change | Commit | Test |
|---|---|---|---|
| Restack onto #343 FIX ROUND 1 | merge | d9e7da55 | all S3 suites |
| S3 trial fixtures fixed to one calendar day (follows B-343-4) | today + 7 | e7fcc5d2 | recur3, subscription (local: 4 suites, 61 of 61 pass; before the fixture fix 4 failed) |

Required check at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219688466 pass.

## Prior probes replayed
No lens has audited this piece yet (only the operator READY), so there is no #344 probe of its own. The #343 probes of both lenses (Opus probe343, Sol purchaseBoundary, paymentTheme, recur3 B-343-4) and these S3 suites were run against the S2 head with `tsc --noEmit`: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219714087 (120 of 120 pass); the same probe files pass on this head locally (30 of 30).

## Money list self-check
- Webhook order and redelivery: unchanged on this piece; the screens show success only after the backend read.
- Concurrency (two workers, lock order): unchanged; per-package keys and the account fence come from #343.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged on this piece; #343 handles refunded / in review, ended plans and account changes.
- List pagination and completeness: unchanged; YourPlansPanel against today's production backend (no GET /v1/checkout/subscriptions) stays a follow-up (see report).
- Currency: unchanged; backend minor units only.
- Copy truth: the fixtures now prove the trial path end to end with a matching pinned date; the moved-date path is covered by the B-343-4 probe.

Open gates (not changed here): C-334-2 (native UpdateCard in ClientPackagesScreen) stays an operator / P3 decision. Operator decision: accept the test-only fixture commit as part of the restack (recommended), details in ops/reports/B-SHEET-118.md.

READY FOR AUDIT
