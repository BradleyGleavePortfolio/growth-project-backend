# Spec: Offer Builder

> **Status:** Draft — docs only. Roadmap row #42. No runtime, schema, env-var, or module-wiring change in this PR.
>
> Read [`payments-checkout.md`](./payments-checkout.md) and [`coach-storefronts.md`](./coach-storefronts.md) first.

## 1. Cross-references

- **PR #117** AI Program Builder RFC — fulfilment can publish a Program Draft on offer purchase.
- **PR #118** Team Mode foundation — `acted_by_member_user_id` reserved.
- **PR #120** platform readiness — lanes #01 (flags + entitlements), #05 (billing packaging — take-rate per offer), #07 (migration safety).
- **PR #121** spec #28 (program-templates) — **adjacent precursor.** A template is a fulfilment kind an offer can grant.
- **PR #122** masterminds operating model — §2 tier model, §7 commercial model: cohort offers map to a specific `OfferKind`.
- **PR #123** coach-experience wave — #34 regimens (an offer kind can grant a regimen), #35 regimen-assignment (created on offer purchase), #37 tiering (entitlement axis).

## 2. WHY

A coach today configures offers in three different places: a Stripe Checkout link, a Kajabi product, a manually-typed Calendly invite for the discovery call. Each place has different pricing logic, different post-purchase fulfilment, different refund rules. The coach's "offer" is whichever of those three was most recently edited.

The offer-builder makes the offer a **first-class TGP object**: one row, one shape, one source of truth for price, billing cadence, fulfilment, refund window, application requirement, affiliate share rate, payment routing, entitlement granted on purchase. Every other commerce surface (storefront card, application page, affiliate link, marketplace listing) reads from it. Every charge in [`payments-checkout.md`](./payments-checkout.md) carries `offer_id`. Every fulfilment downstream — assigning a regimen, granting access to a content board, creating a cohort enrolment row — fires off the same offer-purchase event.

### What "shipped" unlocks

- Coach configures offer once; it appears consistently on storefront, application, affiliate, marketplace.
- Pricing variants without coach learning Stripe pricing taxonomy: one-time, subscription, payment plan, upfront-deposit-then-balance.
- Fulfilment is automatic: purchase a regimen offer → client is auto-assigned the regimen on their next app open.
- TGP take-rate per offer is a column flip; revenue-share with affiliates is a column flip.

## 3. WHEN

1. ✅ This spec is reviewed and accepted by founder + backend lead.
2. ✅ [`payments-checkout.md`](./payments-checkout.md) Stage 1 live (Connect onboarding) so offers can attach to a connected account.
3. ✅ PR #121 spec #28 (program-templates) at "spec accepted" so `OfferFulfilmentKind=PROGRAM_TEMPLATE` is a coherent target.
4. ✅ PR #123 spec #34 (regimens) at "spec accepted" so `OfferFulfilmentKind=REGIMEN` is a coherent target.
5. ✅ Open questions §20 closed (default refund window per offer kind, payment-plan default cadence).

## 4. WHERE

- **New module:** `src/commerce/offers/` (sub-module of the new `src/commerce/`).
- **New tables:** `Offer`, `OfferPriceVariant`, `OfferFulfilment`, `OfferEntitlementGrant`. ([`payments-checkout.md`](./payments-checkout.md) §8 has `Charge.offer_id` already pre-declared.)
- **Touches existing:** read-only on `WorkoutRoutine`, `MealPlan`, `Lesson`, `User`, `CoachProfile`. Read-only on PR #117's `BuilderPromptTemplate`. Read-only on PR #121 #28 `ProgramTemplate`. Read-only on PR #123 #34 `Regimen`.
- **New routes:** `/api/v1/coach/offers/*`, `/api/v1/offer/:slug` (public read), `/api/v1/owner/offers/*`.

## 5. WHO

