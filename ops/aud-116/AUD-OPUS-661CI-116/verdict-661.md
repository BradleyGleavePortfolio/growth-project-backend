AUDIT Claude Opus 5.5 — growth-project-backend#661 @ a193d7e17b2d4daeb944891191824d08e280b437 — VERDICT: REQUEST CHANGES

A/B/C = 0/1/3

Lens: AUD-OPUS-661CI-116 (operator agent 116). Tier T4: money-path credentials, entitlement and webhook ordering. The PR body says T4; this lens agrees. This lens has no verdict since 91625c86 (REQUEST CHANGES 0/1/3), so this is a full audit at this head:
- Read: all 12 files of the PR diff against main d23fa317 (+1343/-103).
- Read line by line: round 2 (f4679fd8) and round 3 (fcf0d4c3, 57fa2402).
- Traced: every call site of `applyPaymentIntentSucceeded`, `applyPaymentIntentFailed` and `prefetchForOuterTx` through `BillingService.handleEvent` and `StripeWebhookController`.
- Merge check: a193d7e1 is the automatic merge of 57fa2402 with main d23fa317. `git merge-tree --write-tree 57fa2402 d23fa317` gives tree `ef3801c0`, the same as a193d7e1's tree, and main touched none of the 12 files.
- All 11 required checks are green at this head. The PR is BEHIND main f57baba3 (#664, deps only), so a merge-only delta follows.
- Evidence reuse: none. Every line was audited at this head.

### Prior findings of this lens
- **B-661-1 (Opus): closed for PaymentSheet rows.** A decline followed by a successful retry of the same PaymentIntent now ends `paid` and entitled, erases the credentials and defers the split with the charge id. Covered by the test `B-661-1 decline, then a successful retry...` in `test/checkout-webhook-handler.spec.ts`. The status predicate that closes it is too wide, though: see B-661-5.
- **C-661-4: closed.**
  - `PAYMENT_REFUNDED_OR_IN_REVIEW` replaces "checkout has closed" for refunded and disputed purchases.
  - The race loser now gets its answer on the first settled poll (`waitForReservedSecret` plus `classifyPaymentReplay`).
  - The mobile PaymentSheet pieces still have to map the three 409 codes. That is a mobile item.
- **C-661-2: still open, operator decision.** The historic backfill is unchanged. The read path no longer depends on it: the status is classified before any cached credential is returned.
- **C-661-3: still open, merge-order item.** The body names it correctly for the #678-#680 split, including #680's early return in `applyPaymentIntentFailed`.

### Verified at this head
- **Responses:**
  - Owner/admin list, detail and dunning view/actions use `ADMIN_PURCHASE_OMIT` (Prisma 6.19 `omit`, which can be combined with `include`).
  - The client list uses an allow-list.
  - Replay returns credentials only to the owning client (the key is namespaced by client id), and only for `pending` / `payment_failed` rows.
  - No 409 or 503 body carries a credential.
  - Re-swept main's changes since 91625c86's base (53b6d472..d23fa317, including account deletion billing and the deletion manifest): no new route returns a raw ClientPurchase row. The data export does not read ClientPurchase at all.
- **Logs:**
  - New lines carry ids plus `stripe_<http>_<code>` or the error class only.
  - `BillingService` logs the 503's fixed message.
  - Key and value redaction applies to every AppLogger line.
- **Late decline vs successful retry (Sol B-661-3): closed, independently checked.**
  - Interleavings checked:
    - Success commits first: the decline's compare-and-set on `status in (pending, payment_failed)` re-evaluates under READ COMMITTED (BillingService's `$transaction` sets no isolation level), so the count is 0. The re-read sees the purchase settled, and the in-tx path has no prefetched status, so the handler answers 503. The redelivery prefetches `succeeded`, giving `stale_failure`.
    - Decline commits first: the success's unconditional update still wins.
  - Final statuses are never rewritten.
  - A real asynchronous failure after a hosted completion still ends access (Stripe reports `requires_payment_method`).
- **Stripe HTTP stays outside the DB transaction:**
  - The decline prefetch runs before `$transaction` and never throws.
  - Inside the tx a missing status throws instead of calling Stripe.
  - Only the no-tx legacy path calls Stripe inline.
- **503 redelivery:**
  - `StripeWebhookController` propagates the exception.
  - `BillingService` rolls back the `StripeProcessedEvent` row together with the domain writes, so the redelivery is processed again.
  - Nothing is written before any `declineRetryLater` throw.

### B-661-5 — `payment_intent.succeeded` now claims hosted-Checkout purchases that a decline adopted: duplicate activation on the live purchase path
- **Where:**
  - `src/checkout/checkout-webhook-handler.service.ts:1019-1021` (`applyPaymentIntentSucceeded`) and `:519-521` (`prefetchChargeIdForActivation`) match `{ stripe_payment_intent_id: pi.id, status: { in: ['pending', 'payment_failed'] } }` (round 2, `PI_SUCCEEDED_CLAIMABLE`).
  - The rows involved come from `:1102-1133`: the metadata fallback adopts a hosted purchase on the first decline (`payment_failed` plus `stripe_payment_intent_id = pi`, unchanged in substance by round 3).
