# B-GUEST-126: guest checkout money fix (Claude Opus 5.5 builder, T4 money), agent 126 fleet
Started 18:17 PDT 10-06 (from `TZ=America/Los_Angeles date`). Hard stop 19:35. Status: DONE (18:41 PDT). b#816 READY FOR AUDIT, CI green.
Worktree /home/user/workspace/wt/B-GUEST-126-backend, branch agent126/b-guest-126 from origin/main 2df556b7 (src/storefront and
src/billing unchanged since f71bb9a4). Source audit: /home/user/workspace/ops/reports/AUD-MJ-BILL-126.md.

## Scope traced
- POST /v1/packages/public/join/:token/checkout (storefront-public.controller.ts:280) -> GuestCheckoutService.createIntent: PaymentIntent
  created unconfirmed, no payment method (guest-checkout.service.ts createPaymentIntent call; recurring = default_incomplete sub).
- POST /v1/webhooks/stripe -> BillingService.handleEvent: payment_intent.succeeded -> handlePaymentSucceeded (billing.service.ts:454),
  payment_intent.payment_failed -> handlePaymentFailed (:489), subscription/invoice fallback -> handlePaymentSucceeded (:715, only for
  pending/retryable rows, :808-816).
- Crons: lost-webhook-reconcile (lost-webhook-reconcile.service.ts:54, scans pending only), guest-checkout-reconciliation
  (paid orphans + retryable -> reconcilePaidCheckout -> convertGuestToUser).
- convertGuestToUser: pre-check status 'paid' (read), Supabase user, destination account, tx (user upsert, ClientPurchase, converted
  write, fan-out), then flushAlerts + welcome email (raw Resend POST, no idempotency).
- Storefront web UI is not in either repo (mobile uses in-app POST /v1/checkout/sessions). Thank-you page keys on session_id (in-app).

## Verification (item 1)
CONFIRMED in code and by spec. createIntent returns a client secret for an unconfirmed PI. The poller flips a `requires_payment_method`
one-time row to 'failed' on its first poll, 30-90 s after creation (lost-webhook-reconcile.service.ts:179-216); a decline flips it to
'failed' (guest-checkout.service.ts:1074-1080 on main). The buyer can still pay on the same PI, but the success claim was
`status: 'pending'` only (:919-931 on main), so the webhook returned "duplicate" and nothing was created. The decline-then-retry path
reproduces regardless of when the storefront creates the intent. Spec cases 1-3 fail on main (status stays failed/terminal, 0 purchases).

## B list
- B1 (FIXED in b#816): a buyer who takes a minute to type the card, or whose first card is declined and who tries another, is charged by
  Stripe but never gets an account, purchase or email.

## U list
- U1 (FIXED in b#816): a paid guest can receive the welcome/receipt email twice when the webhook and the reconciler (or a retry) both
  convert the same checkout (converted write was unconditional, guest-checkout.service.ts:1645 on main).

## C one-liners (edge, deferred to 10k clients)
- C (edge, deferred to 10k clients): a slow buyer whose row was set 'failed' by the poller AND whose success webhook is lost is not
  rescued by the poller (it scans pending only).
- C (edge, deferred to 10k clients): a buyer who pays more than 24 h after opening checkout (expires_at) is still refused.
- C (edge, deferred to 10k clients): poller reconcile_attempts double-counts under two scheduler copies (AUD-MJ-BILL-126 C list).

## Noticed, not verified (for the operator, not built)
- Recurring guests: customer.subscription.created for the just-minted (incomplete) subscription can reach the subscription fallback
  (billing.service.ts:706-722 + maybeResolveGuestBySubscriptionEvent :808-816), which calls handlePaymentSucceeded on the still-pending
  row, so the account and "You're enrolled" welcome email may go out before the buyer pays (entitlement stays off while the sub is
  incomplete). Possible U (false claim in email). Smallest check: in maybeResolveGuestBySubscriptionEvent only return the sentinel when
  the event's subscription status is active/trialing (or the invoice is paid). Not touched here (outside this job, T4 money).

## Covered by open PRs
- None. No open backend PR touches src/storefront or src/billing (b#810 ScheduleModule fixes the double-scheduler half of U1 only).

## PRs opened
- b#816 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/816, branch agent126/b-guest-126,
  head 16d1602810f45d61516479febe4209105712a8bd, 3 files +305/-11 = 316 lines (45 in src). CI: all 16 checks green (18:40).
  READY comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/816#issuecomment-6029045951
  Local: new spec 6/6 (5 fail on main), guest-checkout.service.spec 58/58, pr14-guest-recurring-lp-attribution 11/11,
  lost-webhook-reconcile 4/4, pr14-recurring-reconciler-branch 5/5, guest-checkout-reconciliation 4/4; eslint clean on changed files.

## Not fixed (needs operator)
- None required for this job. Optional: the recurring "email before payment" item above.

## HANDOFF
Done. b#816 open at 16d1602810f45d61516479febe4209105712a8bd, CI green, FIX ROUND 1 (OPENING) READY comment posted 18:40.
Worktree /home/user/workspace/wt/B-GUEST-126-backend removed (all work pushed). No ci/* branches, no locks. Next owner: the T4 lens
pair at that exact head; if a lens asks for changes, recreate the worktree from origin/agent126/b-guest-126.
