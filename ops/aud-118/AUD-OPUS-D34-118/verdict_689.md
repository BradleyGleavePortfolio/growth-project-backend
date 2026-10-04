AUDIT Claude Opus 5.5 — growth-project-backend#689 @ bb992fedf0095446f916f3261742bd262c3d94da — VERDICT: REQUEST CHANGES
A/B/C = 0/1/2

Lens AUD-OPUS-D34-118 (agent 118). Tier T4 (money, access). Head re-read right before posting: unchanged. Checks at this head: pass=10, skipping=1 (CI 37178688039, npm audit 37178687988, schema 37178687995). Size 2,913 changed lines (under 3,000; about 87 lines of headroom). R75 range check OK (empty-catch-undefined +2 -2, net 0).

Probe run (this head + probe spec only, branch audit/AUD-OPUS-D34-118/689-probes): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220145001 — C1, P1, P1b, P2 pass; P3 fails (B-689-5).

## Prior Opus findings (116 verdict 5976089521 @ 9e77159a)
| ID | Decision | Closing commit | Failing-before | Replay at this head |
|---|---|---|---|---|
| B-689-1 card update settled an open dispute | CLOSED | 67096788 (dispute authority under the DunningState lock in settleCycleOnPaid :1164-1180, disputeOpen :1186), tests 2edc9826 | 37173650946, 37174160085 | P1 and P1b pass (dispute cycle kept, still locked, plan dispute_open=true) |
| B-689-2 raw provider/DB text in logs | CLOSED | 67096788 (dunningErrorCode on every catch) | 37174160085 | builder test "B-689-2" green in 37174229442 |
| C-689-1 cancel during a dispute claimed the payment went through | CLOSED | 67096788 (runDunningCancel :1551 dispute -> 2A; endAccessNow copy) | 37174160085 | P2 passes: outcome ended, access ends now, state abandoned, copy says the reversal is not settled |
| C-689-2 reconciler page starvation | CLOSED | 4f477b21 (deferOperation :1949) | 37174160085 | builder test "C-689-2 (Opus)" green |

FIX ROUND 2 (5976887001) is merge-only: delta bb992fed vs 6cead7ec is D1 7d7e7db4..f8e47bf4 only (coach-alert emitter); D3's own patch-id is unchanged. Evidence reuse: none beyond the replayed probes; every D3 line changed since 9e77159a was read in full.

## B-689-5 — the reversed amount shown to the client is the last failed renewal, not the disputed charge
- Where: `src/checkout/client-billing.service.ts:323-330` (`disputedAmount()` reads `DunningState.last_failed_amount_cents`), used by the quote `disputes[].amount_cents` (:441), the card-result quote (:1274) and the card-result copy "Your bank reversed an earlier payment of $X" (:1416-1425). Present since 9e77159a; missed in the 116 round.
- Why it is wrong: the comment at :323-326 says the dispute cycle "records" the reversed amount. It does not. D2's `handleLateReversal` (dunning-v2.service.ts:1122-1145) never writes `last_failed_amount_cents`; the field still holds the amount of the last failed renewal of an earlier cycle (v1 recordFailure, dunning.service.ts:239/265), and after `keepAsDisputeCycle` it is the renewal that was just paid. The dispute ledger (`ChargeDispute.amount_cents` / `currency`) has the true figure.
- Counterexample (probe P3, run 37220145001): a $150.00 renewal fails on Day 0 and Stripe's retry pays it on Day 1 (resolved). On Day 12 the bank reverses an earlier $99.00 charge (first month, before the price moved); the ledger row is 9900 usd and a compressed dispute cycle opens. The Day-13 quote reports `disputes[0].amount_cents = 15000`, and the card update reply reads "Your bank reversed an earlier payment of $150.00. Saving a card does not settle that; contact support at <SUPPORT_EMAIL> to sort it out." Expected 9900 or no amount. Same wrong figure with two open disputes (one amount shown for two reversals), coupons, tax or price changes.
- Minimal fix rule: the reversed amount comes only from the open obligations' dispute ledger rows (`ChargeDispute.amount_cents`, summed per currency); when that is not known, `amount_cents` is null and the copy omits the amount ("Your bank reversed an earlier payment."). Never `last_failed_amount_cents`. Fix the comment at :323-326. Failing-before test: P3 from the probe branch.
- Verify: P3 passes; the P1 reply still reads "Your bank reversed an earlier payment." with no amount.

## C-689-3 — a dispute recorded during the option-A cancel gets the period-end reply
- Where: `client-billing.service.ts:1551-1555` decides option A from `disputeOpen` outside any lock; `keepPaidPeriod` (:1688-1738) then sets cancel_at_period_end at Stripe, and when `settleCycleOnPaid` (:1724) returns `dispute` the reply is still `scheduledResult(..., true)` (:1737), which promises access to period end while the dispute cycle stays active with its lock timeline.
- Counterexample: the cancel reads no dispute at :1551; charge.dispute.created commits between that read and the fenced tx; settleCycleOnPaid keeps the dispute cycle; the client is told access lasts to period end, contrary to the ruling that a cancel during a dispute cycle ends access now.
- Minimal fix rule: when settleCycleOnPaid returns `dispute` inside keepPaidPeriod, do not return the period-end reply: continue on the 2A path (or return a result whose copy states the reversal is not settled and access follows the dispute cycle).

## C-689-4 — two silent catches in the reconciler
- Where: `client-billing.service.ts:1935-1937` (out-of-band 2A bump) and `:1950-1952` (deferOperation): `.catch(() => undefined)`.
- Effect: a failed bump is invisible, so a row that keeps failing can stay at the head of the `take: 100` page with no signal.
- Minimal fix rule: log a closed code (`dunningErrorCode(err)`) in both catches.

## Not findings here (for the operator report)
- Lock order: D3 takes ClientPurchase then DunningState (restoreAfterPayment :1119/:1170, endAccessNow :1780/:1791, keepPaidPeriod :1711/:1724), the same order as invoice.paid. The inverted writer is #690's subscription.updated path (C-690-6 there) and #688's tryLock (C-688-9 in the D12 report). No change needed in this diff.
- The same wrong-amount source is used by #688's getClientStatus (dunning-v2.service.ts:1555) and dispute notices (buildDispatchContext :1597): reported for #688.

FREEZE: only B-689-5 needs a fix round; C-689-3 and C-689-4 go to the operator's follow-up list.
