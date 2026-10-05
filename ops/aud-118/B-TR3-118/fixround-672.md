FIX ROUND 9 (B-TR3-118, agent 118) — growth-project-backend#672 @ 2690c07c1f418f3ec2a79ba93a2ffa9748698a48

Builder: Claude Opus 5.5, T4. Base T1 #671 @ `c75002c9` (unchanged). Answers [Sol RC 0/1/1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982319373) at `c5e7ed8e`; [Opus APPROVE 0/0/5](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982465734) has no open A/B.

| Finding | Change | Commit | Test (failing-before -> passing-after) |
|---|---|---|---|
| Sol B-672-3 (narrowed): an extension / cancel-at-period-end committed during push preparation was sent on the copy built before the claim | `trial-notice.service.ts`: `admit()` now runs `prepare()` again after the claim (push: after `getPreferences`) and returns the copy that is sent; `deliverPush(notice, clock)` and `deliverEmail(notice, clock)` send only that copy (the email context is built from it). `prepare()` reads the zone and the customer card first and the purchase last, so no read of the preparation outdates the purchase truth. A notice that no longer describes the current trial retires (`skipped`, both channels), an unknown card stays pending, a lease without room stays pending; each gives the attempt back through the fenced `complete()`. The pre-claim check stays, so a retired notice spends no claim. | `2690c07c` | 7 tests in T3 `test/b-trials-3-fix-round.spec.ts` ("B-672-3 (round 9)"; new tests go to #673 under the size cap): extension, early paid conversion, cancellation, purchase deleted, cancel at period end (push and email), card removed, extension committed during the email claim. Failing-before on T3 `df76889f` (T2 `c5e7ed8e`): [run 37221109080](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221109080) (all 7 red). Passing-after: [run 37221167230](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221167230) (this head, 6 T1/T2 suites 93/93 + `tsc --noEmit`) and [run 37221153162](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221153162) (T3 head, 10 suites 183/183 + tsc). |
| Sol C-672-1 (integration gate) | Unchanged; carried to the #680 composition list. | — | — |

**Prior probes replayed (unchanged files, this head):** [run 37221205916](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221205916)
- Sol `672-notice-probe.spec.ts` (AUD-SOL-T23-118, 17 tests, including the 15 retained AUD-SOL-T12-117 probes): 17/17 pass. The two B-672-3 admission races (extension and cancel at period end during the preference read) now pass.
- Opus `audit-opus-t23-118-672.spec.ts`: C-672-7 x2, B-672-3 retire and B-672-4 abort controls pass; C-672-10 and C-672-11 probes stay red (open Cs, follow-ups below).
- Opus `audit-opus-t12-117-672.spec.ts`: C-672-8 x2 and the cancelled control pass; C-671-4 view probe, C-672-7 "not Oct 13" and the exact-copy line of the unchanged control stay red by design, as ruled.
- The same Sol probe file also passes on the T3 head: [run 37221217159](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221217159).

**Money self-check**
- Webhook order and redelivery: the push and email copy follow the purchase row as committed right before dispatch, whatever order the subscription events arrived in. A change committed after the provider call starts cannot be retracted. Opus C-673-2 (an older retried event rewrites `trial_ends_at`) sits in the T3 writer and stays a follow-up.
- Concurrency: one lease per channel (compare-and-set claim), fenced outcome, the attempt given back on every refused admission, and no second send while one runs in this process. No DB transaction is held across push or email.
- Terminal states: canceled -> `skip:purchase_canceled`; paid or ended -> `skip:trial_ended`; deleted purchase or account -> `skip:purchase_missing`. Each is checked at admission, after the preference read. Refund and dispute do not reach a trialing notice.
- List pagination and completeness: unchanged keyset paging on both sweeps (B-672-2, B-656-3). This round adds no list calls.
- Currency: amounts still come from the notice row in minor units with its own currency (`formatTrialAmount`). This round adds no arithmetic.
- Copy truth: "will be charged" goes out only when, at admission, the purchase is trialing with access, the trial end is unchanged, it is not cancelling at period end, and a card is on file. An unknown card sends nothing. Still open, out of scope under FREEZE (follow-ups): C-672-11 (in-app row) and C-672-6(b) (in-app row frozen at record time).

**Size:** 15 files, +2,959 / -2 = **2,961** lines against T1 (was 2,977; net -16). No test file moved. 1,500-3,000: the operator posts the SIZE ASSESSMENT. The FIX ROUND 8 comment said 302 lines of headroom; the real headroom was 23 (Opus size note). It is now 39.

**Follow-ups (C), not changed under FREEZE (not the same lines as the B fix):**
- C-672-11 (Opus): `trial-notice.service.ts:324`. `recordTrialWillEnd` writes a "will be charged" in-app row for a purchase that already converted. Fix rule: return null when `purchase.status !== 'trialing'` (add `status` to the arg type).
- C-672-10 (Opus): `trial-notice.service.ts:956-959,1007-1010`. A hung push that really delivers is sent again. Fix rule: write the late definitive outcome through the fenced `complete()`, and release only on a non-definitive outcome.
- Carried: C-672-3 (mobile #338 ClientPackages push route), C-672-5 (reconciler notices carry no tax flag, `reconcilePage` ~:687), C-672-6(b) (in-app copy refresh on retire or supersede).

CI at this exact head: all 10 reported checks pass (build-and-test, Schema parity, community/mwb-3/rls live tests, rls-floor-guard, npm audit, size-label, test/comment deploy-readiness); deploy-readiness-gate skipped as on every prior round.

READY FOR AUDIT
