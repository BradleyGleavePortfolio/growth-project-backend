https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5976246125
2026-10-04T03:42:16Z
AUDIT GPT-6.1 Sol — growth-project-backend#680 @ 2b10687c63cf02e0181339b684634ff9cfbeb803 — VERDICT: REQUEST CHANGES

A/B/C = 0/4/0

Full T4 audit of this piece only: all seven changed files (304 source / 2,610 tests; 2,914 changed lines), the complete webhook handler, transaction/dedup/settlement/fanout call sites, and the specified composition seams were read; no code rests on inherited approval because Sol never approved original #654. [Candidate scope](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680)

### Prior Sol findings first

- The reported B-654-5 narrowed / B-654-8 regression cases pass on this composed head; R2 owns their implementation audit, not this verdict. Builder failing-before evidence was inspected (19 failed / 1 passed), and all 20 round-3 tests now pass in this lane's own execution. [Failing-before proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172350469) [Independent exact-source execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)
- B-654-9's three R3 diagnostic sinks close: independent arbitrary message/name/code canaries pass for lookup failure, failed card attach and no-tx subscription fanout; failed lookup/attach still request redelivery. B-654-1's reported lookup-loss case also stays closed; no repo-wide logging-cleanliness claim is made for unchanged main-era sinks. [Executed canaries and redelivery controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)

