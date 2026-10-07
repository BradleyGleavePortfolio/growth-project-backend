# AUD-MONEY-E2E-126 — one buyer, end to end (money seams + what the human sees)
Worker AUD-MONEY-E2E-126 (Claude Opus 5.5, read-only auditor, T4 money), agent 126 fleet. Started 18:33 PDT 10-06, report final 18:48 PDT
(TZ=America/Los_Angeles date). Hard stop 19:35.
Code: /home/user/workspace/wt/RO-backend @ f71bb9a4, /home/user/workspace/wt/RO-mobile @ 950689af. Backend origin/main is now 35c22212
(b#808, b#810, b#812 merged); `git diff f71bb9a4 origin/main -- src/checkout src/connect src/storefront src/billing src/packages
src/coach-money` is empty, so every money line cited below is unchanged on main. No PRs, no SQL run, no Stripe calls.
SQL for the operator: /home/user/workspace/ops/reports/AUD-MONEY-E2E-126.sql (Q1, Q2, read-only).
Read first and cited, not re-audited: AUD-MJ-BILL-126 (15 SAFE, U J3/R2), AUD-MJ-SETTLE-126 (23 SAFE), AUD-MJ-PAYOUT-126 (15 SAFE),
AUD-MJ-DUNNING-126 (12 + 10 SAFE). Those four only asked whether a job can do the same work twice. This file covers the hand-offs
between them and what the client and coach see.
Status: DONE.

## Flags as they will be (10-07 build)
- Mobile: eas.json "clinic" extends "production", with EXPO_PUBLIC_FF_IOS_HIDE_NON_P2P_PURCHASES=true. 1:1 coach packages, including
  recurring, are sold in-app on iOS and Android through the native Stripe PaymentSheet (purchaseSurfaces.ts:1-17, :84-93;
  PackageCheckoutScreen.tsx:26-28). The Stripe key comes from the backend answer first, then the build (usePackagePurchase.ts:370-372).
- Backend: FEATURE_DUNNING_V2 on, FEATURE_BANK_PAYOUTS_V2 off, settlement sweep on (see the PAYOUT report). Stripe API pinned to
  2024-09-30.acacia (stripe-connect-api.service.ts:19). The platform webhook we_1UMt9WDUoC5CCVhShvAELVmI is also acacia (SoT 3113),
  so the `invoice.subscription` and `invoice.charge` fields the renewal path reads are present.
- Charge model: "separate charges and transfers". The charge is made on the platform with on_behalf_of = the coach's account and no
  transfer_data. The coach is then paid by a Transfer with source_transaction = that charge (charge-settlement.service.ts:44-56;
  checkout.service.ts:697-725; stripe-connect-api.service.ts:551-560; transfer-orchestrator.service.ts:576).

## Trace 1 — one-time package bought in the app
| Hop | Code (file:line) | Client sees | Coach sees | If this hop fails once |
|---|---|---|---|---|
| 1 Buy tap | PackageSelectionSheet / ClientPackagesScreen / PackageCheckoutScreen -> usePackagePurchase.ts:820 buyOneTime -> POST /v1/checkout/payment-intent (checkout.controller.ts:125 -> checkout.service.ts:469) | PaymentSheet opens | nothing | Stripe error: the reservation is deleted (checkout.service.ts:750-765) and the client gets specific copy. A retry with the same key reaches the same PaymentIntent. **Payout gate: checkout.service.ts:594-610 reads the saved ConnectAccount row only. See B1.** |
| 2 Card | Stripe PaymentSheet | decline gives specific copy (packagePayment.ts:469-480) | nothing | a decline flips the row to payment_failed; a retry on the same PaymentIntent is still claimed (checkout-webhook-handler.service.ts:2174-2178, B-661-1) |
| 3 Webhook | POST /v1/webhooks/stripe -> billing.service.ts:166 -> applyPaymentIntentSucceeded (checkout-webhook-handler.service.ts:2154): purchase set to paid + entitled, fan-out inside the tx (:2243-2256), split deferred to after commit (:2241) | app polls GET /v1/checkout/entitlement for ~10 s (usePackagePurchase.ts:769-784), then shows success or "Your payment went through. Your plan can take a minute to show in the app." (packagePayment.ts:607) | push "New purchase / A client bought a package." (lock-screen-copy.ts:108) once per purchase (BILL W2) | the tx rolls back (5xx) and Stripe redelivers. The client's calm pending copy is true. Dedupe: BILL W1 |
| 4 Fan-out | purchase-fanout.service.ts:198 onPurchaseEntitled | programs and drops appear | — | rolls back with hop 3 and is redelivered (BILL W2/J3) |
| 5 Settlement | runDeferredSplit -> purchase-split-handler.service.ts:77 -> charge-settlement.service.ts:511 settleCharge (reads Stripe's real fee; coach_net = gross - Stripe fee - 2%) | — | Money page: sale with "price - processing - TGP 2% = net" (coach-money.controller.ts:33/:44; coachMoneyApi.ts:718-758) | Stripe read fails: an awaiting_fee row is kept and the 15-minute sweep settles it (SETTLE T1a/T1b). The coach sees the sale up to 15 min later |
| 6 Transfer | charge-settlement.service.ts:864-876 enqueue `tgp-settle-<charge>-<leg>` -> transfer-orchestrator.service.ts:460 attempt, source_transaction = charge (:576) | — | money moves to the coach's Stripe balance and becomes available when the charge does | 5xx or unknown: kept pending, looked up at Stripe, then re-sent under the same key (:609-634). A definite refusal is retried up to max_attempts (:591-608). PAYOUT #5 SAFE |
| 7 Payout | Stripe automatic payout from the Express account | — | payouts list read live from Stripe (coach-connect.service.ts:293-340), so it is right even with no webhooks | Stripe emails the coach about a failed bank payout. TGP's own alert (billing.service.ts:567) needs a Connect event; see B1 note |

## Trace 2 — recurring package, first payment and a renewal
| Hop | Code (file:line) | Client sees | Coach sees | If this hop fails once |
|---|---|---|---|---|
| 1 Buy | POST /v1/checkout/subscription-intent (subscription-checkout.controller.ts:104). Subscription on the platform: on_behalf_of, default_incomplete, `save_default_payment_method=on_subscription` (stripe-connect-api.service.ts:551-560). Trials save the card through trial-card.ts (webhook + plan read + checkout backstop, :1-14) | PaymentSheet, then "Confirming your plan" (polls GET /v1/checkout/subscriptions/:id ~30 s) | — | **same saved-row payout gate (subscription-checkout.service.ts:272). See B1** |
| 2 First invoice | payment_intent.succeeded passes to invoice.paid (checkout-webhook-handler.service.ts:2193-2195) -> applyInvoicePaid :2521 (re-reads the subscription, entitles, first-grant fan-out :2639-2641, split with inv.charge :2654-2657, dunning resolve :2659) | "Renews <date>" | "New purchase" push + Money line | rolled back and redelivered (BILL W3) |
| 3 Renewal | Stripe Billing charges the saved default card -> invoice.paid -> same applyInvoicePaid. Settled per charge, with a backfill of every paid invoice in the sweep (SETTLE T1c) | new "Renews <date>"; Stripe receipt (receipts on since 12:37) | renewal net on the Money page | settlement or transfer fails: same as Trace 1 hops 5-6. Card declines: invoice.payment_failed -> dunning v2 Day 0/1/3/7, Day-10 lock, Update card + pay (DUNNING SAFE; moneyClient124 U-MC-4) |

## Trace 3 — refund (owner/admin; there is no coach or client refund button)
| Hop | Code (file:line) | Client sees | Coach sees | If this hop fails once |
|---|---|---|---|---|
| 1 Refund | POST /v1/admin/payments/purchases/:id/refund (payment-ops.controller.ts:552 -> refund-dispute-handler.service.ts:2427, deterministic key), or a refund in the Stripe dashboard | Stripe refund email (if that Stripe setting is on) | — | double tap = one refund (SETTLE M1) |
| 2 Webhook | charge.refunded -> onChargeRefunded :343 (purchase found by settlement row, ledger or PaymentIntent :2388-2420; the full refund list is read from Stripe :535-563) | full refund: access ends (:487 revokeFullyRefunded). Recurring: billing paused, not cancelled (owner decision 7; dunning-v2.service.ts:1197), plus in-app notice "A full refund was completed for this plan..." (:518-524). Partial: access kept | COACH_ALERT once per refund (:456-465; emitRefundCoachAlert :1631). Partial refund: Keep or Unassign drops card (:440-446). Recurring: restart card (moneyRefund124) | incomplete read: throws, Stripe redelivers, nothing moves (SETTLE W4) |
| 3 Clawback | settlements.applyAdjustments (:471): only this charge's own transfer is reversed. Fee residue becomes a PayeeRecovery netted from the coach's next sale (OR-111-1) | — | payout notice with exact amounts (SETTLE T1f/W7); Money page shows the refund in the window it happened | reversal re-driven by the sweep (SETTLE T1d) |

## B list
**B1 (T4 money / pay core flow). A new coach who is approved by Stripe after the onboarding return stays "not payable" until they
tap "Check status again", and every client Buy is refused in the meantime.**
- User story: a new coach finishes Stripe onboarding while Stripe is still checking their details. A few minutes later Stripe
  enables charges, but the app keeps showing "Stripe is checking your details ... Clients can pay you once Stripe has finished", and
  every client who taps Buy is told "Your coach cannot take card payments right now". This lasts until the coach happens to tap
  "Check status again".
- Why: both in-app Buy gates read the saved ConnectAccount row only: checkout.service.ts:594-610 (one-time) and
  subscription-checkout.service.ts:272 (recurring). The coach's payout screens read the same saved row through GET
  /coach/connect/status (coach-connect.service.ts:191 getStatus, no Stripe read). Callers: GetPaidPanel.tsx:131 load,
  MoneyHomeCard.tsx:70, MoneyScreen.tsx:216, setupStatus.ts:113. The row changes only on (a) the account.updated webhook
  (billing.service.ts:542/:1255), (b) POST /coach/connect/status/refresh (coach-connect.service.ts:241), which the app calls only right
  after the Stripe sheet closes and on "Check status again" (GetPaidPanel.tsx:172/:190/:271; CoachConnectScreen.tsx:58), and (c) GET
  /v1/connect/accounts/me (connect.service.ts:133). (c) is where b#750 (B-COND-1 / B-PAYOUTSYNC-123) put its Stripe re-read. **The
  10-07 app never calls that route** (`rg "connectApi\.getStatus|accounts/me" src` in mobile: only the definition at connectApi.ts:43
  and a test mock). So the b#750 fix cannot be reached from the app.
- Why (a) does not save it: account.updated for a coach's Express account is a connected-account event. It is delivered only to a
  "Connected accounts" event destination, and the SoT lists that destination as backlog, not done (handoffs/op-119/HANDOFF_AGENT_120.md
  backlog: "Connect-destination webhook (account.updated, capability.updated, payouts)"). Such a destination has its own signing
  secret, and the backend accepts only STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_NEXT (stripe-signature.ts:156). So even a
  newly added destination would be rejected unless its secret took the _NEXT rotation slot. Check: SQL Q1 (expected 0 rows for
  account.updated / payout.*). Q2 lists the coaches the gate is refusing today.
- Smallest fix (backend only, so it works with the 10-07 binary; about 20 src lines + 2 jest cases; T4 money, Claude Opus builder):
  1. coach-connect.service.ts:191 getStatus: when the row exists, is not deauthorized and charges or payouts are false, call
     `this.connect.syncFromStripe(row.stripe_account_id)` first and build the view from the synced row. A Stripe error keeps the
     saved row and logs the closed code. This is the same pattern as connect.service.ts:141-151.
  2. checkout.service.ts:603 and subscription-checkout.service.ts:272: when `!charges_enabled && !deauthorized_at`, re-read once
     through `connect.syncFromStripe` and refuse only if Stripe still says charges are off. This makes the client's Buy work without
     the coach doing anything.
  Tests (fail on main): saved charges_enabled=false + Stripe enabled -> GET /coach/connect/status ready and payment-intent proceeds;
  Stripe 500 -> today's answer.
  Recommended default: build tonight in the money scope, merge before the store build is used by real coaches. It is backend-only,
  so no APK dependency.
- Same root cause, lower impact (U, folded into B1, fixed by the same change): a coach whose payouts are enabled at Stripe after the
  return still reads "Stripe sends payouts to your bank once it has finished checking" (connectCopy.ts:87-91). TGP's coach alerts for
  payout.failed (billing.service.ts:567-569, :1493) never fire without a Connect destination. Stripe's own email and the live payouts
  list (coach-connect.service.ts:333) still tell the coach.

## U list
None new beyond the folded B1 item. (The in-app share-link buy for a coachless client asks for an invite code first,
packagePayment.ts:573. That is a known design decision from B-RECUR-MOB, not graded here.)

## C one-liners
- C (edge, deferred to 10k clients): a transfer that Stripe definitely refuses up to max_attempts ends 'failed' with a log alert only.
  The coach is not told in-app, and the trigger is a restricted account (transfer-orchestrator.service.ts:591-608).
- C (note): `transfer.failed` (billing.service.ts:555) is not emitted for Connect transfers on current Stripe API versions. The
  synchronous refusal path above is the real handler. Harmless dead branch.
- C (note): docs/stripe-setup.md:62-85 still lists only the coach SaaS events. The live endpoint has 21 events plus transfer.canceled
  (SoT 2837-2838 confirms refund.updated and trial_will_end). Nobody has written down that payment_intent.succeeded/payment_failed,
  invoice.payment_succeeded, charge.refunded, charge.dispute.*, transfer.reversed and setup_intent.succeeded are among the 21.
  Owner check, recommended default: the operator asks the owner to paste the event list once.

## Covered by open PRs
- Guest web storefront (decline or slow card leaves the buyer charged with no account; duplicate welcome email): covered by b#816
  (agent126/b-guest-126 @ 16d16028, open). The storefront web UI is not in either repo, so the guest's screens could not be traced.
  The backend thank-you page (thank-you.html.ts:25-52) makes no false claim.
- Cron double-run under every timed money job: b#810 merged (27b1c8c8). Not deployed per this file's code basis; the four MJ
  reports show money stayed single either way.
- B1: not covered. No open backend PR touches src/coach-connect, src/connect or the checkout payout gate (gh pr list at 18:34).
  b#750 is merged and is the incomplete earlier fix.

## PRs opened
None (read-only auditor, per job entry).

## Not fixed (needs operator)
1. B1: coach-connect.service.ts:191 (sync when not ready) + checkout.service.ts:603 + subscription-checkout.service.ts:272 (re-read
   once before refusing). About 20 src lines + 2 tests. Route to a Claude Opus 5.5 builder. Run SQL Q1/Q2 first to size the impact.
2. Owner, optional: paste the 21 platform webhook events once (C note 3). Long term: a Connected-accounts destination plus a third
   accepted secret (STRIPE_CONNECT_WEBHOOK_SECRET) in stripe-signature.ts:156, so account.updated and payout.* arrive. B1's fix does
   not depend on it.

## HANDOFF
Done 18:48 PDT. Report + SQL final. No worktrees, branches, locks or ci-lane runs created. Notify line written to
/home/user/workspace/ops/lanes126/notify/AUD-MONEY-E2E-126.txt. A builder for B1 starts from origin/main (35c22212) in
/home/user/workspace/wt/<JOB>-backend. Files: src/coach-connect/coach-connect.service.ts, src/checkout/checkout.service.ts,
src/checkout/subscription-checkout.service.ts. Pattern: src/connect/connect.service.ts:133-152 (b#750). Tests go next to
test/connect.service.spec.ts.
