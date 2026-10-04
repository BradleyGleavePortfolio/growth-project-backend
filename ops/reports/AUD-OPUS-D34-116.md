# AUD-OPUS-D34-116 (lens: Claude Opus 5.5) — backend #689 (D3) and #690 (D4)

Started 2026-10-04 02:49 UTC (2026-10-03 19:49 PDT). Claims: backend-689-9e77159a-opus, backend-690-f72668c2-opus.
Heads at start: #689 9e77159a710fe9022fd8016374f1fd9067337b0f (10 pass, 1 skipping), #690 f72668c26f8bea505dea7e47594e98ac4a921398 (10 pass, 1 skipping).
Original #628 @ dc47e0efe2270e21a00ab8d038a9e7dbb415efe9 (FIX ROUND 8, unaudited).
Worktree (read only, no deps): /home/user/workspace/wt/AUD-OPUS-D34-116-1 @ f72668c2.

## Notes
- Every file in D3 and D4 is byte-identical to #628 @ dc47e0ef (git diff --stat empty for both file sets).
- Prior Opus lens on #628: APPROVE 0/0/0 @ 739e9a54; RC 0/1/2 @ 33e0696a (B-628-13, C-628-14, C-628-15). FIX ROUND 8 @ dc47e0ef claims all.
- Changed in D3/D4 files since 739e9a54: client-billing.service.ts (+485/-?), checkout-webhook-handler.service.ts (+61), 3 test lines.
  Since 33e0696a: client-billing.service.ts (+43/-16 R9), checkout-webhook-handler.service.ts (+10 R9).
- Read in full: client-billing.service.ts (2414), client-billing.reconciler.ts, D4 diff (controller, webhook handler, guard,
  scheduler, status controller, entitlement guard, module wiring, public page, AASA, main.ts) and the D4 tests' harness.
- Operator mail 19:50: verify the D12 lead (lost dispute in a payment cycle lets a renewal payment lift the lock) on the D3
  card-update path; decide C-628-14, C-628-15, B-628-11 for code in #689/#690.

### Candidate findings (proved below)
- B-689-1: D3 decides "dispute open" from the marker only (`isDisputeCycle` :315, used :422 quote, :581 payPlan, :830 replay,
  :1934 reconciler). A dispute recorded during a payment cycle (handleLateReversal -> cycle_already_active, marker stays the
  decline text) is invisible to the card update: payPlan -> restoreAfterPayment (:729) -> v1 recordResolution (:1113-1121)
  resolves the cycle; the lockout guard needs status active, so the Day-10 lock lifts while the dispute is open. FIX ROUND 8
  fixed only the webhook path (resolveDunningOnPaid uses isDisputeCycleOpen + keepAsDisputeCycle).
- B-689-2: cancel during a dispute cycle -> runDunningCancel finds no open invoice, latestPeriodState 'paid' -> keepPaidPeriod
  (:1614-1671) -> v1 recordResolution (:1657) resolves the dispute cycle, keeps access to period end, copy says "Your latest
  payment went through" although the bank reversed it.
- Probe: branch audit/AUD-OPUS-D34-116/689-dispute-paths (9e77159a + probe only), run 37172705037.

## Results

### #689 (D3) @ 9e77159a710fe9022fd8016374f1fd9067337b0f — REQUEST CHANGES, A/B/C = 0/2/2
Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5976089521
Probe run (this head + probe only): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172931700
(first run 37172705037, same result). C1 control pass; P1, P1b, P2 fail as predicted.
- B-689-1: the card update settles an open dispute and lifts the Day-10 lock. Cause: marker-only `isDisputeCycle` at
  :315 (used :422/:581/:830/:1934), plus `restoreAfterPayment` running v1 `recordResolution` (:1113-1121) after
  `applyImmediateClear` refused. P1 observed: state resolved, unlocked, quote shows no dispute, copy says "Your plan is
  active again". Operator lead (lost dispute) confirmed on this path as P1b. The lost predicate itself belongs to #688.
- B-689-2: "End my plan" during a dispute cycle goes through `keepPaidPeriod` (:1614-1671), which resolves the dispute
  cycle (v1 :1657), restores entitlement (:1630), keeps the disputed period and says "Your latest payment went through".
  P2 observed: scheduled, paid_period_kept true, state resolved, Day-19 lock 0, access to 2026-11-04.
