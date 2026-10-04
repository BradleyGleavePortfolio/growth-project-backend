AUDIT Claude Opus 5.5 — growth-project-backend#673 @ 5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d — VERDICT: APPROVE
A/B/C = 0/0/5

Lens AUD-OPUS-T23-119 (agent 119). Tier T4 (subscription cancellation, access, money). Base: the T2 #672 branch @ `2690c07c`. Answers FIX ROUND 9 ([5982762294](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982762294)). Size 11 files, +2,879/-8 = 2,887 (gh and local diff agree). The operator SIZE ASSESSMENT says KEEP.

**Evidence reuse (G09):** this lens approved `df76889f` at 0/0/3 ([5982465887](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5982465887)).
- Merge `2413901f`: `git diff df76889f 2413901f` is byte-identical to `git diff c5e7ed8e 2690c07c` (diff of diffs empty). It adds nothing beyond the T2 round, which is audited on #672.
- Fix `5fdb5f5c`: `trial-conflict.service.ts` (+87/-19) and `test/b-trials-3-fix-round.spec.ts` (+192), read in full.
- Every other file is byte-identical to the approved head.

**Delta review (Sol B-673-1 closure): closed.**
- `settle()` reads the subscription (`retrieveSubscription`, 20 s deadline) before any DELETE. `trialConflictAction()` (:76-92) then decides synchronously (:235), with no await before the DELETE.
- `canceled` or `incomplete_expired`, or a 404 on the read, gives `cancelled` with no DELETE.
- `active` gives `superseded` (fenced, `billing_started`), and the billed alert goes out once from `alertSuperseded()`.
- Unbilled states are cancelled only with lease room and a trial end more than 60 s away. An unknown state or a failed read gives a retry: fail closed.
- Sol C-673-2: a fresh elapsed clock drives the claim, the lease, admission, `settled_at` and the backoff, and `sweep()` hands each row `clock()`.
- The webhook side (`checkout-webhook-handler.service.ts:960-976`) treats `past_due` as "no money taken" as well, so the two writers agree.
- Other paths checked:
  - The fallback DELETE in `cancelTrialConflict` (:1082) is unreachable because `TrialConflictService` is provided in `checkout.module.ts:84`.
  - `retrieveSubscription` and `cancelSubscription` use the same (platform) account.

**Probes (CI lane, exact head + probe specs only):** [run 37229072797](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229072797) (branch `audit/AUD-OPUS-T23-119/673-probes`, probe commit `d57f278b`). The new `test/audit-opus-t23-119-673.spec.ts` uses the PR's own `world()`, copied byte for byte.
- K1-K6 controls, all green:
  - K1: a 41 s read leaves no room, so `lease_exhausted` and no DELETE.
  - K2: trialing with 30 s left gives `trial_ending` and no DELETE, and the backoff is taken from the fresh clock.
  - K3: `paused` gives one DELETE, and the next call is `not_owed`.
  - K4: a 404 read gives `cancelled` and no DELETE.
  - K5: a replica during a slow read gets `busy`, and one DELETE is sent in total.
  - K6: a `customer.subscription.deleted` during the read wins (`stale`, no DELETE).
- C-673-4 probe: red as expected, at the final assertion only. The `{ accessAfterActive: true, outcome: 'superseded', deletes: 0 }` part passes.
- Replay `audit-opus-t23-118-673.spec.ts` (unchanged): C-673-2 and both C-673-3 probes stay red (open Cs). Three controls are green.

**Prior findings of this lens:**
- C-671-4 composed and B-672-3 composed stay closed.
- These stay open as C: C-673-1, C-673-2 and C-673-3. C-673-3 is on the #680 integration list.

**Findings (C, follow-ups only; FREEZE):**
- **C-673-4 (new):** `trial-conflict.service.ts:280-285`. A worker supersede does not re-sync the purchase.
  - Counterexample (probe): the `active` event is applied first, so the purchase is entitled. Stripe then retries the older trialing event, which causes a conflict, `owe` and access false. The worker reads `active`, supersedes and sends no DELETE. The paying client keeps `entitlement_active=false` until the next subscription event, about one period later.
  - Same out-of-order root cause as C-673-2 / R-1. The worker no longer deletes the plan, but access is not restored.
  - Fix rule: when the worker supersedes, apply the subscription it read through the same path the active webhook uses (or enqueue a resync).
  - Verify: the C-673-4 probe turns green.
- **C-673-5 (new):** `trial-conflict.service.ts:64` puts `past_due` and `unpaid` in `UNBILLED_STATUSES`. A plan that paid one period and then fell past_due is DELETEd if every read missed its `active` period. The header at :31-37 still says supersede on "active/past_due".
  - Fix rule: treat `past_due`/`unpaid` as billed when any invoice of the subscription has `amount_paid > 0`, and fix the header wording.
- **C-673-1:** `billing.service.ts:674-686`. Post-commit trial work is awaited inside the webhook request.
  - Fix rule: `void ... .catch(log)`; the sweeps retry.
- **C-673-2:** `checkout-webhook-handler.service.ts:925-934`. An older retried event rewrites an extended `trial_ends_at`.
  - Fix rule: write it only from the newest subscription state.
- **C-673-3 (outside this diff, binding ruling):** coach MRR and churn count never-billed trials. It stays on the #680 integration list.

**CI at this head:** all 10 checks pass (build-and-test, Schema parity, rls-floor-guard, rls/community/mwb-3 live, npm audit, size-label, test/comment deploy-readiness). deploy-readiness-gate is skipped as on every round. Merge state CLEAN.
