AUDIT Claude Opus 5.5 — growth-project-backend#661 @ bc399edd5911c9c1e83e4bb1051fde05bfeda64d — VERDICT: REQUEST CHANGES

A/B/C = 0/1/7

Lens: AUD-OPUS-661D-120 (operator agent 120), conflict-resolution delta after the recurring stack landed on main. Tier T4: money, entitlement and stored payment credentials on the webhook path.

**Independence:** the other lens's verdict for this round was not read before posting. One disclosure: shortly before 09:38 PDT, a local `rg` over `ops/reports` unintentionally printed one line of the other lens's report for this round. That line names its finding B-661-14 on the same grant-path credential issue. This lens had already found B-661-15 below from the code before that line printed. No other content was read, and every later search excluded it. B-661-15 and that B-661-14 are likely the same defect, so the operator can dedupe them.

### Scope and evidence reuse (G09)
- **Last Opus APPROVE:** `f80f0088` (5982407688), now void.
- **Delta since then:**
  - `010f9b57` merged recurring `8c925944` into `f80f0088`, with conflicts in the handler and `checkout.service.ts`.
  - `bc399edd` is a clean merge of main `ee55f814`. Its remerge diff is empty.
- **Net patch against main:** line-identical to `f80f0088`'s patch against `b644198b`, except for two hand-resolved hunks.
  - (a) `endSubscriptionPurchase` (`checkout-webhook-handler.service.ts:1773-1830`) always spreads `CLEARED_PAYMENT_SECRETS` (`:1808`). This replaces recurring's unpaid-only erase. `ending` (status and Stripe `canceled_at`) and `...trial` are kept.
  - (b) A `purchase &&` guard on the recurring early return in `applyPaymentIntentSucceeded` (`:1875-1877`).
- **Reused from the 118 audit:** 11 of the 16 files are blob-identical to `f80f0088`, and main did not touch them. The other 5 were read in full: the handler, `checkout.service.ts`, `payment-ops.controller.ts` and the two spec files. Main changed them, and the #661 lines in them are unchanged.
- **Size:** 2,849 / 3,000 (grandfathered).

### Both sides kept
- **H1, end of a plan.** A paid plan, an `updated -> canceled`, a carded trial and a redelivered end all come out as follows:
  - canceled, with Stripe's `canceled_at` and `trial_started_at`;
  - drops canceled through `cancelPendingForPurchase(..., 'subscription_canceled')`, and dunning terminated;
  - credentials erased.

  An unpaid attempt that Stripe expired becomes `incomplete_expired`.
- **H2, `payment_intent.succeeded`.** A pending native row is `subscription_invoice_owned_by_invoice_paid`, with no write, no fanout and no split. When no row holds the PaymentIntent, the result is `no_matching_purchase`. A row already active through invoice.paid is not activated again.
- **H3, `payment_intent.payment_failed`.** Recurring's return (`:2072-2086`) sits after the #661 metadata-fallback CAS and before the `PI_FAILED_CLAIMABLE` fence (`:2088`). C-661-3 item 1 is therefore satisfied.
  - A settled native row whose Stripe prefetch failed is claimed, and is never a 503.
  - The same holds with no prefetch at all.
  - A never-entitled attempt gets `last_error` only.
- **Reply codes still reach the client.**
  - `RECURRING_REQUIRES_SUBSCRIPTION` (`checkout.service.ts:544-551`) is checked before the `pi-` replay (`:567-577`).
  - Subscription keys use the `sub-` namespace, so `classifyPaymentReplay` (`:130`) never sees a native row.
  - 409 `PAYMENT_ALREADY_COMPLETE` / `PAYMENT_REFUNDED_OR_IN_REVIEW` / `PAYMENT_CHECKOUT_CLOSED` and 503 `PAYMENT_IN_PROGRESS` are unchanged.
  - `PAYMENT_SUCCESS_RETRY` / `PAYMENT_FAILURE_RETRY` are 503s (handler `:118-133`).
  - The exception filter on main still passes `error` and `code` through.
  - `checkout.service.spec` and `b-recur-subscription-checkout.spec` pass.
- **No route returns credentials.** `planView`, `alreadyActive` and `alreadyIncluded` are allow-lists, and data export has no purchases.
- **C-656-1** is a trials ledger obligation. This PR does not affect it.