| Role             | Responsibility                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sign-off         | Founder (commercial product), backend lead (architecture), PR #117 / #121 / #123 spec authors (fulfilment contracts). |
| On the hook      | Backend lead. Pricing UX → frontend specialist.                                                                       |
| Downstream       | Storefront (#40), application-funnel (#43), affiliate (#44), marketplace (#45) all read offers.                       |
| Hard boundaries  | Does **not** own checkout (#41 owns), application form schema (#43 owns), affiliate share semantics (#44 owns).        |

## 6. WHAT

### Already exists

- Per-seat coach SaaS pricing in `src/billing/`. **This spec does not touch it.**
- `WorkoutRoutine`, `MealPlan`, `Lesson`, `Habit` exist as fulfilment targets.

### Net-new

- The four tables in §8.
- A pricing engine (`offer-pricing.service.ts`) that computes the Stripe call body from an `Offer` + chosen variant.
- A fulfilment runner that fires on `payment_intent.succeeded` and writes the per-kind fulfilment rows.

### Non-goals

- **No coupon codes in S1.** Coupons land in S2 (one row, `OfferCoupon`, separate spec slice).
- **No tax-inclusive pricing math** beyond passing the `tax_behavior` value through to Stripe. TGP does not compute tax.
- **No tiered subscription pricing** (e.g. seat-based) in S1. One offer = one price-per-cycle. Multi-seat-cohort = a future row.
- **No affiliate share semantics in this spec** — the column exists; the meaning lives in [`affiliate-referral.md`](./affiliate-referral.md).

## 7. HOW — phases

- **S0 spec.** Accepted.
- **S1 skeleton.** `Offer`, `OfferPriceVariant`, `OfferFulfilment` tables; coach CRUD; status state machine; one fulfilment kind (`MANUAL` — coach is told who paid, no auto-fulfilment). Flag `OFFER_BUILDER_ENABLED=false`.
- **S2 private beta.** Add fulfilment kinds `REGIMEN`, `PROGRAM_TEMPLATE`, `CONTENT_BOARD`, `COHORT_SEAT`. Add `OfferEntitlementGrant` mapping. Pilot with 5 coaches.
- **S3 GA.** Flag-on, all entitled coaches.

### 7.1 Smallest first runtime PR

PR-1: `Offer` table only, with `kind=MANUAL`, four endpoints (create, list, get, update). No price variants yet (single embedded price columns). Tests for status state machine. Flag default off. ≤500 LOC.

### 7.2 Kill-switch

`OFFER_BUILDER_ENABLED=false` blocks coach create/update; existing offers serve read-only on storefronts. Existing checkouts in flight continue to webhook back successfully.

## 8. Data model sketch (additive, **not** committed)

```prisma
model Offer {
  id                       String                     @id @default(cuid())
  coach_user_id            String                     // FK → User.id
  slug                     String                     // unique within coach (URL-safe)
  title                    String
  subtitle                 String?                    @db.Text
  description_md           String?                    @db.Text
  hero_media_id            String?                    // FK → StorefrontMedia.id (storefront-shared)
  kind                     OfferKind
  status                   OfferStatus                @default(DRAFT)

  // Pricing (one offer can have multiple OfferPriceVariant rows; these are the defaults)
  default_variant_id       String?                    @unique  // FK → OfferPriceVariant.id

  // Routing (mirrors payments-checkout.md §5.2)
  payment_routing          PaymentRouting             @default(CONNECT_DESTINATION_CHARGE)

  // Take-rate (overrides global default)
  platform_fee_bps         Int?                       // basis points, e.g. 1000 = 10.00%
  platform_fee_flat_cents  Int?

  // Refund + dispute
  refund_window_days       Int                        @default(14)
  dispute_liability_owner  DisputeLiabilityOwner?     // null = inherit from payment_routing

  // Application gate
  requires_application     Boolean                    @default(false)
  application_form_id      String?                    // FK → ApplicationForm.id (#43 spec)

  // Affiliate share
  affiliate_share_bps      Int                        @default(0)  // 0 = no affiliate share

  // Tax
  tax_behavior             TaxBehavior                @default(UNSPECIFIED)

  // Fraud / moderation
  requires_captcha         Boolean                    @default(false)
  is_high_ticket           Boolean                    @default(false)  // ≥ $1000 threshold by default

  // Forward-compat
  acted_by_member_user_id  String?

  created_at               DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  archived_at              DateTime?

  coach                    User                       @relation(fields: [coach_user_id], references: [id], onDelete: Cascade)
  default_variant          OfferPriceVariant?         @relation("DefaultVariant", fields: [default_variant_id], references: [id])
  variants                 OfferPriceVariant[]        @relation("OfferVariants")
  fulfilments              OfferFulfilment[]
  entitlement_grants       OfferEntitlementGrant[]

  @@unique([coach_user_id, slug])
  @@index([status, kind])
}

enum OfferKind {
  ONE_TIME            // single charge, e.g. PDF, mini-course
  SUBSCRIPTION        // recurring, e.g. monthly coaching
  PAYMENT_PLAN        // fixed total split into N installments
  DEPOSIT_BALANCE     // upfront deposit then a balance charge (mastermind seat)
  COHORT_SEAT         // seat in a Cohort row (PR #122 §3)
  TEMPLATE_LICENSE    // one-time purchase of a ProgramTemplate (PR #121 #28)
  MARKETPLACE_LICENSE // marketplace lane; routing always PLATFORM_MOR
}

enum OfferStatus {
  DRAFT
  ACTIVE              // visible on storefront, accepts checkouts
  PAUSED              // hidden from storefront; existing customers untouched
  ARCHIVED            // soft-delete; existing customers untouched
  TAKEN_DOWN          // operator moderation
}

enum TaxBehavior {
  INCLUSIVE
  EXCLUSIVE
  UNSPECIFIED
}

model OfferPriceVariant {
  id                       String                     @id @default(cuid())
  offer_id                 String
  label                    String                     // "Monthly", "Annual", "Pay-in-Full", "Deposit"
  amount_cents             Int                        // for ONE_TIME, SUBSCRIPTION, COHORT_SEAT, TEMPLATE_LICENSE
  currency                 String                     // ISO-4217
  cadence                  Cadence                    // ONE_TIME, MONTHLY, YEARLY, CUSTOM_DAYS
  cadence_custom_days      Int?
  // For PAYMENT_PLAN
  installment_count        Int?                       // total installments
  installment_total_cents  Int?                       // total amount across installments
  // For DEPOSIT_BALANCE
  deposit_amount_cents     Int?
  balance_due_offset_days  Int?                       // days after purchase
  // Stripe price id, lazily created on first checkout (lazy creation = no Stripe calls in coach UI)
  stripe_price_id          String?
  stripe_price_id_synced_at DateTime?

  created_at               DateTime                   @default(now())
  archived_at              DateTime?

  offer                    Offer                      @relation("OfferVariants", fields: [offer_id], references: [id], onDelete: Cascade)
  default_for              Offer?                     @relation("DefaultVariant")
  @@index([offer_id])
}

enum Cadence {
  ONE_TIME
  MONTHLY
  YEARLY
  CUSTOM_DAYS
}

model OfferFulfilment {
  id                       String                     @id @default(cuid())
  offer_id                 String
  kind                     OfferFulfilmentKind
  // Polymorphic-by-convention pointer, validated by per-kind validator
  target_id                String                     // e.g. WorkoutRoutine.id, ProgramTemplate.id, Cohort.id, ContentBoard.id
  config                   Json                       // per-kind config (see §8.1)
  position                 Int                        @default(0)  // for multi-fulfilment offers
  offer                    Offer                      @relation(fields: [offer_id], references: [id], onDelete: Cascade)
  @@index([offer_id])
}

enum OfferFulfilmentKind {
  MANUAL                  // coach gets a notification; assigns by hand
  REGIMEN                 // PR #123 #34 — auto-assign regimen on purchase
  PROGRAM_TEMPLATE        // PR #121 #28 — instantiate a template into a fresh program
  CONTENT_BOARD           // PR #123 #33 — grant access to a content board
  COHORT_ENROLLMENT       // PR #122 — enrol customer into a Cohort
  CHECK_IN_TEMPLATE       // PR #121 #21 — start a check-in template
  AI_PROGRAM_DRAFT        // PR #117 — kick off an AI Program Builder draft
  EXTERNAL_WEBHOOK        // OWNER-only kind; HTTP POST to a coach-supplied URL (rare; sandboxed)
}

model OfferEntitlementGrant {
  id                       String                     @id @default(cuid())
  offer_id                 String
  // Entitlement key, drawn from the canonical vocabulary in PR #120 lane #01
  entitlement_key          String
  // Optional time-limit for grant; null = lifetime
  duration_days            Int?
  offer                    Offer                      @relation(fields: [offer_id], references: [id], onDelete: Cascade)
  @@unique([offer_id, entitlement_key])
}
```

### 8.1 Per-kind config schema

Each `OfferFulfilment.kind` defines a stable JSON-schema for `config`. Examples:

- `REGIMEN`: `{ regimen_id: string, schedule_offset_days?: number }`
- `PROGRAM_TEMPLATE`: `{ template_id: string, sections_to_publish: string[] }`
- `CONTENT_BOARD`: `{ board_id: string }`
- `COHORT_ENROLLMENT`: `{ cohort_id: string, seat_kind: 'standard'|'vip' }`
- `AI_PROGRAM_DRAFT`: `{ template_id: string, default_section_kinds: string[] }`
- `EXTERNAL_WEBHOOK`: `{ url: string, secret_id: string }` — secret stored in Supabase Vault.

A per-kind JSON-schema validator runs on `Offer` create / update and rejects invalid configs.

### 8.2 Retention

| Table                  | Retention                | GDPR scrub                                                           |
| ---------------------- | ------------------------ | -------------------------------------------------------------------- |
| `Offer`                | Lifetime of coach        | Title/desc may contain PII; pseudonymise on RTBE.                    |
| `OfferPriceVariant`    | Lifetime of offer        | None.                                                                |
| `OfferFulfilment`      | Lifetime of offer        | None.                                                                |
| `OfferEntitlementGrant`| Lifetime of offer        | None.                                                                |

Hard-delete cascades only on coach delete; coach archive does not delete.

## 9. API sketch + payment routing

### 9.1 Coach-facing

```
POST   /api/v1/coach/offers                        → create draft
GET    /api/v1/coach/offers                        → list, filter by status/kind
GET    /api/v1/coach/offers/:id                    → single offer + variants + fulfilments
PATCH  /api/v1/coach/offers/:id                    → update (rejects if status=ACTIVE and protected fields change)
POST   /api/v1/coach/offers/:id/publish            → DRAFT → ACTIVE; runs validator
POST   /api/v1/coach/offers/:id/pause              → ACTIVE → PAUSED
POST   /api/v1/coach/offers/:id/archive            → soft-delete
POST   /api/v1/coach/offers/:id/variants           → add variant
PATCH  /api/v1/coach/offers/:id/variants/:vid      → update variant (rejects if active charges exist)
POST   /api/v1/coach/offers/:id/fulfilments        → add fulfilment
PATCH  /api/v1/coach/offers/:id/fulfilments/:fid   → update fulfilment
DELETE /api/v1/coach/offers/:id/fulfilments/:fid   → remove
POST   /api/v1/coach/offers/:id/preview-checkout   → returns dry-run Stripe payload (no Stripe call)
```

Throttle: 30/min/coach (read), 6/min/coach (write). RBAC: `team.offers.manage`.

**Protected fields** (cannot be edited while status=ACTIVE; coach must pause first): `kind`, `payment_routing`, `default_variant_id`, `requires_application`. Reason: editing these silently invalidates in-flight checkouts.

### 9.2 Public

```
GET /api/v1/offer/:coach_slug/:offer_slug          → public offer summary (price, currency, requires_application)
```

Cache: 60s; key includes `Offer.updated_at`.

### 9.3 Operator

```
GET   /api/v1/owner/offers                         → search, filter
POST  /api/v1/owner/offers/:id/takedown            → status=TAKEN_DOWN, reason required
POST  /api/v1/owner/offers/:id/restore             → undo
POST  /api/v1/owner/offers/:id/routing-flip        → change payment_routing (e.g. flip to PLATFORM_MOR)
```

The routing-flip is **the** mechanism by which a Connect-destination offer becomes MoR. It writes `AuditLog COMMERCE_OFFER_ROUTING_CHANGED` and is gated on counsel sign-off (recorded in audit free-text field).

### 9.4 Pricing engine — picking the Stripe call

A pure function `priceOfferForCheckout(offer, variant)` returns:

```ts
{
  mode: 'payment' | 'subscription' | 'setup',
  line_items: Stripe.Checkout.Session.LineItem[],
  payment_intent_data?: Stripe.Checkout.Session.PaymentIntentDataCreateParams,
  subscription_data?: Stripe.Checkout.Session.SubscriptionDataCreateParams,
  application_fee_amount?: number,
  transfer_data?: { destination: string },
}
```

Per `OfferKind`:

| Kind                | Stripe `mode`  | Notes                                                                                          |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `ONE_TIME`          | `payment`      | Single line item; price lazily created.                                                        |
| `SUBSCRIPTION`      | `subscription` | Recurring price; cadence from variant.                                                         |
| `PAYMENT_PLAN`      | `payment`      | First installment + a Stripe-Schedule of N-1 follow-ups via `subscription_schedule`.           |
| `DEPOSIT_BALANCE`   | `payment`      | Deposit charge; balance charge scheduled via internal job at `balance_due_offset_days`.        |
| `COHORT_SEAT`       | `payment`      | Same as `DEPOSIT_BALANCE` typically; deposit + balance.                                        |
| `TEMPLATE_LICENSE`  | `payment`      | One-time; routing forced to `PLATFORM_MOR` (PR #120 lane #05 reserved this).                   |
| `MARKETPLACE_LICENSE` | `payment`    | One-time; routing forced to `PLATFORM_MOR`. Marketplace fee model in [`coach-marketplace.md`](./coach-marketplace.md). |

If `payment_routing == CONNECT_DESTINATION_CHARGE`, populate `transfer_data.destination` and `application_fee_amount`. If `PLATFORM_MOR*`, omit both (TGP keeps the funds; payout to coach is a separate `Payout` row created by the fulfilment runner per the offer's revenue-share rule).

## 10. Tax, refund, chargeback, dispute

- `Offer.tax_behavior` is passed through to Stripe at checkout. TGP does not compute tax on Connect path.
- `Offer.refund_window_days` is the per-offer override of the platform default (PR #41 §11.2). Edit while ACTIVE writes an audit row and does **not** retroactively change in-flight charges.
- `Offer.dispute_liability_owner` overrides the routing default. Setting `PLATFORM` on a `CONNECT_DESTINATION_CHARGE` offer means TGP voluntarily takes the chargeback risk — only allowed on offers with `is_high_ticket=true` and OWNER ack.
- Disputes flow through [`payments-checkout.md`](./payments-checkout.md) §11. Offer is identified by `Charge.offer_id`.

## 11. Ledger and reconciliation

Offer purchases write `LedgerEntry` rows via the checkout pipeline ([`payments-checkout.md`](./payments-checkout.md) §10). The offer-builder additionally:

- Records `OfferAffiliateShare` rows on the `LedgerEntry` join table when `Offer.affiliate_share_bps > 0` (semantics in [`affiliate-referral.md`](./affiliate-referral.md)).
- Records `OfferRevShare` rows on platform-MoR offers (TGP keeps gross, then transfers `(1 - platform_fee_bps) * gross` to the coach via `Payout` after the offer-defined `payout_offset_days` window).

All ledger writes happen in the same DB tx as the `Charge` row insert.

## 12. RBAC, privacy, GDPR scrub

- Tenant: `coach_user_id`. Row-level guard.
- Public offer surface returns only `status=ACTIVE` rows. Drafts 404 to non-owner.
- Coach RTBE cascades `Offer` rows but preserves `Charge` rows (tax retention) with `Charge.offer_id` left dangling — guarded by FK `onDelete: SetNull`. Charges remain joinable for ledger; offer-side title becomes "[deleted offer]" in operator views.
- `Offer.description_md` may contain PII testimonials; pseudonymise on coach RTBE.

### 12.1 Audit log additions

```
OFFER_PUBLISHED
OFFER_PAUSED
OFFER_ARCHIVED
OFFER_TAKEN_DOWN
OFFER_VARIANT_PRICE_CHANGED
OFFER_FULFILMENT_CHANGED
OFFER_ROUTING_CHANGED              // dual-listed in payments-checkout.md §11
OFFER_DISPUTE_LIABILITY_CHANGED
```

## 13. Abuse, fraud, moderation

- **Pricing claims.** Soft-warning on offer publish if title or description contains numeric outcome promises ("guaranteed $10k/month", "lose 30 lbs in 30 days"). Soft, not blocking.
- **Earnings claims** specifically: required disclaimer auto-appended to offer description if regex matches; coach can edit but cannot remove for offers > $500 (added per coach-of-coaches risk in PR #122 §12).
- **Anti-laundering.** New coach (Connect status verified < 14d ago) is capped at **$5,000 per offer price** in S1. Floor lifts on KYC-additional-docs and operator review.
- **Marketplace offers** (`MARKETPLACE_LICENSE`) require a moderation pass before `status=ACTIVE`; details in [`coach-marketplace.md`](./coach-marketplace.md).
- **Webhook fulfilment** (`EXTERNAL_WEBHOOK` kind) is OWNER-only; not coach-self-serve.

## 14. Feature flags + entitlements

| Flag                                | Default | Effect                                                                              |
| ----------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `OFFER_BUILDER_ENABLED`             | `false` | Coach create/update 503; existing offers continue to serve checkouts.               |
| `OFFER_KIND_TEMPLATE_LICENSE_ENABLED` | `false` | Block creating `TEMPLATE_LICENSE` offers (gates marketplace lane).                |
| `OFFER_KIND_MARKETPLACE_LICENSE_ENABLED` | `false` | Block creating `MARKETPLACE_LICENSE` offers.                                  |
| `OFFER_FULFILMENT_AI_DRAFT_ENABLED` | `false` | Block `AI_PROGRAM_DRAFT` fulfilment (gates PR #117 dependency).                     |

Entitlements (PR #123 #37):

- `offer.basic` — single one-time or subscription offer, manual fulfilment. L1.
- `offer.advanced` — multi-variant, payment plan, deposit-balance, auto-fulfilment. L2.
- `offer.cohort` — `COHORT_SEAT` kind. L3 + manual flip.
- `offer.marketplace` — `MARKETPLACE_LICENSE`. L3.

## 15. Tests

### 15.1 Unit

- `offer-pricing.service.spec.ts` — Stripe payload generated for each kind × routing × variant matrix.
- `offer-validator.spec.ts` — protected field changes blocked while ACTIVE; per-kind config schema enforced.
- `offer-state-machine.spec.ts` — state transitions match table; archive irreversible.
- `fulfilment-runner.spec.ts` — each kind produces the expected downstream row; partial-failure rollback semantics.

### 15.2 Integration

- Full purchase → fulfilment loop for `REGIMEN` kind: client app open shows the assigned regimen.
- `DEPOSIT_BALANCE` flow: deposit charged, balance charged at offset, both ledger rows written.
- Routing-flip (`CONNECT_DESTINATION_CHARGE` → `PLATFORM_MOR`) on a paused offer; resume; new charge flows through MoR shape.
- Operator takedown blocks new checkouts; existing customers retain access.

### 15.3 Smoke

- Per-coach canary offer ($1) on staging; smoke charge runs nightly; alarm if fulfilment fails.

## 16. Risks

| Risk                                              | Mitigation                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Pricing engine bug at checkout (over/undercharge) | Pure function + exhaustive matrix unit tests + dry-run preview endpoint.                |
| Fulfilment partial failure                        | Idempotent runner with per-`OfferFulfilment` retry; ledger writes are tx-wrapped with `Charge`. |
| Schema drift between offer + downstream targets   | Per-kind validator runs on offer publish AND on target update via DB trigger or app-level hook. |
| Coach edits price on ACTIVE offer                 | Protected fields list; UI surfaces "pause to edit" CTA.                                 |
| Stripe price id rot (orphaned products)           | Lazy creation + nightly Stripe-product-archive job for archived offers.                 |
| MoR misconfiguration on a Connect offer           | OWNER-only route; counsel sign-off audit row required before flip.                      |
| AI-draft fulfilment failure                       | Fulfilment retried; coach notified on persistent failure; manual fallback always available. |
| Entitlement gate drift                            | Read through PR #120 lane #01 resolver only; no per-controller checks.                  |

## 17. Dependencies

- **Internal:** [`payments-checkout.md`](./payments-checkout.md), [`coach-storefronts.md`](./coach-storefronts.md), PR #117 (for `AI_PROGRAM_DRAFT`), PR #121 #28 (for `PROGRAM_TEMPLATE`), PR #122 (for `COHORT_SEAT`), PR #123 #34 (for `REGIMEN`), PR #123 #37 (entitlements).
- **External:** Stripe (price + checkout API), Stripe Subscription Schedules (for `PAYMENT_PLAN`), Stripe Tax (for MoR routing).
- **Human:** Founder closes §20 OQs (refund-window defaults; payment-plan default cadence). Counsel sign-off on first MoR offer.

## 18. Acceptance criteria

1. Coach can create an `Offer` with one variant, publish, and link from storefront in <2 min.
2. Customer can purchase via the offer's checkout link; the `Charge` row carries `offer_id`.
3. `REGIMEN` fulfilment runs within 30s of `payment_intent.succeeded`; client app shows the assigned regimen on next open.
4. Editing a protected field on an ACTIVE offer returns 409 and surfaces the "pause to edit" message.
5. Operator routing-flip writes audit row and counsel-ack free-text; new charges flow through new routing.
6. Per-kind validator rejects malformed `OfferFulfilment.config`.
7. PR #118 forward-compat columns present.
8. PR #120 lane #01 entitlement resolver gates each kind correctly.
9. Operator runbook entry merged.

## 19. Operator handoff

- **Kill-switches:** flags above; per-offer `status='paused' | 'taken_down'`.
- **Dashboards:** Grafana — offers active, offers archived, fulfilment runner success rate, pricing engine error rate. PostHog — offer view → checkout start → checkout complete by `OfferKind`.
- **Runbook:** `docs/commerce/offer-builder-runbook.md` — moderation queue, takedown SOP, routing-flip checklist (counsel ack required), fulfilment retry runbook.
- **Alerts:** fulfilment runner failure rate > 1% over 10 min; offer-publish rejections > 5% over 1h (likely validator drift).

## 20. Open questions

- **OQ-1** Default refund window per `OfferKind`. Founder bias: 14d for ONE_TIME / SUBSCRIPTION; 7d for COHORT_SEAT; 0d for TEMPLATE_LICENSE. **Owner: founder.**
- **OQ-2** Default payment-plan cadence. Bias: monthly. **Owner: founder.**
- **OQ-3** Whether `EXTERNAL_WEBHOOK` fulfilment is in S2 or punted to a later wave. Bias: punt — no clear demand. **Owner: backend lead.**
