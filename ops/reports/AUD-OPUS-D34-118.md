# AUD-OPUS-D34-118 (lens: Claude Opus 5.5, agent 118 wave) — backend #689 (D3) and #690 (D4)

Started 2026-10-04 10:02 PDT. Finished 10:29 PDT. Claims: lanes118/claims/backend-689-bb992fed-opus, backend-690-06307883-opus (left in place for the operator).
Prior Opus verdicts: #689 RC 0/2/2 @ 9e77159a (5976089521); #690 RC 0/1/4 @ f72668c2 (5976089623). Earlier report: AUD-OPUS-D34-116.md.
Notes, verdict bodies and probe specs: /home/user/workspace/ops/aud-118/AUD-OPUS-D34-118/ (verdict_689.md, verdict_690.md, audit-opus-d34-118-689.probe.spec.ts, audit-opus-d34-118-690.probe.spec.ts, d3-delta.diff, d4-delta.diff).

## Verdicts posted
| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #689 (D3) | bb992fedf0095446f916f3261742bd262c3d94da | REQUEST CHANGES | 0/1/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5982575687 |
| #690 (D4) | 06307883100ec142aa2818fc30ee276cab26c1ec | APPROVE | 0/0/3 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5982575812 |

Heads and checks re-read at 10:28 PDT right before posting: unchanged. Sol's verdicts at these heads (REQUEST CHANGES on both, per prstate) were not read before these verdicts were written.

## PR state and CI
- #689: base D2 #688's branch; draft; merge CLEAN; checks pass=10, skipping=1 (CI 37178688039, npm audit 37178687988, schema 37178687995); size 2,913 (about 87 lines of headroom); R75 range OK.
- #690: base #689's branch; draft; merge CLEAN; checks pass=10, skipping=1 (CI 37178686881, npm audit 37178686852, schema 37178686843); size 2,913 (2,690+/223-); R75 range OK.
- FIX ROUND 2 on both is merge-only (D1 7d7e7db4..f8e47bf4 coach-alert emitter only); D3 patch-id unchanged; every D4 file outside the fix-round set is byte-identical to f72668c2.

## Probes (CI lane, PR head + probe spec only; branches deleted after the runs)
- #689: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220145001 — C1, P1, P1b, P2 pass (116 replay); P3 fails (B-689-5).
- #690: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220162681 — W0, W1, W2 pass (116 replay); W3, W4 fail (#688 code, operator items 3 and 4).

## Prior findings decided
- B-689-1 CLOSED (67096788, tests 2edc9826; failing-before 37173650946, 37174160085; P1/P1b pass).
- B-689-2 CLOSED (67096788; failing-before 37174160085).
- C-689-1 CLOSED (67096788; P2 passes: 2A ends access now, copy says the reversal is not settled).
- C-689-2 CLOSED (4f477b21; failing-before 37174160085).
- B-690-1 CLOSED (821d943f; failing-before 37174150526; W1 passes).
- C-690-1 CLOSED (821d943f, 0681babd; W2 passes).
- C-690-2 CLOSED in the D4 diff (821d943f); residual in #688 (W3).
- C-690-3 CLOSED as raised; dispute-cycle nuance is the new C-690-5.
- C-690-4 CLOSED (821d943f).

## Open B (fix round needed on #689 only)
- B-689-5 `src/checkout/client-billing.service.ts:323-330` (`disputedAmount()` reads `DunningState.last_failed_amount_cents`), used at :441, :1274 and the copy at :1416-1425. D2's handleLateReversal never writes that field, so the "reversed" amount is the last failed renewal of an earlier cycle. P3: ledger 9900, quote 15000, reply "Your bank reversed an earlier payment of $150.00". Fix rule: amount only from the open obligations' ChargeDispute rows (sum per currency), else null and the copy omits it; never last_failed_amount_cents. Failing-before test: P3. Fits the size headroom (the minimal null fix is a few lines plus P3).

