Tier: T4
Why: money path. A guest buyer can be charged with no account, and a paid guest can get the welcome/receipt email twice.
T4 trigger scan: money (guest PaymentIntent success claim, guest conversion write). No auth, RLS, PII, credentials or destructive data change.
T3 trigger scan: none (no schema, migration, flag, dependency or API shape change).
Bounded T1: NO (T4 money).
Canonical builder: Claude Opus 5.5 (B-GUEST-126, agent 126 fleet)
Parent owner: agent 126 (operator)
Acceptance evidence: test/b-guest-126-guest-checkout-claims.spec.ts, 6 cases, 5 of them fail on main f71bb9a4/2df556b7 (run locally against main's guest-checkout.service.ts: status stays 'failed' / 'conversion_failed_terminal', 2 welcome emails and 2 fan-outs) and pass here. Existing guest-checkout.service.spec.ts (58), pr14-guest-recurring-lp-attribution.spec.ts (11), lost-webhook-reconcile.service.spec.ts (4), pr14-recurring-reconciler-branch.spec.ts (5), guest-checkout-reconciliation.service.spec.ts (4) pass locally. Full suite and tsc run in this PR's CI.
Promotion triggers: any change to which statuses a succeeded PaymentIntent may claim, or to where the welcome email is sent.

Source: /home/user/workspace/ops/reports/AUD-MJ-BILL-126.md ("Noticed outside scope" item and UNSAFE J3/R2).

## B fixed

**B1. A guest buyer who is slow to type the card, or whose first card is declined, is charged and never gets an account.**
User story: a buyer opens a coach's checkout link, takes a minute to type the card (or the first card is declined and they try another), pays, and Stripe takes the money but no account, purchase or email is ever created.
- Why: the guest PaymentIntent is created unconfirmed, before card entry (guest-checkout.service.ts createIntent). The lost-webhook poller sets the row to 'failed' on its first poll (30-90 s after creation) when the intent is still `requires_payment_method` (lost-webhook-reconcile.service.ts:179-216), and a decline sets 'failed' via payment_intent.payment_failed (handlePaymentFailed). The buyer can still pay on the same PaymentIntent, but the success claim only accepted 'pending' (guest-checkout.service.ts:919-931 on main), so the payment_intent.succeeded webhook was dropped as "duplicate".
- Fix: the success claim accepts `pending`, `failed` and `conversion_failed_terminal` (PAYMENT_CLAIMABLE_STATUSES). `refunded`, `disputed`, `converted` and expired rows are still refused (spec case 4). Every other caller of handlePaymentSucceeded (poller, subscription fallback) already passes only pending rows, so the wider claim is reached only from a signed payment_intent.succeeded event. The poller itself is unchanged: abandoned carts still go to 'failed' (correct), they are just no longer final once Stripe says the payment succeeded.

## U fixed

**U1. A paid guest can get the welcome/receipt email twice.**
User story: a guest buys a package and receives two "<coach> is ready for you on Growth Project" emails minutes apart, one with the set-password link and one without.
- Why: the paid -> converted write was unconditional (guest-checkout.service.ts:1645 on main), so when the webhook and the reconciler (or a retry) both convert one checkout, the late copy commits again and sends the email again.
- Fix: `tx.guestCheckout.updateMany({ where: { id, status: 'paid' } })`; if it matches 0 rows the copy returns before fan-out and skips drop alerts and the email. Under READ COMMITTED the late copy blocks on the row lock, re-checks `status = 'paid'`, and matches 0.

## Not changed
- Poller cadence, cap and give-up statuses (lost-webhook-reconcile.service.ts) are unchanged.
- Overlap: none. No open PR touches src/storefront (b#810 changes ScheduleModule loading only).

Size: 3 files, +305 / -11 (316 lines; 45 in src, the rest tests).
