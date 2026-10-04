FIX ROUND 13 (B-FEES-117, agent 117) — growth-project-backend#683 @ 536de5c292acc8cbdc54d87eedbed5a5be72edd0

Builder: agent 117, job B-FEES-117. Base F2 #682 (`be26e289`). Size 2,526 (was 2,984; the settlement spec moved to F4b #697); SIZE ASSESSMENT below.

| Finding | Change | Commit | Test (F4b #697) |
|---|---|---|---|
| Sol B-683-4: `{data: [], has_more: true}` accepted as a complete refund list | new exported `chargeRefundsFromStripe(stripe, chargeId, settlementCurrency)` replaces `convertedRefundedCents`: requires an array `data` and a boolean `has_more`; only `has_more=false` ends; a refund needs id, status, safe-integer amount and currency; a non-advancing cursor or 20 pages is `SFEE_REFUND_STATE_UNAVAILABLE kind=refund_list_incomplete`, a bad page `kind=refund_page_malformed`, a succeeded converted refund without its balance transaction `kind=refund_balance_transaction_missing`. Retryable; nothing moves, the settlement is flagged | `933691efea8855e24f272c58bb279030228a7f22`, `dac4e5fd773cfb2b315980dacd57fb11f409ad32` (identity read without a settlement currency, used by F4) | `Sol B-683-4` block: 5 malformed/incomplete shapes rejected; converted charge: rejects, `refunded_cents` 0, coach net stays 7,640, `reconcile_reason` `SFEE_REFUND_STATE_UNAVAILABLE ...`; two pages summed exactly (600 / 600) |
| Sol B-683-1: a converted refund notice said "A client got $20.00 back" for CAD 25.00 | the reader also returns the client's succeeded total in their own currency; refund notices with no dispute withdrawal store `client_currency` / `client_refunded_cents` (F1 columns), change detection compares them; copy for converted charges names both amounts | `933691efea8855e24f272c58bb279030228a7f22` | `Sol B-683-1` block: CAD 25 / USD 20 (coach net 5,640, notice 2,000 usd + 2,500 cad), later full refund at a changed rate (8,300 usd / 10,000 cad), same-currency control unchanged |
| Opus B-684-3 (F3 half): settlement and reconciliation counted pending refunds | `settleChargeLocked` and `reconciliation.service` use the succeeded debit total from the canonical list when `amount_refunded > 0` | `933691efea8855e24f272c58bb279030228a7f22` | `Opus B-684-3` block P1-P5 |
| size (operator ruling 2) | `test/s-fee-charge-settlement.spec.ts` moved unchanged to F4b #697 | `933691efea8855e24f272c58bb279030228a7f22` | runs green in #697 |

Copy changed (old -> new), `src/connect/fees/payout-notice-copy.ts`, refund notice on a converted charge only:
- "A client got $20.00 back." -> "A client got 25.00 CAD back, $20.00 after conversion."
- Same-currency charges: byte-identical (F5's r5 copy pins unchanged and green).

Evidence: failing-before [run 37179995422](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179995422) (the F4b spec on the pre-fix F4 head `e9ee033d`, which contains this piece at `35a18539`): 19 failed / 3 passed, the three passing are the controls (same-currency notice, P4, P5). Passing-after: the same spec 22/22 in #697's build-and-test.

CI at this head: build-and-test [run 37180265103](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180265103) red by design, exactly 9 tests in 3 suites: `checkout-webhook-fee-split.spec.ts` 2 and `purchase-split-handler.service.spec.ts` 2 (as F2), plus `reconciliation.service.spec.ts` 5 ("persists snapshot rows that listDrift returns", "reflects refunded amount on the Stripe side", "returns drift when Stripe shows more revenue than the ledger", "returns ok when Stripe + ledger agree exactly", "returns unknown when Stripe is unreachable"; main's spec has no `chargeSettlement` model). F4 #684 turns all 9 green (green at `d3e8ceb2`). Every other check is green.

Not taken (optional): Opus C-683-4 (bounded reconcile reads), Sol C-683-4 (booked vs actual platform-cash naming). Residual: a converted charge's chargeback notice still states the settlement amount (Stripe's dispute amount in the client's currency is not stored); refund notices are fixed.

SIZE ASSESSMENT: 2,526 of 3,000 (charge settlement service 2,194 lines, reconciliation, refund reader). Lower than round 11 because the spec moved to F4b.

READY FOR AUDIT (red by design: build-and-test, the 9 tests above; F4 #684 turns them green)
