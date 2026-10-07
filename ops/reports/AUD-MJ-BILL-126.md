# AUD-MJ-BILL-126: recurring billing and purchases. Can any job do the same money work twice?
Worker AUD-MJ-BILL-126 (Claude Opus 5.5, read-only auditor, T4 money), agent 126 fleet. Started 18:02 PDT 10-06 (from `TZ=America/Los_Angeles date`). Hard stop 18:55.
Code read: /home/user/workspace/wt/RO-backend @ f71bb9a4 (backend main = production deploy 16). No PRs, no SQL run, no Stripe calls.
SQL for the operator: /home/user/workspace/ops/reports/AUD-MJ-BILL-126.sql (Q1-Q5, read-only, last 30 days).
Status: DONE (finished 18:17 PDT 10-06).

## Premise and flags
- Until b#810 (B-CRON-126, `agent126/b-cron-126` @ 9ee51c0b, open) deploys, every @Cron fires as two concurrent copies in one
  process. Both copies call the same provider singleton. The operator's drip-dispatcher log ("prior tick still running" at :00)
  shows this, so an instance flag set before the first `await` stops the second copy in this bug. It does not protect across two
  machines; no job below relies on the flag alone.
- Operator 18:16 correction: FEATURE_DUNNING_V2 is ON in production (b#762, env-sync applied 14:11). I re-checked the one billing
  path it gates (client-billing reconcile, branch b, which applies 2A to out-of-band cancels). Verdict unchanged: SAFE (see J1).
- LEGACY_PDF_RECEIPT_ENABLED is not in .github/fly-env-desired-state.json (unset), so the checkout-receipt cron is a no-op.
- Recurring renewals are charged by Stripe Billing on Stripe's own schedule. No app cron creates an invoice, a PaymentIntent or a
  subscription. The only timed Stripe money writes in this area are: pay an invoice (client-billing replay, keyed), void an
  invoice (keyed), finalize a draft before voiding it (trial-conflict, under a lease), and cancel a subscription (idempotent).
  So the double scheduler cannot double-charge a renewal.

## Scope traced
Timed jobs (`git grep -n "@Cron(\|@Interval(\|@Timeout(" -- src`, my area): checkout/client-billing.reconciler.ts:27,
storefront/checkout-receipt.scheduler.ts:37, storefront/guest-checkout-reconciliation.service.ts:49,
storefront/lost-webhook-reconcile.service.ts:54, storefront/guest-checkout-pii-scrub.service.ts:59, packages/drip-dispatcher.cron.ts:84,
packages/trials/trial-conflict.service.ts:474, packages/trials/trial-notice.service.ts:536, plus the adjacent
ai-credits/coach-ai-budget.scheduler.ts:28 (purchased AI credits).
Webhooks: POST /v1/webhooks/stripe (billing/stripe-webhook.controller.ts:52) -> BillingService.handleEvent (billing.service.ts:166)
-> CheckoutWebhookHandlerService.handle (checkout-webhook-handler.service.ts:637), CoachAiCreditPack.handleStripeEvent, guest
handlers in storefront/guest-checkout.service.ts, coach SaaS subscription handlers in billing.service.ts.
Retry paths: client-billing pay-now replay (client-billing.service.ts:971, :1015), guest conversion retry (guest-checkout.service.ts:1910).
No queue consumers in this area (no BullMQ; onModuleInit hooks in storefront/* only set up Redis or limiters).
Not in my lane (handed off): split/settlement/transfers (AUD-MJ-SETTLE-126 rows W2/W3/T1h), payouts (AUD-MJ-PAYOUT-126),
dunning sweep and emails (AUD-MJ-DUNNING-126).

## Verdict table
| # | Job (file:line) | Money or customer work | Guard against a second concurrent copy, webhook redelivery or crash re-run (file:line) | Verdict |
|---|---|---|---|---|
| J1 | client-billing-reconcile, hourly :37 (checkout/client-billing.reconciler.ts:27) | resumes card payments (`payInvoice`), 2A cancels (void + cancel), and with DUNNING_V2 ON applies 2A to out-of-band cancels | instance flag set before the first await (reconciler.ts:32-36); per-purchase lease CAS `updateMany WHERE holder null or expired`, count must be 1 (client-billing.service.ts:2223-2237), taken by every path (:611, :1564, :1991); writes fenced on the holder (:2256-2266); Stripe keys are deterministic: pay `tgp-1a-pay-<invoice>-<setupIntent>` (:336-338, used :1024), void `tgp-2a-void-<invoice>` journaled before the call (:341, :1622-1627), keep-paid-period `tgp-cancel-ape-<sub>` (:1721); cancel is idempotent (already-canceled re-read :1769-1776) | SAFE |
| J2 | checkout-receipt, every minute (storefront/checkout-receipt.scheduler.ts:37) | legacy PDF receipt + email | inert: returns unless LEGACY_PDF_RECEIPT_ENABLED='true' (:47), which is unset. If revived, both copies would render a PDF, but the email goes once: EmailService key `checkout-receipt:<id>` (checkout-receipt.service.ts:152) inserts EmailSendLog first and skips on P2002 (email.service.ts:160-187; schema.prisma:5641 `idempotency_key @unique`). Note: AUD-CRONX row 10 says it "would double the receipt email"; the EmailSendLog key prevents that. | SAFE (inert) |
| J3 | guest-checkout-reconciliation, every minute (storefront/guest-checkout-reconciliation.service.ts:49) | converts paid guest checkouts: account, ClientPurchase, content fan-out, welcome email that carries the Stripe receipt link | Money is safe: ClientPurchase `stripe_checkout_session_id` = `guest_pi_<pi>` @unique (schema:4200) and `idempotency_key` @unique (schema:4221), so a racing insert gets P2002 and that transaction rolls back (guest-checkout.service.ts:1594-1632); fan-out `PurchaseFanout.purchase_id` @unique upsert (purchase-fanout.service.ts:204; schema:6395), drops `createMany skipDuplicates` (:287), and one COACH_NEW_PURCHASE per purchase via the DripResolverMarker claim (:392; schema:6437). The email is not guarded. There is no flag and no claim: the retry re-arm ignores its count (guest-checkout.service.ts:1929-1932), the paid check is a read (:1379-1382), and the converted write has no condition (:1645). A copy whose transaction starts after the winner has committed finds the purchase, commits again, and sends the welcome email again (:1713), as a raw Resend POST with no idempotency key and no EmailSendLog row (:2063). | UNSAFE (email only, no money) |
| J4 | checkout-lost-webhook-reconcile, every minute (storefront/lost-webhook-reconcile.service.ts:54) | polls Stripe; on success runs the webhook path | conversion is claimed by `updateMany WHERE status='pending'`, count 0 returns (guest-checkout.service.ts:919-931), so one copy converts; the give-up writes are conditional on status (:142-145, :213-216). C: the "claim" at :118-125 is an unconditional increment, so two copies count two attempts a minute and the 5-attempt cap is hit in about half the time. | SAFE |
| J5 | drip-dispatcher, every minute (packages/drip-dispatcher.cron.ts:84) | delivers purchased content drops + drop alerts | instance flag (:88-93, the very warning in the operator's logs) + claim-by-write `updateMany ... count===0 -> null` (:295-302) | SAFE |
| J6 | trial-conflict-sweep, every 5 min (packages/trials/trial-conflict.service.ts:474) | cancels a duplicate-trial subscription, voids its invoices, alerts support | per-row lease `updateMany WHERE status='owed' AND lease free`, count must be 1 (:268-276), renewed by CAS before each Stripe call (:426-432); void key `tgp-trial-void-<invoice>` (:446); finalize only under the lease (:441); support alert claimed once (:505-509) | SAFE |
| J7 | trial-notice-sweep, every 10 min (packages/trials/trial-notice.service.ts:536) | "trial ends, you will be charged" push + email | notice row `@@unique([purchase_id, trial_ends_at])` (schema:4394); per-channel lease CAS, count must be 1 (:842-871); same-process in-flight map (:715, :773); email key `trial-ending:<purchase>:<trial end>` (:794-795). C: attempt 2+ uses a new key suffix, so a crash after send but before the outcome write can send again (crash-mid-write). | SAFE |
| J8 | guest-checkout-pii-scrub, daily 03:17 (storefront/guest-checkout-pii-scrub.service.ts:59) | scrubs guest PII (data, not money) | `updateMany WHERE id AND scrubbed_at IS NULL` (:111-112) | SAFE |
| J9 | coach-ai-budget-rollover, hourly :05 (ai-credits/coach-ai-budget.scheduler.ts:28) | monthly reset of coach AI credit periods | `updateMany WHERE id AND period_end <= now` (coach-ai-budget.service.ts:506-507); the second copy re-checks after the first commits and matches 0 | SAFE |
| W1 | Stripe webhook dedupe (billing.service.ts:166) | every event below | `StripeProcessedEvent.stripe_event_id @id` (schema:698): pre-check (:175), insert as the first write in the event transaction (:266), duplicate -> P2002 -> `alreadyProcessed` (:588). Post-commit work (split, payout notice, trial notice, drip alerts) runs only for the winner. | SAFE |
| W2 | in-app purchase activation + fan-out: checkout.session.completed / customer.subscription.created/updated / payment_intent.succeeded (checkout-webhook-handler.service.ts:643-656) | entitlement + content fan-out + coach new-purchase alert | W1, plus a CoachPackage `FOR UPDATE` lock around activation (:3062-3076); fan-out guards as in J3 (one row per purchase, skipDuplicates, a marker for the alert). `GET checkout/sessions/:id/confirm` is read-only (checkout.service.ts:1026-1069), so the webhook is the only thing that activates. | SAFE |
| W3 | renewals: invoice.paid AND invoice.payment_succeeded both route to applyInvoicePaid (checkout-webhook-handler.service.ts:663-664, :2521) | two different event ids per paid invoice, so W1 does not merge them | the purchase update re-syncs from Stripe state (idempotent; row lock :2580); first-payment notice one per coach (`CoachFirstPaymentNotification.coachId @unique`, schema:7659, checked :2027-2030); trial notice unique as J7; split is idempotent per charge, not per event (purchase-split-handler.service.ts:27; AUD-MJ-SETTLE-126 W2/T1h SAFE); dunning resolve is DUNNING's lane | SAFE |
| W4 | guest payment_intent.succeeded / payment_failed / charge.refunded / dispute (billing.service.ts:375-541) | guest conversion, failure, refund, dispute | conversion claim `WHERE status='pending'` (guest-checkout.service.ts:919); failed flip conditional (:1074-1080); refund and dispute are conditional claims inside a transaction (:1171, :1191, :1211, :1305) | SAFE |
| W5 | coach AI credit pack checkout.session.completed (ai-credits/coach-ai-credit-pack.service.ts:289 -> coach-ai-budget.service.ts:applyCreditPack) | adds purchased AI credits (increment) | runs inside the W1 event transaction, so a duplicate delivery waits on the StripeProcessedEvent insert and then aborts; `status==='paid'` -> already_applied (:325-330); only checkout.session.completed adds credits | SAFE |
| W6 | coach SaaS subscription invoice.paid / payment_failed (billing.service.ts:354-358, :1109) | coach platform plan status, PaymentFailure row, payment-failed email | W1 (one run per event); email key `billing-payment-failed:<event id>` (:1198) | SAFE |
| R1 | client-billing pay-now replay (client-billing.service.ts:971 replayPay, :1015 payOne) | `payInvoice` | same lease as J1 + deterministic key (:336, :1024), or the journaled key replayed (:979-983) | SAFE |
| R2 | guest conversion retry (reconcilePaidCheckout, guest-checkout.service.ts:1910) | same as J3 | same as J3 | UNSAFE (email only, same root cause as J3) |

Counts: 17 rows. SAFE 15 (J1-J2, J4-J9, W1-W6, R1), UNSAFE 2 (J3, R2: one root cause, a second welcome/receipt email, no money), UNKNOWN 0.
No row in this area can create a second charge, invoice, PaymentIntent, subscription, purchase, fan-out or credit grant.

## UNSAFE detail
J3/R2: guest conversion can send the welcome/receipt email twice.
- What a client sees: a guest who bought a package from a coach's link gets two "<coach> is ready for you on Growth Project" emails
  a few minutes apart. Often one has the set-password invite link and the other says to sign in normally. No double charge,
  no second purchase.
- When: (a) until b#810 deploys, both reconciler copies take every paid or retry guest row at the same second; (b) after b#810,
  still whenever the webhook's inline conversion is running at the minute boundary for a checkout whose row was created more than
  2 minutes earlier. The orphan scan keys on created_at, not paid time (guest-checkout-reconciliation.service.ts:104-115).
  b#810 fixes (a), not (b).
- Check: SQL Q1 / Q1-count (exposed conversions, last 30 days), then confirm in the Resend dashboard (read-only). The database
  cannot prove a duplicate because the welcome send writes no EmailSendLog row. Q2/Q3 confirm money did not double (expected 0 rows).
- Smallest fix (about 12 lines, backend, T4 money-adjacent; Claude Opus builder; also needs a jest case: two conversions, one email):
  in convertGuestToUser, guest-checkout.service.ts:1645, replace `tx.guestCheckout.update({ where: { id } ... })` with
  `const won = await tx.guestCheckout.updateMany({ where: { id: checkout.id, status: 'paid' }, data: { status: 'converted', created_user_id: dbUser.id } })`.
  If `won.count !== 1`, return from the transaction before fan-out and set a local `lost = true`. After the commit, skip
  flushAlerts and sendWelcomeEmail when `lost` (:1701-1717). Under READ COMMITTED the late copy blocks on the row lock, re-checks
  `status='paid'`, and matches 0. Optional extra: send the welcome email through EmailService with key `guest-welcome:<checkout id>`.
  Recommended default: build after b#810 merges, in tonight's money scope, because it also closes case (b).

## B / U / C
- B: none from double work.
- U (1): J3/R2, a duplicate welcome/receipt email after a guest purchase (story above). Fix above.
- C (edge, deferred to 10k clients):
  - lost-webhook `reconcile_attempts` counts twice a minute (lost-webhook-reconcile.service.ts:118-125), so the cap is reached in half the time.
  - trial-notice retry uses a new email key per attempt, so a crash after send can send twice (trial-notice.service.ts:795).
  - checkout-receipt (inert) renders the PDF twice if ever revived (checkout-receipt.service.ts:132-135, count unchecked).
  - The P2002 "re-read the racer's row" in convertGuestToUser (guest-checkout.service.ts:1632-1640) runs inside an already-aborted
    Postgres transaction, so it never succeeds; the loser rolls back and markRetryable is a no-op on a converted row (harmless).
  - Double taps on POST checkout/payment-intent, checkout/sessions, checkout/subscription-intent and payment-method/confirm rely on
    client idempotency keys (request paths, not timed).

## Noticed outside the double-work question (UNVERIFIED single-run money risk, routed to the operator)
- A guest PaymentIntent is created unconfirmed at createIntent (guest-checkout.service.ts:545-556, with no payment method).
  lost-webhook-reconcile treats `requires_payment_method` as dead and sets the row to 'failed' on its first poll, 30+ s after creation
  (lost-webhook-reconcile.service.ts:179-216; one-time packages have no subscription to re-check). A card decline also sets
  'failed' (guest-checkout.service.ts:1074-1080). A later successful confirm on that same PaymentIntent is then refused by the
  pending-only claim (:919-931), so the buyer is charged and gets no account. Whether this happens depends on the storefront UI
  (not in either repo): does it call createIntent before the buyer types the card, and does it reuse the PaymentIntent after a
  decline? Check: SQL Q5, then look at each listed PaymentIntent in the Stripe dashboard (read-only). Smallest fix if confirmed:
  never set 'failed' from the poller on `requires_payment_method` (leave the row to expires_at), and let the success claim also
  accept 'failed' when the PaymentIntent succeeded (about 6 lines in lost-webhook-reconcile.service.ts:179 and
  guest-checkout.service.ts:921-923). T4 money; Claude Opus builder. Recommended default: run Q5 now; build only if it returns a
  succeeded PaymentIntent or the storefront creates the intent before card entry.

## Covered by open PRs
- The copy-vs-copy part of every row is covered by b#810 (B-CRON-126, fix(schedule): load ScheduleModule once), head 9ee51c0b. J3/R2 case (b) and the outside-scope item are NOT covered.
- No open PR touches src/billing, src/checkout, src/storefront, src/packages money paths (b#808/b#809 are AI builder).

## PRs opened
None (read-only auditor).

## Not fixed (needs operator)
1. J3/R2: guest-checkout.service.ts:1645 conditional converted write + skip email/alerts when lost (:1701-1717), about 12 lines. Default: build after b#810.
2. Outside scope (unverified): lost-webhook-reconcile.service.ts:179-216 + guest-checkout.service.ts:919-931. Default: run SQL Q5 first.

## HANDOFF
Audit complete. Report: this file. SQL: /home/user/workspace/ops/reports/AUD-MJ-BILL-126.sql. Notify line written to
/home/user/workspace/ops/lanes126/notify/AUD-MJ-BILL-126.txt. No worktrees, branches or locks created. A follow-up builder for item 1
starts from origin/main, worktree /home/user/workspace/wt/<JOB>-backend, file src/storefront/guest-checkout.service.ts.
