FIX ROUND 9 (B-TR3-118, agent 118) — growth-project-backend#673 @ 5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d

Builder: Claude Opus 5.5, T4. Base T2 #672 @ `2690c07c` (FIX ROUND 9). Answers [Sol RC 0/1/2](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982336690) at `df76889f`; [Opus APPROVE 0/0/3](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982465887) has no open A/B.

Commits: `2413901f` merges T2 `2690c07c` (merge commit, no conflicts; T3 files unchanged). `5fdb5f5c` is the fix plus tests.

| Finding | Change | Commit | Test (failing-before -> passing-after) |
|---|---|---|---|
| Sol B-673-1: an owed retry DELETEd a subscription that had already billed, when its active webhook was late or missing | `trial-conflict.service.ts` `settle()`: after the claim, it reads Stripe's subscription (`retrieveSubscription`, bounded by the same 20 s deadline) before any cancel. `trialConflictAction()` decides at one synchronous admission point, with no await between the decision and the DELETE. `canceled` / `incomplete_expired` -> settled `cancelled` (`already_cancelled`) with no DELETE. `active` -> `superseded` (`billing_started`, fenced): the paid plan is kept, `alertSuperseded()` sends the billed alert once from its own receipt, and the later active or invoice webhook grants access through the existing superseded path. `trialing` / `past_due` / `unpaid` / `incomplete` / `paused` (nothing billed) -> DELETE only if the lease still covers the cancel deadline and, while trialing, the trial ends more than one lease (60 s) after now. Otherwise it retries (`trial_ending`, `lease_exhausted`). Any other state, or a failed read -> retry, no DELETE (fail closed). The outcome write stays fenced on `lease_token` + `status='owed'`, so a webhook that supersedes or cancels meanwhile wins (`stale`). | `5fdb5f5c` | "B-673-1 (round 9)" in `test/b-trials-3-fix-round.spec.ts`: billed with the webhook missing (no DELETE, superseded, one billed alert, the late event grants access); unknown state (503 read, unrecognised status); Stripe `canceled` (no DELETE) and `past_due` (one DELETE, control); trial ending during the read while the webhook supersedes (no DELETE, `stale`, access kept). Failing-before on `df76889f`: [run 37221109080](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221109080) (12 red: these 4 B-673-1 tests, the C-673-2 test, the 7 B-672-3 tests; the `past_due` control passes before and after). Passing-after: [run 37221153162](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221153162) (this head, 10 suites 183/183 + `tsc --noEmit`). |
| Sol C-673-2 (folded: same lines): the lease came from the sweep's start time | `settle()` uses a fresh elapsed clock for the claim, the lease, the admission check, `settled_at` and the backoff. `sweep()` hands each row `clock()`, not its start time. | `5fdb5f5c` | "C-673-2: a row reached late in a slow sweep holds a fresh lease; a replica stays out" (Sol's eight-row, nine-second model): red before, green after (same runs). |
| B-672-3 tests (T2 code, size cap) | The 7 T2 tests live here. | `5fdb5f5c` | See [#672 FIX ROUND 9](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672). |
| Sol C-673-1 (integration gate) | Unchanged; carried to the #680 composition list. | — | — |

Test infrastructure: the world's `retrieveSubscription` default now returns a trialing subscription 30 days out, so every earlier "still trialing -> cancel once" test keeps its meaning. All of them pass unchanged otherwise.

**Prior probes replayed:** [run 37221217159](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221217159)
- Sol `673-conflict-probe.spec.ts` (byte-identical to AUD-SOL-T23-118's file):
  - B-673-1 paid-retry probe: **pass** (the real StripeConnectApiService over intercepted fetch makes a GET only, then superseded).
  - Late-clock probe: **fails as written**. Its Stripe stub has no `retrieveSubscription`, and the fix reads Stripe first and fails closed, so no cancel starts and the test times out. Replayed with only a read stub added (`zz-sol-673-probe-replay.spec.ts`, the subscription still trialing): **pass** (`busy`, one cancel).
- Sol `672-notice-probe.spec.ts` on this head: 17/17 pass.
- Opus `audit-opus-t23-118-673.spec.ts`:
  - Controls pass: C-671-4 x2, and B-672-3 composed (shortened trial: retired, reopened and sent once).
  - Opus C-673-2 (older retried event) and both C-673-3 probes stay red (follow-ups; C-673-3 is on the #680 integration list).
- Sol runs [37218265800](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218265800) and [37218424769](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218424769) and Opus run [37219356220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220) are covered by the files above.

**Money self-check**
- Webhook order and redelivery: an active event before the retry leaves the row superseded and `settle()` returns `not_owed`. One during the retry wins the fenced write (`stale`). One after the worker superseded grants access (existing superseded branch). A redelivered `customer.subscription.deleted` moves an owed row to `cancelled` (unchanged). Still open: Opus C-673-2 (an older retried event rewrites `trial_ends_at`, follow-up).
- Concurrency: one compare-and-set lease per conflict, taken on a fresh clock. A replica stays `busy` for the whole bounded read + cancel (60 s lease, 2 x 20 s deadlines, admission refuses a cancel without room). No DB transaction is held across Stripe HTTP; each row is locked alone.
- Terminal states:
  - canceled / incomplete_expired at Stripe -> `cancelled` with no DELETE.
  - 404 / resource_missing on read or cancel -> `cancelled`.
  - billed -> `superseded`, the paid plan is kept, and support is alerted to offer a refund (refund policy unchanged).
  - Deleted account: a subscription that Stripe reports canceled or missing settles as `cancelled` with no DELETE; nothing else changed.
- List pagination and completeness: no Stripe list calls. The sweep batch (50, ordered by `next_attempt_at`) is unchanged. An unknown read fails closed.
- Currency: the worker handles no amounts.
- Copy truth: no client copy changes in T3. The billed alert and log lines carry ids and closed codes only (`billing_started`, `trial_ending`, `lease_exhausted`, `state_unknown`, `http_<n>`, error class).

**Size:** 11 files, +2,879 / -8 = **2,887** lines against T2 (was 2,627). 1,500-3,000: the operator posts the SIZE ASSESSMENT.

**Follow-ups (C), not changed under FREEZE:**
- Opus C-673-2: `checkout-webhook-handler.service.ts:930-934`. An older retried subscription event rewrites an extended `trial_ends_at` and records a notice for the old date. Fix rule: write `trial_ends_at` only from the newest subscription state (skip an event older than the last one applied, or re-read). The same rule belongs with #680's unified webhook writes (Opus R-1).
- Opus C-673-1: `billing.service.ts:674-686`. Post-commit trial work is awaited inside the webhook request. Fix rule: start both jobs without awaiting them (`void ... .catch(log)`); the sweeps retry.
- C-673-3 (Opus, outside the diff, binding ruling): coach MRR and churn count never-billed trials. It goes on the #680 integration list.
- Policy note (not a finding): `past_due` / `unpaid` is treated as nothing billed, as the webhook handler already does. A subscription that billed once and then fell past_due would be cancelled only if every read missed its `active` period (retries run at least hourly).

CI at this exact head: all 10 reported checks pass (build-and-test, Schema parity, community/mwb-3/rls live tests, rls-floor-guard, npm audit, size-label, test/comment deploy-readiness); deploy-readiness-gate skipped as on every prior round.

READY FOR AUDIT
