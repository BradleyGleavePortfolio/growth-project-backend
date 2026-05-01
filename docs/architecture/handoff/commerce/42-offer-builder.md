# Handoff brief: #42 Offer Builder

**Spec:** [`docs/specs/commerce/offer-builder.md`](../../../specs/commerce/offer-builder.md).

## WHY

A coach today configures the same "offer" three different ways across Stripe, Kajabi, and Calendly. Pricing, fulfilment, and refund rules drift. The offer-builder makes the offer a **first-class TGP object**: one row, one source of truth for price, billing cadence, fulfilment, refund window, application requirement, affiliate share rate, payment routing, entitlement granted on purchase. Every other commerce surface (storefront, application, affiliate, marketplace) reads from it.

## WHEN

- Spec accepted.
- [`payments-checkout.md`](../../../specs/commerce/payments-checkout.md) S1 live.
- PR #121 #28 (program-templates) and PR #123 #34 (regimens) at "spec accepted" so the `OfferFulfilmentKind` targets are coherent.
- §20 OQs closed (refund-window defaults, payment-plan default cadence).

## WHERE

- New sub-module `src/commerce/offers/`.
- New tables: `Offer`, `OfferPriceVariant`, `OfferFulfilment`, `OfferEntitlementGrant`.
- New routes: `/api/v1/coach/offers/*`, `/api/v1/offer/:slug` (public), `/api/v1/owner/offers/*`.
- Read-only on `WorkoutRoutine`, `MealPlan`, `Lesson`, PR #117 builder, PR #121 #28, PR #123 #34.

## WHO

- Sign-off: founder (commercial product), backend lead, fulfilment-spec authors (PR #117/#121/#123).
- Pager: backend lead. Pricing UX → frontend specialist.

## WHAT

**Offer kinds:** `ONE_TIME`, `SUBSCRIPTION`, `PAYMENT_PLAN`, `DEPOSIT_BALANCE`, `COHORT_SEAT`, `TEMPLATE_LICENSE`, `MARKETPLACE_LICENSE`. Each picks its own Stripe checkout shape via a pure pricing engine.

**Fulfilment kinds:** `MANUAL`, `REGIMEN`, `PROGRAM_TEMPLATE`, `CONTENT_BOARD`, `COHORT_ENROLLMENT`, `CHECK_IN_TEMPLATE`, `AI_PROGRAM_DRAFT`, `EXTERNAL_WEBHOOK`. Each has a per-kind config-schema validator.

**Routing flip:** `Offer.payment_routing` mirrors [`payments-checkout.md`](../../../specs/commerce/payments-checkout.md) §5.2; flipping a Connect offer to MoR is a single column update on a paused offer.

**Non-goals S1:** no coupons, no tiered subscriptions, no tax computation, no affiliate-share semantics (the column exists; semantics live in #44).

## HOW

S0 spec → S1 (`Offer` table + `MANUAL` fulfilment kind only, flag off) → S2 (auto-fulfilment kinds, multi-variant) → S3 GA. Smallest first PR: `Offer` table + four CRUD endpoints + `MANUAL` kind, ≤500 LOC.

## Risk + dependency highlights

- Pricing engine bug at checkout — pure function with exhaustive matrix tests + dry-run preview.
- Fulfilment partial failure — idempotent runner with per-`OfferFulfilment` retry; ledger writes tx-wrapped.
- Coach edits price on ACTIVE offer — protected fields list; UI surfaces "pause to edit" CTA.

## Operator handoff

`OFFER_BUILDER_ENABLED` + per-kind sub-flags. Per-offer `status='paused' | 'taken_down'`. Runbook `docs/commerce/offer-builder-runbook.md`. Pricing-engine error rate + fulfilment-success-rate dashboards.
