AUDIT Claude Opus 5.5 — growth-project-backend#672 @ 2690c07c1f418f3ec2a79ba93a2ffa9748698a48 — VERDICT: APPROVE
A/B/C = 0/0/5

Lens AUD-OPUS-T23-119 (agent 119). Tier T4 (money copy, notices). Base T1 #671 @ `c75002c9` (unchanged, dual APPROVE). Answers FIX ROUND 9 ([5982762148](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982762148)). Size 15 files, +2,959/-2 = 2,961 (gh and local diff agree). The operator SIZE ASSESSMENT says KEEP. Headroom is 39 lines; the round comment states this correctly now.

**Evidence reuse (G09):** this lens approved `c5e7ed8e` at 0/0/5 ([5982465734](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5982465734)). The delta `c5e7ed8e..2690c07c` touches one file, `src/packages/trials/trial-notice.service.ts` (+62/-78), and it was read in full. The other 14 files are byte-identical to the approved head, so that evidence still applies to them.

**Delta review (Sol B-672-3 closure): closed.**
- `admit()` (:891) runs `prepare()` again after the claim. For push, this happens after `getPreferences` (:718); for email, right after the claim (:770). Only that copy is sent (`ready.copy`, email `data` built from `ready.purchase`).
- No await stands between admission and the provider call except the bounded wrapper's microtask.
- When the trial is no longer current, the notice is retired. `settleSkipped` touches pending channels only, and the fenced `complete()` gives the attempt back and clears the lease.
- An unknown card or a lease without room keeps the channel pending, with the attempt given back.
- `prepare()` reads the purchase last, then the clock (`trialNoticeSkipCode(..., clock())`), and checks the lease room after all reads.
- `willChargeCard(card_on_file, customerCard)` has the same truth table as the old `cardAuthority`: true wins, and a null customer read means unknown.
- Moving `no_email` after admission is correct: a retired notice now settles `skipped`, not `no_email`.

**Probes (CI lane, exact head + probe specs only):** [run 37229044175](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229044175) (branch `audit/AUD-OPUS-T23-119/672-probes`, probe commit `716dd7e5`).
- New `test/audit-opus-t23-119-672.spec.ts`, 5/5 controls green:
  - R9-1: a retire at the email admission after a delivered push leaves the push `delivered`, sets email to `skipped` with `email_attempts` 0, and clears the lease.
  - R9-2: an unknown card at the push admission sends nothing and leaves the channel pending with attempts 0. The next delivery sends once with the charge copy.
  - R9-3: a 90 s admission read exhausts the lease. Nothing is sent, the channel stays pending with `push:lease_exhausted`, and attempts are 0.
  - R9-4: cancel at period end committed during the email claim (push muted) gives `will_charge:false`.
  - R9-5: the zone read at admission is the one written into the push ("Oct 13 at 12:30 AM EDT").
- Replay `audit-opus-t23-118-672.spec.ts` (unchanged): C-672-10 and C-672-11 stay red (open Cs). Four controls are green.
- Replay `audit-opus-t12-117-672.spec.ts` (unchanged): C-671-4, C-672-7 "not Oct 13" and the exact-copy line stay red by design, as ruled. Three tests are green.

**Prior findings of this lens:**
- C-672-7, C-672-8, C-672-9 and C-671-4 stay closed as ruled.
- The size note is closed.
- These stay open as C: C-672-10, C-672-11, C-672-3, C-672-5 and C-672-6(b).

**Findings (C, follow-ups only; FREEZE):**
- **C-672-10:** `trial-notice.service.ts:956-959, 1007-1010`. A hung push that really delivers is sent again.
  - Fix rule: write the late definitive outcome through the fenced `complete()`, and release only on a non-definitive outcome.
  - Verify: the 118 probe turns green.
- **C-672-11:** `trial-notice.service.ts:302-331` (`recordTrialWillEnd`). A stale `trial_will_end` writes a "will be charged" in-app row for a converted purchase.
  - Fix rule: return null when `purchase.status !== 'trialing'`.
  - Verify: the 118 probe turns green.
- **C-672-3:** mobile #338 must route the trial-ending push to ClientPackages.
- **C-672-5:** `reconcilePage` (:650) records notices without the tax flag.
  - Fix rule: carry the tax flag on the purchase, or re-read it at delivery.
- **C-672-6(b):** the in-app row copy is frozen at record time.
  - Fix rule: update or retire the in-app row when the notice is retired or superseded.

**CI at this head:** all 10 checks pass (build-and-test, Schema parity, rls-floor-guard, rls/community/mwb-3 live, npm audit, size-label, test/comment deploy-readiness). deploy-readiness-gate is skipped as on every round. CodeQL, danger, banned casts and SBOM run once the piece is based on main. Merge state CLEAN.
