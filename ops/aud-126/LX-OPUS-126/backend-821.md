# SKIPPED (not posted): another Opus lens posted at b9ada9f8 first (19:13 PDT). Draft kept.

AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-backend#821 @ b9ada9f888107b6977387d3b56cdbc7dda19259f — VERDICT: APPROVE

B=0 U=0 C=3. T4 money (Buy payout gate and the coach's Connect status). CI at this head: all green (build-and-test incl. tsc and full suite, danger, R75, schema parity, CodeQL, rls/community/mwb-3 live, npm audit, test-deploy-readiness). Size +372/-12 (6 files, about 300 test lines).

Checked:
- `ConnectService.refreshNotReady` (connect.service.ts): a deauthorized row is returned as is. There is a 60 s per-Stripe-account cooldown, set before the call, so a failing Stripe call is not retried in a loop. The re-read goes through the existing `syncFromStripe`, which is the same mirror update as the account.updated webhook (country, currency, charges/payouts/details, requirements, disabled_reason), with no other side effects. On a Stripe rejection it returns the saved row (syncFromStripe catches StripeConnectApiError). Any other error is caught, logged with the coach id only (`CONNECT_NOT_READY_SYNC_FAILED class=...`, no Stripe text or secrets), and the saved row is returned. The Buy path never gets a new exception.
- Buy gates: one-time (checkout.service.ts createPaymentIntentForClient :288-305 and createCheckoutForClient :607-624) and recurring (subscription-checkout.service.ts :265-290). A saved ready row is unchanged and makes zero Stripe calls. A not-ready row is re-read once, then the same `charges_enabled && !deauthorized_at` test decides. If it is still not ready, or Stripe failed, the client gets today's 409 COACH_NOT_PAYOUT_READY and nothing is charged. The refreshed row has the same stripe_account_id, so the destination charge and fee path is unchanged.
- GET /coach/connect/status re-reads when charges or payouts are off. POST .../refresh passes `syncIfNotReady=false` after its own sync, so there is no double Stripe read. The response shape is unchanged. The coach's home (StripeSetupBanner, CoachSetupChecklist, MoneyHomeCard) calls this on mount, so a coach Stripe approved after the return reads ready the next time they open the app.
- DI: ConnectService is exported by ConnectModule and imported by CheckoutModule. `@Optional()` only covers hand-built tests, and the boot check (test-deploy-readiness) is green.
- No widening: no state that was refused before becomes payable unless Stripe itself says charges are enabled.

C (none block):
- C: share-link guest checkout and the storefront GET (storefront/guest-checkout.service.ts:262-275) still read only the mirror. In practice the mirror updates as soon as the coach opens the app (status read) or any in-app Buy happens. Smallest fix if wanted: call `connect.refreshNotReady(connectAccount)` in that gate when `isConnectAccountReadyForCheckout` is false.
- C: the cooldown map is per process and never pruned. It holds one entry per not-ready Stripe account, which is bounded by the coach count.
- C (edge, deferred to 10k clients): a coach whose payouts stay off for weeks costs one Stripe retrieve per minute per machine while their home screen is opened.
