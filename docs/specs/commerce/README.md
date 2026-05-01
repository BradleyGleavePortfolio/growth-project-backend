# Commerce & Marketplace Wave — pre-work specs (rows #40–#45)

> **Status:** Draft — docs only. No runtime, schema, env-var, or module-wiring change in this PR. Each spec lands as its own gated, narrow runtime PR series after review.

## Why this wave exists

The Growth Project (TGP) today is a per-seat coach SaaS: coaches pay TGP a flat platform fee and run their book of clients inside the app. To become a **one-stop-shop for coaches** (the "Whop-for-coaches" north star in the founder's strategy memo), TGP needs to own the *commerce surface area* a coach hits between **first-touch with a prospect** and **money-in-bank** — the slice that today leaks to Kajabi, Stan Store, ClickFunnels, Stripe Atlas, custom Webflow sites, paid Calendly setter funnels, and bespoke Notion intake forms.

This wave specs the six backend lanes that, taken together, let a coach run their entire commercial pipeline inside TGP:

| #   | Lane                               | Spec                                                                  | Brief                                                                              |
| --- | ---------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 40  | Coach Storefronts                  | [`coach-storefronts.md`](./coach-storefronts.md)                      | [`40`](../../architecture/handoff/commerce/40-coach-storefronts.md)                |
| 41  | Payments + Checkout (Connect / MoR)| [`payments-checkout.md`](./payments-checkout.md)                      | [`41`](../../architecture/handoff/commerce/41-payments-checkout.md)                |
| 42  | Offer Builder                      | [`offer-builder.md`](./offer-builder.md)                              | [`42`](../../architecture/handoff/commerce/42-offer-builder.md)                    |
| 43  | Application Funnel                 | [`application-funnel.md`](./application-funnel.md)                    | [`43`](../../architecture/handoff/commerce/43-application-funnel.md)               |
| 44  | Affiliate / Referral               | [`affiliate-referral.md`](./affiliate-referral.md)                    | [`44`](../../architecture/handoff/commerce/44-affiliate-referral.md)               |
| 45  | Coach Marketplace                  | [`coach-marketplace.md`](./coach-marketplace.md)                      | [`45`](../../architecture/handoff/commerce/45-coach-marketplace.md)                |

A **gap map** at [`../../architecture/gap-map-commerce-marketplace.md`](../../architecture/gap-map-commerce-marketplace.md) maps each lane to:

- what already exists in `main`,
- what is covered by drafts PR #117–#123 (AI Program Builder, Team Mode, expansion roadmap, platform readiness, backend-owned pre-work, masterminds operating model, coach-experience wave),
- what is **net-new** in this wave.

## Reading order

1. **Read first:** [`payments-checkout.md`](./payments-checkout.md). Every other spec in the wave depends on the connected-account model and the platform-fee shape this defines. Skipping it leaves the rest hanging.
2. **Then read:** [`coach-storefronts.md`](./coach-storefronts.md). The storefront is the public surface every other lane attaches to (offers, applications, affiliate links, marketplace cards).
3. **Then read in any order:** the remaining four. They are independent of each other once #40 / #41 are settled.

## Shared design rules — every spec in this folder honours

These rules are not re-litigated per spec. They are platform contracts the wave inherits from PR #120 (platform-readiness lanes) and the founder's strategy memo:

1. **Coaches do not think about Stripe.** A coach onboards by clicking one button ("Start accepting payments"). The first run is **Stripe Connect Express** (TGP is the platform; the coach has a connected account that holds settlement balance). The coach never sees a Stripe dashboard URL unless they explicitly ask for it. ([`payments-checkout.md` §4](./payments-checkout.md#4-account-model-stripe-connect-express-default))
2. **TGP can become merchant-of-record on a per-product basis** for L2 / L3 / mastermind / templates-marketplace / global-tax-complex offers, **without** moving the coach's existing direct-charge inventory. The MoR path lives behind a per-`Offer` `payment_routing` enum so the migration is a row-level flip, never a redeploy. ([`payments-checkout.md` §5](./payments-checkout.md#5-merchant-of-record-mor-path))
3. **Money flow is recorded in a TGP ledger before Stripe is the source of truth.** Every charge writes a `LedgerEntry` (gross / platform fee / coach payout / tax / refund) inside the same DB transaction that issues the Stripe call. Reconciliation runs nightly against Stripe Reporting. ([`payments-checkout.md` §10](./payments-checkout.md#10-ledger-and-reconciliation))
4. **Tenant boundary is the coach.** Every commerce table has a `coach_user_id` (or denormalised `coach_id`) and is scoped by a row-level guard. Cross-coach reads require explicit OWNER role. (PR #120 lane #03; PR #118 §6.)
5. **Default-off feature flags.** Six flags: `STOREFRONTS_ENABLED`, `COMMERCE_CHECKOUT_ENABLED`, `OFFER_BUILDER_ENABLED`, `APPLICATION_FUNNEL_ENABLED`, `AFFILIATE_ENABLED`, `MARKETPLACE_ENABLED`. Each is independent. The first runtime PR per lane lands with its flag default-off and a kill-switch documented in the operator handoff section.
6. **Mobile + coach-console are read-only against the new surfaces until each lane's Stage 3 GA.** No mobile contract change happens implicitly; every shape that mobile sees is added under `/api/v1/...` with a contract test before any client ships.
7. **`new-website` is not touched.** Every public coach surface (storefront page, offer page, application page, affiliate landing, marketplace listing) is rendered by **this** backend (extends `src/public-pages/`). The marketing site is an entirely separate concern.
8. **Abuse, fraud, moderation are first-class.** Each spec carries an "abuse / fraud / moderation" section with concrete primitives (rate limits, application captcha, payout holds, review-queue, takedown vocabulary). These are not afterthoughts.
9. **Refunds, chargebacks, tax, and disputes are coach-actionable but operator-overrideable.** Coaches see one button ("Refund this client"); operators see the full dispute envelope and can override.
10. **Audit log everything that touches money or moderation.** Use the existing `AuditLog.action` vocabulary; introduce only the new actions enumerated in each spec's §11.

## Spec template — every commerce spec carries

The template is identical to the one PRs #121 and #123 use, with two additions specific to commerce (§9 payment-routing decision, §11 ledger / reconciliation):

1. Status banner + cross-references.
2. **WHY** — problem in coach + business terms; the leak-to-third-parties cost; the unlock once shipped.
3. **WHEN** — gating conditions for starting runtime work (which other rows must close).
4. **WHERE** — modules, tables, routes, public pages touched.
5. **WHO** — sign-off + on-the-hook + downstream consumers + hard boundaries (what this spec does *not* own).
6. **WHAT** — what already exists; what's net-new; explicit non-goals.
7. **HOW** — rollout phases (S0 spec → S1 skeleton → S2 private beta → S3 GA), smallest first PR shape, kill-switch.
8. **Data model sketch** — additive Prisma proposals, all FKs concrete, retention policy per table, forward-compat columns reserved (`acted_by_member_user_id` for Team Mode).
9. **API sketch + payment routing** — routes, envelopes, throttling tiers, per-route Stripe call shape (direct charge vs. destination charge vs. platform charge), MoR path called out where it differs.
10. **Tax, refund, chargeback, dispute** — who owns each (coach / TGP / Stripe), state machine, refund rules, chargeback evidence flow.
11. **Ledger and reconciliation** — `LedgerEntry` rows written, reconciliation cadence, drift alarms, replay tooling.
12. **RBAC, privacy, GDPR scrub** — role gate, tenancy axis, retention, right-to-erasure coverage, data export.
13. **Abuse, fraud, moderation** — rate limits, captcha, payout holds, review queue, takedown vocabulary.
14. **Feature flags + entitlements** — env var, default value, per-coach entitlement gate (which tier unlocks this lane).
15. **Tests** — unit, integration, contract, smoke, eval (for AI surfaces only). Concrete test names where possible.
16. **Risks** — failure modes the spec is paying down upfront. At least: provider risk, fraud risk, regulatory risk, data-loss risk, mis-routing risk.
17. **Dependencies** — internal (other rows), external (Stripe, KYC vendors, tax engines), human (founder decisions to close).
18. **Acceptance criteria** — checklist for "shipped." Every item must be objectively verifiable.
19. **Operator handoff** — kill-switch invocation, dashboards (Grafana / PostHog tile names), runbook entry under `docs/`, alert thresholds, on-call playbook.

## Coexistence with in-flight drafts

| Draft PR | Relationship to this wave                                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **#117** | AI Program Builder. **Adjacent.** A storefront's offer can deliver a Program Draft → Publish pipeline as fulfilment; the offer-builder reuses the per-kind validators. Not modified.                                                                              |
| **#118** | Team Mode foundation. **Hard dependency.** Every commerce table reserves `acted_by_member_user_id` so a setter can be attributed on the application that converted, the affiliate link they shared, the offer they created. Not modified.                        |
| **#119** | Expansion roadmap + handoff briefs (rows #01–#02). **Index dependency.** This wave reserves rows #40–#45 in the same numbering scheme. A one-line addendum (`expansion-roadmap-addendum-commerce.md`) folds in once #119 merges.                                  |
| **#120** | Platform readiness — 11 lanes. **Hard dependency.** Lane #01 (flags + entitlements), #03 (RBAC + tenancy), #04 (data lifecycle), #05 (billing packaging, where the marketplace revenue-share shape was reserved), #07 (migration safety), #10 (analytics) all apply. |
| **#121** | Backend-owned pre-work specs (rows #21–#29). **Adjacent.** #28 (program templates) is a precursor to offer fulfilment. Not modified.                                                                                                                              |
| **#122** | Masterminds operating model. **Hard dependency.** L2/L3/mastermind tiers in #122 §2 describe the per-tier offers the offer-builder must support, and the application funnel their cohorts use. The MoR path in [`payments-checkout.md` §5](./payments-checkout.md#5-merchant-of-record-mor-path) is the runtime shape that backs §7 of #122. Not modified. |
| **#123** | Coach-experience wave (rows #30–#37). **Adjacent.** #34 (regimens) and #35 (regimen-assignment) are the canonical fulfilment shape an offer publishes into; #37 (tiering L2/L3) is the entitlement axis that gates which commerce lanes a coach can use.          |

## What this wave does NOT cover

- **Public-facing marketing pages** for TGP itself (the `new-website` repo).
- **Coach-to-coach community surfaces** (parking-lot row in PR #119).
- **Live event ticketing** beyond the IRL deposit / balance flow specced in PR #122.
- **Payouts in non-USD currencies** before Stripe Connect supports them in the coach's country (handled per-region in [`payments-checkout.md` §16](./payments-checkout.md#16-international--multi-currency-readiness)).
- **Crypto / on-chain payments.** Out of scope. Hard no.
- **In-app advertising** between coaches inside the marketplace. Out of scope for this wave.
- **Mobile push fan-out** to clients on offer publish (parking-lot row in PR #119).

## Hard boundaries (the wave will refuse to cross)

- ❌ No `prisma/schema.prisma` change in this PR.
- ❌ No new migration in `prisma/migrations/` in this PR.
- ❌ No `app.module.ts` wiring change in this PR.
- ❌ No new env var added to `src/common/env-validation.ts` in this PR (the per-lane feature flags are *described* in each spec's §14, not added).
- ❌ No edit to `new-website` (any reference is a "do not touch" boundary note, never a runtime hook).
- ❌ No edit to PRs #117–#123. Cross-references only.
- ❌ No mobile or coach-console contract change in this PR.
