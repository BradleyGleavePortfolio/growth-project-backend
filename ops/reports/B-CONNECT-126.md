# B-CONNECT-126 — a coach Stripe just approved can take payments
Worker B-CONNECT-126 (Claude Opus 5.5, BUILDER, T4 money), agent 126 fleet. Started 18:51 PDT 10-06 (TZ=America/Los_Angeles date).
Hard stop 19:40. Source finding: /home/user/workspace/ops/reports/AUD-MONEY-E2E-126.md B1.
Status: DONE 19:11 PDT. b#821 CI green, READY FOR AUDIT comment posted.

## Scope traced (screens + routes)
- Client Buy (one-time): POST /v1/checkout/payment-intent -> checkout.service.ts createPaymentIntentForClient payout gate (main :594-610).
  Also POST /v1/checkout/sessions -> createCheckoutForClient gate (main :275-291), same saved-row read; mobile packagesApi.ts:719 calls it.
- Client Buy (recurring): POST /v1/checkout/subscription-intent -> subscription-checkout.service.ts gate (main :261-279).
- Coach payout screens (GetPaidPanel, MoneyHomeCard, MoneyScreen, setupStatus): GET /coach/connect/status -> coach-connect.service.ts
  getStatus (main :191). "Check status again": POST /coach/connect/status/refresh -> refreshStatus (main :241).
- Reused helper: connect.service.ts syncFromStripe (b#750) — catches StripeConnectApiError (incl. 10 s timeout mapped to 503) and
  returns the untouched row; rethrows other errors.

## B list
- B1 (from AUD-MONEY-E2E-126): a coach finishes Stripe onboarding while Stripe is still checking them, Stripe approves minutes later,
  and the coach's screen keeps saying "Stripe is checking your details" while every client Buy is refused, until the coach taps
  "Check status again". FIXED in b#821.

## U list
- U1 (folded into B1): payouts enabled at Stripe after the return still read "Stripe sends payouts to your bank once it has finished
  checking". FIXED in b#821 (status re-syncs while charges or payouts are off).

## C one-liners
- C (edge, deferred to 10k clients): the cooldown map is per process and unbounded by coach count (one entry per not-ready account).
- C (edge, deferred to 10k clients): a hung Stripe read can hold one Buy up to the existing 10 s client timeout, at most once per
  account per 60 s.

## Covered by open PRs
- None. No open backend PR touches src/connect, src/coach-connect or src/checkout (gh pr list 18:52 PDT).

## PRs opened
- b#821 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/821 — branch agent126/b-connect-126,
  head b9ada9f888107b6977387d3b56cdbc7dda19259f, 372 + 12 = 384 lines (src 84 incl. comments, tests 300), 6 files. CI: all required checks green at b9ada9f8 (deploy-readiness-gate skipped). READY comment:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/821#issuecomment-6029417953
- Fix: ConnectService.refreshNotReady(row) (syncFromStripe + CONNECT_NOT_READY_SYNC_COOLDOWN_MS = 60 s in-process per Stripe account;
  any failure -> saved row + `code=CONNECT_NOT_READY_SYNC_FAILED class=stripe|other`, coach id only). Called by both checkout gates
  (CheckoutService.payoutGateRow) and the subscription gate only when the saved row says charges off and not deauthorized, and by
  CoachConnectService.getStatus when charges or payouts are off. refreshStatus passes syncIfNotReady=false (no double Stripe read).
  CheckoutService / SubscriptionCheckoutService take ConnectService as @Optional() last ctor arg (always injected in the app).
- Tests: test/b-connect-126-not-ready-sync.spec.ts (10) + 3 in test/checkout.service.spec.ts. 5 fail on main src, all pass here.
  Existing specs pass locally: checkout.service (45), b-recur-subscription-checkout (29), coach-money.service (55),
  coach-connect.service (10), coach-connect-refresh-closed-codes (3). Targeted eslint clean.

## Not fixed (needs operator)
- None for B1. Long-term (from the audit, not needed for this fix): a Connected-accounts webhook destination plus a third accepted
  secret in stripe-signature.ts:156 so account.updated / payout.* arrive.

## HANDOFF
- Done 19:11 PDT. Worktree /home/user/workspace/wt/B-CONNECT-126-backend removed (clean, all work pushed). No ci/* branches, no locks.
- Branch agent126/b-connect-126 @ b9ada9f888107b6977387d3b56cdbc7dda19259f on origin. Next: dual T4 lens audit (Opus + Sol) at that
  head, then merge and deploy (operator). Backend-only; no APK dependency.