- C-689-1: free-form err.message in logs (15 sites; same class as B-688-4). C-689-2: reconciler starvation and ordering.
- Decided: B-628-13 card-update path still open (now B-689-1). B-628-11 CLOSED. C-628-14 CLOSED. C-628-15 CLOSED.

### #690 (D4) @ f72668c26f8bea505dea7e47594e98ac4a921398 — REQUEST CHANGES, A/B/C = 0/1/4
Verdict: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5976089623
Probe run (this head + probe only): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173263249
W0 control pass; W1, W2 fail as predicted.
- B-690-1: in `resolveDunningOnPaid`, if `isDisputeCycleOpen` throws, the catch (:1225-1229) falls through to v1
  `recordResolution` (outside the tx) and `applyImmediateClear`. One transient read error permanently settles the dispute
  cycle. W1 observed: resolved, no Day-19 lock, even after a healthy redelivery.
- C-690-1: a late `invoice.payment_failed` after 2A flips the purchase from canceled to past_due (W2).
- C-690-2: dispute.created and dispute.closed effects are fire-and-forget; an error loses them, and locked rows are never
  re-evaluated by the sweep.
- C-690-3: public card page copy uses "our" (first person) and says "your access stays on".
- C-690-4: free-form err.message in logs.
- Decided: B-628-13 webhook path CLOSED, except for B-690-1.

### Belongs to other PRs (for the operator)
- #688: a `lost` obligation counts as terminal in `hasOpenDisputeObligation` (Sol B-688-5 / Opus D12 B-688-1). It feeds
  #689 P1b and #690 resolveDunningOnPaid. The D3 fix must use the D2 predicate so it inherits that fix. The log-text
  class is B-688-4.
- #687: Sol B-687-1 (effectiveLock) is used by the D4 lockout guard.

### Operator decisions (recommended default first)
1. B-689-2, cancel during a dispute cycle: (a) 2A end access now (recommended; a dispute cycle is dunning under the B-628-8
   rulings), or (b) a period-end cancel that keeps the dispute cycle and its lock timeline.
2. Stripe dashboard: "If all retries for a payment fail" must stay "leave the subscription past-due". Otherwise access ends
   on Day 7 instead of the Day-10 lockout, because the entitlement guard's Days 0-9 branch admits only past_due.

### CI state at posting
#689 and #690: 10 pass, 1 skipping (deploy-readiness-gate). Both mergeable (CLEAN). Heads re-read immediately before posting
and unchanged.

### Cleanup
Audit branches audit/AUD-OPUS-D34-116/689-dispute-paths and 690-webhook-paths deleted on origin (matching refs = 0).
Worktrees AUD-OPUS-D34-116-1/-2 removed. Probe specs, run logs and verdict bodies kept under
/home/user/workspace/ops/aud-116/AUD-OPUS-D34-116/.

## HANDOFF
- backend #689 (D3) @ 9e77159a710fe9022fd8016374f1fd9067337b0f: Opus REQUEST CHANGES 0/2/2 (comment 5976089521), and Sol
  has also posted REQUEST CHANGES. Next step: the builder fixes B-689-1 (durable dispute predicate in all four D3 sites, plus
  keepAsDisputeCycle instead of v1 resolution, failing closed) and B-689-2 (needs operator decision 1). Add failing-before
  tests (P1/P1b/P2 shapes) with CI-lane run URLs. Then re-audit both lenses at the new head.
- backend #690 (D4) @ f72668c26f8bea505dea7e47594e98ac4a921398: Opus REQUEST CHANGES 0/1/4 (comment 5976089623). Next step:
  the builder fixes B-690-1 (resolveDunningOnPaid fails closed on a dispute-read error; v1 resolution inside the tx or after
  commit) with a failing-before test (W1 shape). The C items can go in the same round. Then rebase onto the fixed #689 and
  re-audit.
- The #688 lost-dispute fix (B-688-5 / D12 B-688-1) is a prerequisite for #689 P1b to pass.
- Nothing merged, no flags or production touched, no money spent. FEATURE_DUNNING_V2 stays off. Land as one after D5 #691
  with mobile #322/#352-#354, as planned.