### B finding
**B-661-15: a native first grant never erases the spent PaymentSheet credentials.**
- **Where:**
  - `checkout-webhook-handler.service.ts:1643-1655`: the `customer.subscription.updated` grant write.
  - `:2285-2296`: the `invoice.paid` grant write.
  - No `CLEARED_PAYMENT_SECRETS` is spread on either. It is used only at `:1486`, `:1808`, `:1909` and `:1998`.
- **Effect:** every active or trialing plan keeps its first-invoice `pi_…_secret_…` or trial `seti_…_secret_…`, plus the `ek_` key, at rest until the plan ends.
- **Why it is a B:** the body's promotion trigger C-661-3 binds the second lander, now #661, to keep `...CLEARED_PAYMENT_SECRETS` "on the stack's activation path (invoice.paid -> active / trialing)". It is a B, not an A, because no route returns the credentials. Nothing after the grant reads them: replay answers `SUBSCRIPTION_ALREADY_ACTIVE`, and `attachNativeTrialCard` returns ok for entitled rows.
- **Probe:** `test/aud-opus-661d-120-hunks.spec.ts`, the real handler with the recurring fakes, in [lane run 37343688493](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343688493) at `9ddda117` (tsc green, PostgreSQL 16.15). The result is 3 failed / 244 passed, and exactly G1, G2 and G3 fail:
  - G1: invoice.paid first grant. Received `"pi_first_secret_canary"`.
  - G2: subscription.updated wins the race with invoice.paid. Received `"pi_first_secret_canary"`.
  - G3: carded trial grant. Received `"seti_trial1_secret_canary"`.
  - G4 is the control: an uncarded trial keeps its SetupIntent secret. It passes.
- **Fix rule:**
  - Spread `...(entitled ? CLEARED_PAYMENT_SECRETS : {})` in both grant writes. Never erase on a $0 trial invoice before the card is saved (G4).
  - Add tests G1 to G4.
  - Fix sketch: those two lines on this tree pass 36 suites / 539 tests, covering every handler and subscription spec plus `checkout.service`, with tsc green, in [lane run 37344323196](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344323196).

### C findings
- **C-661-15 (test gap on hunk a):** no test on this tree pins the new erase on a paid or ended native plan. H1a, b, d and e fail on main `ee55f814` ([control run 37343795035](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37343795035)), which proves the behaviour changed. Rule: add H1a and H1d with the B-661-15 tests.
- **C-661-16 (C-661-3 item 2):** `prefetchFailedPaymentIntentStatus` (`:1096-1124`) still reads Stripe for a settled native row (probe H3d), and the in-tx recurring return never uses the result. Rule: return `{}` when `billing_type === 'recurring' && stripe_subscription_id`.
- **C-661-17:** the settlement bump `updateMany({ stripe_payment_intent_id, entitlement_active: true })` (`:1885-1888`) also bumps active native rows. A concurrent `invoice.payment_failed` then fails its `writeVersion` check (`:2418`), which costs one redelivery. Rule: add `billing_type: { notIn: ['recurring'] }, stripe_subscription_id: null`.
- **C-661-18:** a finished one-time `pi-` key whose package later became recurring answers `RECURRING_REQUIRES_SUBSCRIPTION` instead of its 409 replay code (`checkout.service.ts:544` before `:577`). Rule: classify a finished `pi-` row before the guard, and keep the guard ahead of any PaymentIntent create.
- **Carried:**
  - C-661-2: the backfill, which now should include native subscription rows that already hold credentials.
  - C-661-10.
  - C-661-13: the body is stale. It says round 7 and 3,121, and lacks the restack.
  - C-661-14.

### CI at this head
- 18 success, 1 skipped (`deploy-readiness-gate`), 0 failed.
- build-and-test: 773 suites / 13,255 tests.
- mwb-3: 8 suites / 71 tests.

### Replays
Lane run 37343688493 replayed the following on the composed tree, and all pass:
- this lens's 118 real-PostgreSQL probe;
- the dead 117 Sol R6 probe;
- `checkout-settlement.live`, `checkout-settlement-round5` and `checkout-hosted-activation-once`, which supersedes the 116 DEFECT probe;
- five recurring and webhook specs.

REQUEST CHANGES: B-661-15. The other conflict resolution is correct.