### B-680-1 — unordered subscription snapshots can restore canceled access or revoke a paid plan

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:1000–1039`, including the new native entitlement and first-fanout path. [Activation write](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2b10687c63cf02e0181339b684634ff9cfbeb803/src/checkout/checkout-webhook-handler.service.ts#L1000-L1040)

**Counterexamples:** a paid native subscription is deleted, then an older `updated(active)` snapshot changes it back to active/entitled and invokes first-entitlement fanout; separately, `invoice.paid` grants access, then older `created(incomplete)` removes it. Both acceptance assertions fail against the real handler with distinct event IDs, while the chronological activation/deletion control passes. [Executed two ordering failures](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)

This is not deduplication of the same event and cannot be fixed by an event-ID unique constraint; Stripe expressly does not guarantee delivery order and warns that second-resolution `created` is not a total-order fence. [Stripe webhook contract](https://docs.stripe.com/webhooks)

**Minimal fix:** give the native lifecycle canonical subscription authority resolved out of the transaction, plus a terminal-state/revision fence rechecked under the write lock; stale active/trialing events cannot revive canceled/expired attempts, and stale incomplete snapshots cannot revoke a paid current subscription. Unknown authority must retain retryability, not commit a guessed entitlement; preserve atomic grant/revoke/fanout and do not introduce Stripe HTTP in the outer transaction.

### B-680-2 — the new first-attempt guard sends late first-invoice failures and expired attempts into dunning

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:71–78,1450–1488`. The new helper tests today's row state rather than the invoice's origin or terminal attempt history. [First-attempt guard and mutation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2b10687c63cf02e0181339b684634ff9cfbeb803/src/checkout/checkout-webhook-handler.service.ts#L1450-L1488)

**Counterexamples:** after `invoice.paid` for `in_first`, the delayed `invoice.payment_failed` for the same first invoice (`billing_reason=subscription_create`) changes active to past_due and calls `recordFailure`; after deletion marks an unpaid native attempt expired, the same late decline changes expired to past_due and calls dunning. Both assertions fail; pending first-attempt and genuine `subscription_cycle` renewal controls pass. [Executed two failure-origin counterexamples](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)

**Minimal fix:** recognize the first invoice independently of the current purchase status, preserve terminal never-entitled attempts, and never start/reopen renewal dunning from a settled earlier invoice; keep genuine post-trial/renewal failures eligible. Add both delivery-order regressions here, then the second of recurring/dunning to land must unify this rule into one helper, retaining trial-start history. Do not count a future neighboring PR's different helper as a fix at this head.

### B-680-3 — first entitlement is not first payment

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:1035–1056,1402–1406` (new calls), using `maybeEmitFirstPayment:246–263`. [New notification call](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2b10687c63cf02e0181339b684634ff9cfbeb803/src/checkout/checkout-webhook-handler.service.ts#L1035-L1056)

**Counterexamples with `FEATURE_ROMAN_FIRST_PAYMENT=true`:** saving the card for a free trial inserts the once-per-coach payment record and emits two payment notifications for 4,900 cents although nothing was paid; real first paid conversion after an already-entitled trial never calls the primitive; a combo first invoice paying 14,800 cents records the 4,900-cent renewal snapshot. All three acceptance assertions fail using the real `CoachFirstPaymentService` and `FirstPaymentEmitter` (only storage/notification transport are doubles). [Executed financial-truth failures](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)

**Minimal fix:** separate content's first-entitlement effect from money's first-positive-paid-invoice effect; do not consume the first-payment key for a trial/zero-due invoice or merely active subscription. Invoke the idempotent money primitive from an authoritative positive `invoice.paid` even when trial entitlement already exists, with the actual paid amount and currency, while keeping its rows on the same transaction.

### B-680-4 — conversion-first delivery permits a second trial with the same coach

**File:line:** `src/checkout/checkout-webhook-handler.service.ts:54–63,1031,1384`; native eligibility consumes `ClientPurchase.trial_started_at` in the inherited checkout decide step. [New trial marker rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/2b10687c63cf02e0181339b684634ff9cfbeb803/src/checkout/checkout-webhook-handler.service.ts#L54-L64)

**Counterexample:** actual native checkout creates a seven-day trial, the card is saved, and the trial's `trialing` delivery is delayed; the active paid-conversion update arrives first with Stripe `trial_start/trial_end`, then deletion arrives. The real handler grants access but never stamps usage because it only stamps `status=trialing`; the real checkout then grants another seven-day trial on another package of the same coach. The acceptance assertion receives `trialPeriodDays=7` instead of no trial. [Executed checkout/lifecycle sequence](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)

**Minimal fix:** persist consumed trial history from authoritative carded/started trial evidence even when the first observed lifecycle state is active or the trial has already converted; preserve the consumption marker through cancellation and reject a second coach/client trial. This native bug needs a fix here, separately from the later trials-stack single-ledger integration obligation.

### Evidence, piece boundaries and landing obligations

- Test-only probe source `198126cce648a747f99ec77f3c17f7a1854a3d25` differs from the candidate only by the independent spec; the lane wrapper adds its workflow/selector, not product-source changes. Execution: **8 acceptance failures / 159 passing tests**, including **all seven selected candidate suites / 150 candidate tests** and **nine independent controls/canaries**; no compiler/fixture failures. These are actual-service synthetic DB/provider probes, not live Postgres/Stripe or a claim of device acceptance. [CI-lane proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)
- No migration/dependency change or import of a later piece; first-invoice PI ownership, card-before-trial entitlement, failure redelivery, per-charge deferred settlement and transaction-propagated fanout failure controls pass. The original callback plumbing's snapshot overwrite was pre-existing, but B-680-1 makes the new native grant/revoke path unsafe and is therefore material rather than optional unrelated debt. [Executed controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174541947)
- C-661-3 remains the binding integration obligation: whichever stack lands second keeps the recurring PI early return before the new one-time decline fence and clears PaymentSheet credentials on recurring activation and both subscription-deletion branches. It is not a newly counted finding. [Existing credential composition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661)
- C-656-1 remains binding: native checkout currently sells trials using `ClientPurchase` history while the trials stack introduces another usage ledger/capability; the second stack to land must integrate reservation/start/release and capability registration into one ledger before coach-set offers ship. No other PR was audited here. [Existing trials composition](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5976081090)
- **Fix placement / size:** only 86 lines remain before 3,000. Keep the webhook fixes and their new regressions in R3; move the 432-line R2-service round-3 regression file to a new inert top test piece (and another service-only suite if needed), retain the complete combined test tree, and land/deploy the repaired stack as one. Recount before push; neither deleting tests nor crossing 3,000 is acceptable. [Current 2,914-line size](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680)
- All seven emitted applicable required contexts are green at this head; CodeQL/danger/Banned cast tokens/build-sbom remain unrun main-retarget/composed-tree gates, not 11/11 passed checks. The independent red proof above blocks approval despite ordinary green CI. [Current-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172709393/job/111348792701)
==========
