# AUD-OPUS-T23-119 — Claude Opus 5.5 lens, trials T2 #672 + T3 #673 (backend), agent 119 wave

Started 2026-10-04 12:30 PDT; verdicts posted 12:44 PDT; cleanup 12:44 PDT (times from `date`). Tier T4 (money path). Disk 58 percent.

## Result
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#672 (T2) | 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5983711171 |
| backend#673 (T3) | 5fdb5f5cf6fb09a23dd56382a47aafa4d0089c5d | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5983711331 |

- Both heads were re-read right before posting (12:44 PDT) and had not moved.
- CI: 10 pass at each head; deploy-readiness-gate is skipped (as on every round). Merge state CLEAN, still draft. CodeQL, danger, banned casts and SBOM run once the pieces are based on main.
- Verdict texts: ops/aud-119/AUD-OPUS-T23-119/verdict-672.md and verdict-673.md.

## Setup
- Claims: ops/lanes119/claims/backend-672-2690c07c-opus and backend-673-5fdb5f5c-opus.
- Sizes (gh and the local diff agree):
  - #672: 15 files, +2959/-2 = 2,961 against T1 c75002c9 (unchanged). Headroom is 39 lines.
  - #673: 11 files, +2879/-8 = 2,887 against T2.
  - The operator SIZE ASSESSMENT says KEEP on both.
- Evidence reuse (G09). This lens approved #672 @ c5e7ed8e (0/0/5) and #673 @ df76889f (0/0/3).
  - #672: the delta is one file, trial-notice.service.ts (+62/-78), read in full.
  - #673 merge 2413901f: byte-identical to the T2 delta (the diff of the two diffs is empty).
  - #673 fix 5fdb5f5c: trial-conflict.service.ts (+87/-19) and test/b-trials-3-fix-round.spec.ts (+192), read in full.
  - All other files are byte-identical to the approved heads.

## Decisions on prior findings
- Sol B-672-3 (the copy was built before the claim): closed. My R9-1..5 controls are green, and Sol's 672 probe passes per the builder's replay 37221205916.
- Sol B-673-1 (the retry deleted a subscription that had already billed): closed. My K1-K6 controls are green, and the builder's paid-retry replay passes.
- Sol C-673-2 (the lease came from the sweep's start clock): closed. K2 shows the backoff is taken from the fresh clock.
- This lens: C-672-7, C-672-8, C-672-9 and C-671-4 stay closed as ruled. The size note is closed, because the FIX ROUND 9 comment states the 39-line headroom correctly.
- Still open as C: C-672-10, C-672-11, C-672-3, C-672-5, C-672-6(b), C-673-1, C-673-2 and C-673-3.
- The builder's claim that "the late-clock probe replay needed one read-stub line" is accepted. Sol's original stub has no `retrieveSubscription`, and the fix fails closed without it. My K1 and K2 cover the same late-clock behaviour with a read stub.

## Probes (CI lane; probe specs only, on the exact heads)
- **#672:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229044175 (commit 716dd7e5).
  - New test/audit-opus-t23-119-672.spec.ts: 5/5 green (R9-1 to R9-5).
  - The 118 replay is as expected: C-672-10 and C-672-11 red, 4 controls green.
  - The 117 replay is as expected: 3 red by design, 3 green.
- **#673:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229072797 (commit d57f278b).
  - New test/audit-opus-t23-119-673.spec.ts: K1-K6 green. The C-673-4 probe is red at its final assertion only.
  - The 118 replay is as expected: C-673-2 and C-673-3 x2 red, 3 controls green.
- Copies and logs: ops/aud-119/AUD-OPUS-T23-119/ (spec files, run-*.log).

## Follow-ups (C)
1. **C-673-4 (new, #673)**
   - Where: `trial-conflict.service.ts:280-285`. A worker supersede does not re-sync the purchase.
   - Effect: after out-of-order events (active applied first, then the older trialing event creates the conflict), the paying client keeps `entitlement_active=false` until the next subscription event.
   - Fix rule: apply the subscription the worker read through the same path the active webhook uses, or enqueue a resync.
   - Test: the C-673-4 probe turns green.
2. **C-673-5 (new, #673)**
   - Where: `trial-conflict.service.ts:64`. `past_due` and `unpaid` are treated as unbilled, so a plan that paid one period is DELETEd if every read missed `active`. The header at :31-37 still says "active/past_due".
   - Fix rule: treat these states as billed when any invoice of the subscription has `amount_paid > 0`, and fix the header.
3. **C-672-10 (#672)**
   - Where: `trial-notice.service.ts:956-959, 1007-1010`. A hung push that really delivers is sent again.
   - Fix rule: write the late definitive outcome through the fenced `complete()`.
4. **C-672-11 (#672)**
   - Where: `trial-notice.service.ts:302-331`. A converted purchase gets a "will be charged" in-app row.
   - Fix rule: return null unless `status === 'trialing'`.
5. **C-672-3:** mobile #338 adds the ClientPackages push route.
6. **C-672-5:** `reconcilePage` (:650) records notices without the tax flag.
7. **C-672-6(b):** the in-app row copy is frozen at record time.
8. **C-673-1**
   - Where: `billing.service.ts:674-686`. Post-commit trial work is awaited inside the webhook request.
   - Fix rule: `void ... .catch(log)`.
9. **C-673-2**
   - Where: `checkout-webhook-handler.service.ts:925-934`. An older event rewrites an extended `trial_ends_at`.
   - Fix rule: write it only from the newest subscription state.
10. **C-673-3:** coach MRR and churn count never-billed trials. It is on the #680 integration list.

## Recurring-code notes (report only)
- R-1 (carried): there is no event-ordering guard on subscription writes. C-673-2 and C-673-4 are both cases of it, so they belong with #680's "unified webhook writes" item.

## Operator decisions (recommended default first)
1. **C-673-4 and C-673-2: the same out-of-order root cause.**
   - Default: one fix in the #680 unified-webhook-writes integration round, with both probes as the tests, before any trial is sold.
   - Alternative: a T3 round now. #673 has 113 lines of headroom.
2. **C-673-5 (past_due policy).**
   - Default: ticket it and fix it with C-673-4. This lens does not block on it, because it needs every hourly read to miss a full paid period.
3. **Carried.**
   - The owner enables `customer.subscription.trial_will_end` on the Stripe endpoint.
   - Mobile #338 adds the push route.
   - Trials land after recurring, with the C-656-1 list.

## Progress
- 12:30 PDT: read the rules, the job entry and the prior reports.
- 12:38 PDT: deltas read; probes pushed.
- 12:43 PDT: both runs completed as expected.
- 12:44 PDT: verdicts posted.
- 12:44 PDT: cleanup.
  - Remote audit/AUD-OPUS-T23-119/672-probes and 673-probes are deleted (ls-remote empty).
  - Worktrees wt/AUD-OPUS-T23-119-672 and wt/AUD-OPUS-T23-119-673 are removed and pruned.
  - No local branches remain.

## HANDOFF
- Done: one verdict per PR at the exact heads. #672 APPROVE 0/0/5 and #673 APPROVE 0/0/5.
- Cleanup is complete. The operator can release the claims ops/lanes119/claims/backend-672-2690c07c-opus and backend-673-5fdb5f5c-opus.
- Next lens action: only on a new head. That means a delta audit, with evidence reuse for byte-identical code, replaying ops/aud-119/AUD-OPUS-T23-119/*.spec.ts.
