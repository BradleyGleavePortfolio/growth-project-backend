FIX ROUND 1 (B-D34-116, agent 116) — growth-project-backend#689 @ 6cead7ec88e2ba17aa6418cf2636874a024bdf4a

Scope: closes Sol RC 0/4/0 (5975999246) and Opus RC 0/2/2 (5976089521). The latest #688 (6718d211) was merged in first (merge commit, no rebase). Piece size is 2,913 changed lines (was 2,462).

| Finding | Change | Commit | Test (`test/dunning-d3-fix-round.spec.ts`) |
|---|---|---|---|
| Sol B-689-1 / Opus B-689-1 (card update settles an open dispute, lock lifts) | `disputeOpen()` is the marker or D2 `isDisputeCycleOpen`. It is used in the quote, `payPlan`, `replayPlan` and `reconcileCardOperation`. `restoreAfterPayment` re-decides after the pay, inside the money tx, under `DunningState ... FOR UPDATE` (`settleCycleOnPaid`, the same lock D2 dispute recording takes). A disputed cycle gets `keepAsDisputeCycle`, with no `applyImmediateClear` and no v1. v1 `recordResolution` runs only when the locked check cleared the cycle, and a failed check resolves nothing. `keepPaidPeriod` uses the same rule. | `67096788` | obligation-only cycle; dispute recorded mid-pay; background reconcile; failed authority read; no-dispute control |
| Opus P1b (dispute closed lost before the renewal) | Decided by D2's predicate. It passes only with #688 B-688-5, which is merged here. | `2edc9826` | "a dispute that closed lost during the cycle still blocks the card update" |
| Sol B-689-2 / Opus C-689-1 (free-form diagnostics) | Every log line uses `dunningErrorCode(err)` (the D1 closed vocabulary). This includes the reconciler fatal log. | `67096788` | sentinel no-leak across Stripe 503, transport, TypeError and reconciler |
| Sol B-689-3 (paid invoice credited without attribution) | A lost reply on a paid invoice triggers an immediate same-key replay. A replayed paid result is paid; a definitive refusal is `already_paid` (0). Anything else is `uncertain`, and the op stays open for the reconciler. | `67096788` | Stripe retry paid during the await -> uncertain -> reconcile `already_paid` 0; own lost reply credited (control) |
| Sol B-689-4 / Opus B-689-2 (cancel during a dispute keeps the period, resolves the dispute) | Operator ruling: with a dispute open, `runDunningCancel` never takes option A; it takes 2A (end now). The cycle ends abandoned, never resolved. The reply adds: "Ending the plan does not settle the payment your bank reversed; contact support at ... to sort it out." Nothing claims that a payment went through. | `67096788` | latest invoice paid; before the lock / after the lock / set outside the app (reconcile); option-A control |
| Opus C-689-2 (reconciler starvation) | A failed or orphaned op is moved to the back of the queue (`updated_at` bump, settle window again). The out-of-band 2A page is ordered and bumped on failure. | `4f477b21` | 100 failing ops + 1 healthy op: the healthy one finishes |
| copy | A dispute-only plan no longer says "access is still updating". | `67096788` | asserted in the first case |

Failing-before runs (at 9e77159a plus the spec):
- First set: 7 failed / 3 controls passed: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173650946
- Full set: 12 failed / 3 controls passed: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174160085

Passing after: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174229442 (D3 spec plus the D2 service, foundation and fix suites, 75/75). The D4/D5 suites on top also pass: runs 37174520805 and 37174570264.

Left for the operator (code in #688, see report B-D34-116):
- v1 `recordResolution` has no tx or dispute guard, so a dispute recorded in the milliseconds between the locked check and v1 still lands on a resolved cycle.
- `resolvePurchaseFromCharge` swallows errors.

Checks at this head: all applicable checks green. CodeQL, danger, banned casts and SBOM do not run on stacked bases.

READY FOR AUDIT