## Follow-ups (C)
- C-689-3 `client-billing.service.ts:1551-1555` with `:1724` and `:1737`: a dispute recorded between the option-A decision and keepPaidPeriod's fenced tx keeps the dispute cycle but the reply promises access to period end. Fix rule: when settleCycleOnPaid returns `dispute` inside keepPaidPeriod, continue on the 2A path or return copy that says the reversal is not settled.
- C-689-4 `client-billing.service.ts:1935-1937`, `:1950-1952`: `.catch(() => undefined)` hides a failed reconciler bump. Fix rule: log `dunningErrorCode(err)`.
- C-690-5 `src/public-pages/public-pages.html.ts:91-94`: the card page says the app tries the amount owed and access comes back; untrue for dispute-cycle clients, whose notices link here. Fix rule: add a sentence that a reversed payment is not settled by a new card, with the support path (same rule as D12 B-687-5).
- C-690-6 `src/checkout/checkout-webhook-handler.service.ts:891-904`: subscription.updated locks DunningState then writes ClientPurchase; invoice.paid and #689 (restoreAfterPayment :1119/:1170, endAccessNow :1780/:1791, keepPaidPeriod :1711/:1724) take ClientPurchase first. A 1A payment triggers exactly this webhook concurrently; Postgres aborts one side, both recover. Fix rule: lock ClientPurchase FOR UPDATE before the DunningState lock (one order everywhere, as D12 C-688-9).
- C-690-7 `checkout-webhook-handler.service.ts:1328-1333` then `:1355-1364`, `:1368`: payment_failed stale check and the past_due write are not atomic. Fix rule: `updateMany` with `status: { not: 'canceled' }`, skip recordFailure on count 0.

## Operator decisions (recommended default first)
1. #690 APPROVE covers the D4 diff only. Default: #690 lands only after #689's B-689-5 fix; that fix restacks #690, and the new #690 head gets a short merge-only delta verdict (Rule 12 does not cover restacks).
2. B-689-5 scope. Default: minimal fix in #689 (amount null unless ledger-backed, copy omits it) plus P3 as the failing-before test; a ledger-backed amount can follow in the same round if it fits the 87-line headroom, else ticket it.
3. #688 (not blocking these PRs): `resolvePurchaseFromCharge` (dunning-v2.service.ts:1626-1690, catch :1687-1689) swallows read errors and returns null. W3: a won dispute.closed with one transient lookup failure is acknowledged and deduplicated; the client stays locked permanently (the sweep skips locked rows). Default: B on #688; fix rule: return null only on a clean miss, rethrow read errors. Hand to the D12 lenses / B-D12 builder.
4. #688: `handleLateReversal` previouslyCleared (dunning-v2.service.ts:1100-1106) compares the dispute's created time with resolved_at. W4: a dispute created during a payment cycle but processed after the cycle resolves opens nothing (obligation open, no cycle, full access); processed earlier it keeps a dispute cycle (W0). Order-dependent outcome. Default: B on #688; fix rule: a newly recorded open obligation on a resolved state opens the compressed cycle regardless of the dispute's created time.
5. #688: the same wrong-amount source as B-689-5 in getClientStatus (dunning-v2.service.ts:1555) and dispute-cycle notices (buildDispatchContext :1597). Default: same fix rule (ledger amount or omit) in #688's next round.
6. #688 question: `no_state` — a dispute on a purchase that never failed a renewal opens no cycle and only records the obligation. Default: confirm intended (no dunning for a first-ever dispute) or rule that it opens a compressed cycle.

## Progress log
- 10:02 read rules, claimed both heads.
- 10:0x read FIX ROUND 1/2 comments and both deltas; verified builder failing-before and passing-after runs; R75 and size.
- 10:21 probe runs started (37220145001, 37220162681); both finished with the results above.
- 10:28 heads and checks re-read, unchanged; both verdicts posted.
- 10:28 audit branches deleted on origin; worktrees AUD-OPUS-D34-118-1/-2 removed (no node_modules present).

## HANDOFF
Done. #689 @ bb992fed: REQUEST CHANGES 0/1/2 (B-689-5 open; next: builder fix round with P3 as failing-before, then a fresh Opus lens audits the new head). #690 @ 06307883: APPROVE 0/0/3 (next: after the #689 fix restacks it, a short merge-only delta verdict at the new head). C follow-ups and #688 items above are for the operator. No branches or worktrees from this job remain; claims stay in lanes118/claims.
