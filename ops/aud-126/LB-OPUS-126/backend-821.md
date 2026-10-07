AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#821 @ b9ada9f888107b6977387d3b56cdbc7dda19259f — VERDICT: APPROVE

A=0 B=0 C=2. CI: green at this head (15 SUCCESS, 1 SKIPPED); mergeable state unknown. Size 384 lines (372+/12-), 76 of them in src.

**T4 money checks**
- Buy gates: `createPaymentIntentForClient` and `createCheckoutForClient` (`checkout.service.ts`) and `createSubscriptionIntent` (`subscription-checkout.service.ts`) all keep the exact same refusal. It is `!charges_enabled || deauthorized_at`, giving 409 `COACH_NOT_PAYOUT_READY`.
  - The only change is that a row that is not ready and not deauthorized is first re-read from Stripe.
  - A ready row makes no Stripe call and no write.
  - A Buy is let through only when Stripe itself now reports `charges_enabled`, so nothing is opened that Stripe has not enabled.
- The write: `refreshNotReady` goes through the existing `syncFromStripe`, the same mirror update the account.updated webhook makes (country, currency, charges, payouts, details, requirements, disabled_reason).
  - It writes no money, ledger or notification, and never touches `deauthorized_at`.
  - On a Stripe rejection of the retrieve (for example a deauthorized or unknown account), `syncFromStripe` returns the saved row, and any other error is caught and logged with the coach id and error class only. The Buy then gets today's refusal, never a 500.
- Fan-out: at most one re-read per Stripe account per 60 s per process (`CONNECT_NOT_READY_SYNC_COOLDOWN_MS`). The timestamp is set before the call, so a client tapping Buy repeatedly or concurrent requests cannot fan out Stripe calls. An account retrieve costs no money.
- Coach status:
  - `GET /coach/connect/status` re-reads only when charges or payouts are off and the row is not deauthorized, and the response shape is unchanged.
  - `refreshStatus` passes `syncIfNotReady=false` after its own sync, so there is no double call.
  - A coach Stripe approved after the onboarding return now reads ready, and clients can buy, without tapping "Check status again".
- Tenancy: the gate still finds the row by `coach_user_id: pkg.coach_id`. The re-read only refreshes that same coach's mirror.

**C (never block)**
- C-821-1: the cooldown Map is process-local and never evicted (one entry per not-ready account), and with several machines each can make one call a minute. C (edge, deferred to 10k clients).
- C-821-2: a Stripe call that is slow but does not fail adds up to the client timeout (about 10 s) to that Buy or status read, at most once a minute per account.
