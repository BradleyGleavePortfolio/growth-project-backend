AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#816 @ 16d1602810f45d61516479febe4209105712a8bd — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (SKIPPED:1 SUCCESS:15); mergeable clean. Size 316 lines (305+/11-): 45 lines in src, the rest tests.

**B1 (charged, no account) is real on main, and this PR fixes it.**
- On main, a guest PaymentIntent is created unconfirmed before card entry.
- `lost-webhook-reconcile.service.ts:213-216` flips the row `pending -> failed` as soon as the PaymentIntent is `requires_payment_method` after the grace window. A buyer still typing the card, or retrying after a decline, hits this, and so does `payment_intent.payment_failed`.
- Stripe lets the buyer confirm the same PaymentIntent again. The success claim (`updateMany WHERE status='pending'`) then matches 0 rows, so the money is taken and no account, purchase or email is created.
- The fix widens only the success claim, to `pending | failed | conversion_failed_terminal`.
- Rows still refused: `paid`, `conversion_failed_retryable` (the reconciler owns those), `converted`, `refunded`, `disputed`, and expired rows (`expires_at > now` is kept). The spec covers this (case 4).
- Only a Stripe "succeeded" reaches the claim: the webhook, the poller (which calls only on a row it just saw `pending`) or the subscription-active fallback.
- `createIntent` still treats `failed` and `conversion_failed_terminal` as a spent key, so no second client secret is issued for a row and no second charge can start from this change.
- ClientPurchase is find-or-create on (client, package, PaymentIntent id) with a unique Stripe id, so a late claim never makes a second purchase.

**U1 (welcome email twice) is fixed.**
- `paid -> converted` is now `updateMany WHERE {id, status:'paid'}`. The copy that matches 0 rows returns before fan-out, drop alerts and the welcome email.
- The reconciler re-arms `conversion_failed_retryable -> paid` before calling convert (`reconcilePaidCheckout`), so retries still convert.
- The `pr14` spec mock now gives the second updateMany `count: 1`, which matches the new call order.

**Tests.** `test/b-guest-126-guest-checkout-claims.spec.ts` has 6 cases, and 5 of them fail on main. The cases are: decline then pay, slower than the poller, 3DS past the cap, refused statuses and expiry, two conversions giving one email and one fan-out, and the conditional write shape.

**C (never block)**
- C-816-1: if on-call manually refunds a `conversion_failed_terminal` row in Stripe and the original succeeded webhook only arrives after that, the row converts. That needs a webhook delayed past the poll cap plus a manual refund in between. C (edge, deferred to 10k clients).
- C-816-2: the losing copy returns normally inside `$transaction`, so its earlier writes commit (user upsert, purchase find). This is harmless because both are find-or-create. A same-instant race may P2002 and route to `markRetryable`, which is a no-op on a converted row. C (edge, deferred to 10k clients).
