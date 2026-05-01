# Handoff brief: #41 Payments + Checkout (Stripe Connect + future MoR)

**Status:** spec accepted in draft. Runtime PR series gated on Stripe Connect platform approval (multi-week external) and §20 OQs closed.

**Engineer-facing spec:** [`docs/specs/commerce/payments-checkout.md`](../../../specs/commerce/payments-checkout.md).

## WHY

Coaches today bridge TGP to outside payment tools (Stripe Atlas, Kajabi, Stan Store) to take money. The bridge is leaky (revenue is unattributable) and introduces friction (multiple dashboards, refund spreadsheets, manual chargeback responses). The strategic goal is "coaches do not think about Stripe": one click + KYC and they are accepting payments under TGP's brand, with refunds, disputes, and reporting handled by TGP.

## WHEN

- Filed: when this spec is accepted by founder + backend lead.
- Long-pole: Stripe Connect platform application (multi-week external review).
- Blocking opens: refund window default (OQ-1), dispute liability default for >$2k (OQ-2). Counsel review of MoR positioning before first MoR offer.
- Gates the entire commerce wave (#40, #42, #43, #44, #45 all depend on this).

## WHERE

- New module `src/commerce/`, sibling to `src/billing/`. Subdirs `connect/`, `checkout/`, `ledger/`, `webhooks/`.
- New tables: `CoachStripeAccount`, `Charge`, `Refund`, `Dispute`, `Payout`, `LedgerEntry`, `CoachPayoutPolicy`.
- New routes under `/api/v1/coach/payments/`, `/api/v1/checkout/`, `/api/v1/webhooks/stripe-connect`, `/api/v1/owner/commerce/`.
- Does **not** touch `src/billing/` (per-seat coach SaaS plan keeps current shape).
- Touches `src/public-pages/` for checkout-success / receipt SSR.

## WHO

- Sign-off: founder (commercial / risk), backend lead (architecture), counsel (MoR positioning).
- On the hook: backend lead. Pager: backend lead, founder for $10k+ disputes / payout holds.
- Risk owner (KYC/AML): founder until finance-ops hire.

## WHAT

**Default model:** Stripe Connect Express. Destination charges. Coach is merchant-of-record on Connect path; TGP is platform.

**Future-flip:** per-`Offer.payment_routing` enum. Flipping to `PLATFORM_MOR` makes TGP the merchant — needed for L2/L3 mastermind seats (PR #122 §7), templates marketplace (#45), coach-of-coaches funnels. The flip is one column update; no schema migration, no redeploy.

**Ledger-first.** Every charge / refund / chargeback / payout writes a TGP-owned `LedgerEntry` row in the same DB tx as the Stripe call. Reconciliation runs nightly against Stripe `BalanceTransaction`. Drift > $50/24h pages.

**What this spec does NOT own:** per-seat SaaS billing (`src/billing/` keeps it), offer schema (#42), application schema (#43), affiliate share semantics (#44), marketplace listings (#45).

## HOW

S0 spec → S1 (Connect onboarding + Charge + Ledger only, flag off) → S2 (refunds, disputes, reconciliation) → S3 GA per-coach. MoR routing flag-off until first counsel-acked offer flips.

Smallest first PR: `src/commerce/` skeleton, `CoachStripeAccount` migration, onboarding endpoints only, all behind `COMMERCE_CHECKOUT_ENABLED=false`. ≤600 LOC.

## Risk + dependency highlights

- Stripe Connect platform approval is the long-pole external dependency.
- Coach-side KYC failure path needs a clear retry + escalation UI.
- Counsel review of deferred-payout positioning before first L3 mastermind flip (avoids MSB classification).
- GDPR-vs-tax-retention conflict resolved via pseudonymisation, not deletion, of money-bearing rows.

## Operator handoff

Kill-switches, dashboards, runbook entries, and PagerDuty alerts enumerated in [spec §20](../../../specs/commerce/payments-checkout.md#20-operator-handoff). New runbook files: `commerce/operator-onboarding.md`, `commerce/refund-runbook.md`, `commerce/reconciliation-runbook.md`, `commerce/mor-flip-checklist.md`, `commerce/incident-runbook.md`.