- **Why it matters now:**
  - Mobile main buys through hosted Checkout (`POST /v1/checkout/sessions`), not the PaymentSheet.
  - Hosted payment-mode PaymentIntents carry `tgp_package_id` and `tgp_client_user_id` (`payment_intent_data[metadata]`, checkout.service.ts:408-414, sent by stripe-connect-api.service.ts:491).
  - Before round 2, `payment_intent.succeeded` never matched a hosted row: pending hosted rows have no PaymentIntent id, and the adopted rows were `payment_failed`.
- **Counterexample 1 (one session):**
  1. The first card is declined on the hosted page, so the row becomes `payment_failed` with `pi_h`.
  2. The retry on the same page succeeds.
  3. Stripe usually delivers `payment_intent.succeeded` before `checkout.session.completed`. The PaymentSheet path claims the hosted row: `paid`, entitled, `access_expires_at` stays null (the hosted path computes it from `duration_periods`), and the PurchaseFanout row is stamped `in_app_ps`.
  4. `checkout.session.completed` then re-activates the same purchase (`applyCheckoutCompleted` has no status fence). It runs a second split posting and calls `onPurchaseEntitled` again.
  5. The second activation's `coach_new_purchase` DripResolverMarker INSERT hits its unique index inside the webhook tx (`purchase-fanout.service.ts:424`). PostgreSQL aborts a transaction on any error (it has no implicit savepoint), so BillingService's next statement fails with 25P02. The whole event rolls back and every redelivery fails the same way for Stripe's retry window. This step follows from PostgreSQL semantics; it was not run live.
  6. Result: the purchase's access window is never written (a duration package never expires), and the webhook endpoint fails on this event for 3 days.
- **Counterexample 2 (two open sessions, one per client/package/day):**
  1. A decline of session A's PaymentIntent adopts the newest pending row, which is B.
  2. A's success then activates A through `checkout.session.completed` and B through `payment_intent.succeeded`.
  3. One payment entitles two rows and defers two splits on charge `ch_A` (head-coach transfer per purchase).
- **Probe:** branch `audit/AUD-OPUS-661CI-116/661-hosted-probe` (PR head plus the probe spec only), [CI-lane run 37173615928](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173615928).
  - The run is green (66/66), and green means the defect is reproduced.
  - The spec drives the real `CheckoutWebhookHandlerService` and the real `PurchaseFanoutService` against an in-memory Prisma double modelled on the PR's own spec double (where predicates are honoured).
  - It shows both counterexamples: the PaymentSheet claim of the hosted row, `access_expires_at` null, entrypoint `in_app_ps`, two `onPurchaseEntitled` calls, the marker unique violation on the second activation, and B activated on A's charge.
  - It also has a control: the PaymentSheet decline-then-retry still works.
- **Minimal fix rule:**
  - `payment_intent.succeeded` and its charge-id prefetch may claim a `payment_failed` row only when it is a PaymentSheet purchase: `stripe_checkout_session_id` equals the PaymentIntent id, which is how `createPaymentIntentForClient` writes it.
  - Hosted Checkout rows are activated only by `checkout.session.completed`.
  - Keep `pending` as it is.
  - Tests:
    - Hosted decline, then a successful `payment_intent.succeeded`: `claimed: false` and the row untouched. Then `checkout.session.completed` activates once, with `access_expires_at` set and a single `onPurchaseEntitled` call.
    - The two-session case: B is never activated.
    - The PaymentSheet decline-then-retry stays green.
  - Failing-before through the CI lane.
  - Whoever merges second with #678-#680 applies the same rule to recurring PaymentSheet rows.

### C findings
- **C-661-6 (optional, cheap):** `lookUpPaymentIntentStatus` (`:577-588`) treats every error as transient. A permanent Stripe 404 (`resource_missing`) on a settled purchase therefore answers 503 for Stripe's whole retry window, while the purchase stays paid (fails safe). Consider treating a 4xx other than 429 as a logged no-op (`reason: 'payment_intent_unreadable'`). Test it with a mocked `StripeConnectApiError(…, 404, 'resource_missing')`.
- **C-661-7 (outside this diff):** `applyCheckoutCompleted` has no status fence. A late `checkout.session.completed` re-activates a refunded, canceled or already-activated purchase. It is not the fix for B-661-5: fencing there alone would leave the access window unwritten. It is a second line of defence for the operator's list.
- **C-661-2 / C-661-3:** still open as above (operator backfill; merge-order note).

APPROVE once B-661-5 is closed with code and a failing-before test. The B-661-3 design and the credential, response and log boundaries hold at this head.
