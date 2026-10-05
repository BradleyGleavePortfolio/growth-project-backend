# notes AUD-OPUS-F34-116
- F3/F4 files byte-identical to #627@3a5338d7 (Opus APPROVE 0/0/1) and to merge-tree(66162285,d23fa317)=09de2bff; round 10 touched only transfer-orchestrator.service.ts (F2) + r9 spec (F5).
- F3 CI 37151662477 build-and-test red: checkout-webhook-fee-split (2), purchase-split-handler (2), reconciliation.service.spec (5, TypeError prisma.chargeSettlement undefined in main's stub; F4 carries stub). Checkout spec green (F1 carried). Stated reason omits reconciliation, names checkout -> C.
- charge-settlement.service.ts read fully (2075 lines).
- C cand: currency unit mix. settleChargeLocked:589 refunded from charge.amount_refunded (presentment) + succeededRefundCents (refund rows) vs gross from bt.amount (settlement ccy). packages.service.ts:679 accepts any ISO code via API; mobile editor always 'usd' (CoachPackageEditScreen.tsx:314). Latent -> C.
- F2 reverse contract: succeeded | refused(definitive) | throws ReversalUncertainError -> F3 convergence correct.
- COPY first person in F4: payout-notice.service.ts:543 "We could not find..." ; coach-payout-adjustment.hbs:20 "We take it out of your next payout". OPERATOR_STANDING_ORDERS.md:41. -> B-684-1 (cheap)
- F2 (not mine) payout-notice-copy.ts:67,79,93,101 "We will hold/We took/We paid/We freed" -> report for operator (F12 job).
