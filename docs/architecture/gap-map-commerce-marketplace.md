# Gap map: Commerce & Marketplace wave (#40–#45)

> **Purpose:** for each lane in the commerce wave, answer "do we have this already?" against `main`, against the in-flight draft PRs #117–#123, and against the existing operator runbooks. Every "have it" is a row that the wave **reuses**; every "partial" is a row the wave **extends**; every "missing" is a row the wave **adds**.

This document mirrors the shape of the gap maps PR #119, PR #120, and PR #123 introduced. It is the ground truth a runtime PR can lean on so that "we already have X" is settled before the runtime PR opens.

## How to read this

Each row covers one lane. Columns:

- **Concern** — the named capability inside the lane.
- **In `main`?** — is there a merged module/file that already does this?
- **In a draft PR?** — does any of #117–#123 already cover this?
- **Net-new in this wave** — what this wave actually adds.
- **Notes** — coexistence rule.

## Wave summary — per row

| Row | Lane                  | Already?     | Closest existing artefact                                                                                            |
| --- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| #40 | Coach Storefronts     | **Partial**  | `src/public-pages/` (invite-landing only); PR #121 #27 owns the public-coach-profile *about* card and the slug allocator. This wave adds the commerce surface. |
| #41 | Payments + Checkout   | **Partial**  | `src/billing/` (per-seat coach SaaS); does not handle coach→client charges, Connect, MoR, or commerce ledger.        |
| #42 | Offer Builder         | **No**       | No `Offer` schema today. PR #121 #28 (templates) and PR #123 #34 (regimens) are *fulfilment targets*, not offers.    |
| #43 | Application Funnel    | **No**       | PR #121 #26 (intake) handles **post-purchase** intake. This wave adds **pre-purchase** application.                  |
| #44 | Affiliate / Referral  | **No**       | Nothing in `main` or any draft.                                                                                      |
| #45 | Coach Marketplace     | **No**       | `Offer` doesn't exist yet (PR #42 adds it). PR #120 lane #05 reserved the marketplace revshare shape; this wave fills it. |

## Row-by-row

### #40 Coach Storefronts

| Concern                          | In `main`? | In a draft? | Net-new in this wave | Notes |
| -------------------------------- | ---------- | ----------- | -------------------- | ----- |
| Public route for coach `/c/:slug` | ❌ | ❌ | ✅ | PR #121 #27 introduces `/coach/:slug` for the *about* page. This wave introduces `/c/:slug` as the storefront and folds the about card in as a default section. |
| Coach-slug allocator             | ❌ | ✅ PR #121 #27 | ❌ (consume) | Single allocator owned by #27. |
| `Storefront`, `StorefrontSection` schema | ❌ | ❌ | ✅ | New tables. |
| Avatar / header image            | Partial (`User` field referenced) | ✅ PR #123 #32 | ❌ (consume) | Storefront uses #32's media pipeline. |
| Storefront content sections (PDFs, videos) | ❌ | ✅ PR #123 #33 (content boards as a content surface) | ✅ partial | This wave embeds #33 boards as a section *kind*. |
| Custom domains                   | ❌ | ❌ | ✅ | New (`StorefrontDomain`). |
| OG image rendering               | ❌ | ❌ | ✅ | New, behind cache. |
| Visit attribution                | ❌ | ❌ | ✅ | `StorefrontVisit` feeds revenue dashboard (PR #121 #29). |
| SSR module                       | Partial (`src/public-pages/` for invite-landing) | ❌ | ✅ extend | Pattern reuse. |

### #41 Payments + Checkout (Stripe Connect + future MoR)

| Concern                                    | In `main`? | In a draft? | Net-new | Notes |
| ------------------------------------------ | ---------- | ----------- | ------- | ----- |
| Stripe-mirror tables (per-seat plan)       | ✅ `src/billing/`, `CoachSubscription`, `Invoice`, `PaymentFailure`, `StripeProcessedEvent` | ❌ | ❌ (do not touch) | Per-seat SaaS plan is unchanged. |
| Stripe webhook signature helper            | ✅ `src/billing/stripe-signature.ts` | ❌ | ❌ (extract) | Move to `src/common/stripe/` for reuse. |
| Stripe Connect Express onboarding          | ❌ | ❌ | ✅ | New (`CoachStripeAccount`). |
| Coach→client charge surface                | ❌ | ❌ | ✅ | New (`Charge`). |
| Refund / dispute / payout schema           | ❌ | ❌ | ✅ | New (`Refund`, `Dispute`, `Payout`). |
| Per-coach payout policy / hold             | ❌ | ❌ | ✅ | New (`CoachPayoutPolicy`). |
| Double-entry-style ledger                  | ❌ | ❌ | ✅ | New (`LedgerEntry` + `LedgerAccount`). |
| Reconciliation against Stripe reporting    | ❌ | ❌ | ✅ | Nightly cron + drift report. |
| Merchant-of-record path                    | ❌ | Reserved by PR #120 lane #05 | ✅ | `Offer.payment_routing` enum + `PLATFORM_MOR*` modes. |
| Tax remittance (MoR)                       | ❌ | ❌ | ✅ S2 | Stripe Tax on platform account; finance-owner nexus map. |
| 1099 reporting (MoR)                       | ❌ | ❌ | ✅ S2 | Stripe Connect 1099 service. |
| Operator runbook for billing               | ✅ `docs/stripe-setup.md` | ❌ | ✅ extend | New runbooks per spec §20: onboarding, refund, reconciliation, MoR-flip, incident. |

### #42 Offer Builder

| Concern                                          | In `main`? | In a draft? | Net-new | Notes |
| ------------------------------------------------ | ---------- | ----------- | ------- | ----- |
| Per-seat coach SaaS pricing                       | ✅ `src/billing/` flat $300/mo | ❌ | ❌ (untouched) | This wave does NOT touch the per-seat plan. |
| `Offer` schema                                   | ❌ | ❌ | ✅ | New. |
| Multi-variant pricing (one-time, sub, plan, deposit-balance) | ❌ | ❌ | ✅ | `OfferPriceVariant`. |
| Fulfilment-on-purchase                           | ❌ | ❌ | ✅ | `OfferFulfilment`. Per-kind validators. |
| Fulfilment kind: regimen                         | ❌ | ✅ PR #123 #34 schema | ✅ wire | This wave adds the wiring; #34 owns the regimen schema. |
| Fulfilment kind: program template                | ❌ | ✅ PR #121 #28 schema | ✅ wire | Same pattern. |
| Fulfilment kind: AI program draft                | ❌ | ✅ PR #117 schema | ✅ wire | Same pattern. |
| Fulfilment kind: cohort enrolment                | ❌ | ✅ PR #122 §3 sketch | ✅ wire + table | Cohort runtime is a future wave. |
| Pricing engine → Stripe payload                  | Partial (`src/billing/billing.service.ts` for per-seat) | ❌ | ✅ | Pure function, exhaustive matrix. |
| Per-offer take-rate (`platform_fee_bps`)         | ❌ | Reserved by PR #120 lane #05 | ✅ | New. |
| Entitlement grant on purchase                    | Partial (`docs/entitlements.md` read model) | Reserved by PR #120 lane #01 | ✅ | New (`OfferEntitlementGrant`). |

### #43 Application Funnel

| Concern                              | In `main`? | In a draft? | Net-new | Notes |
| ------------------------------------ | ---------- | ----------- | ------- | ----- |
| Form-question vocabulary             | ❌ | ✅ PR #121 #26 | ❌ (consume) | Reused; #26 owns. |
| `IntakeQuestionnaireTemplate`        | ❌ | ✅ PR #121 #26 | ❌ (separate model) | Different workflow; not collapsed. |
| Application state machine            | ❌ | Sketched in PR #122 §3 | ✅ runtime | First runtime backing of #122 §3. |
| Setter attribution                   | ❌ | Reserved by PR #118 (`acted_by_member_user_id`) | ✅ wire | New columns; uses #118 contract. |
| AI scoring (advisory)                | ❌ | Reserved by PR #117 + PR #120 lane #08 | ✅ S2 | Advisory only; never auto-decides. |
| Public form SSR + submit             | ❌ | ❌ | ✅ | New. |
| One-time signed checkout token       | ❌ | ❌ | ✅ | New, bound to `(application, offer, prospect_email)`. |
| Application data 90-day TTL          | ❌ | Reserved by PR #120 lane #04 | ✅ row | First filled-in row of the lifecycle matrix. |

### #44 Affiliate / Referral

Nothing in `main` or any draft is affiliate-specific. The wave introduces:

| Concern                              | In `main`? | In a draft? | Net-new |
| ------------------------------------ | ---------- | ----------- | ------- |
| `Affiliate`, `AffiliateLink`         | ❌ | ❌ | ✅ |
| Click attribution + cookie           | ❌ | ❌ | ✅ |
| Conversion + share computation       | ❌ | ❌ | ✅ |
| Hold-and-release payout batches      | ❌ | ❌ | ✅ |
| Self-referral / fraud guards         | ❌ | ❌ | ✅ |
| `Offer.affiliate_share_bps` column   | ❌ | Reserved in [`offer-builder.md`](../specs/commerce/offer-builder.md) §8 (this wave) | ✅ |
| Affiliate Connect onboarding (S2)    | ❌ | ❌ (reuses #41 Express flow) | ✅ wire |

### #45 Coach Marketplace

| Concern                                        | In `main`? | In a draft? | Net-new |
| ---------------------------------------------- | ---------- | ----------- | ------- |
| Marketplace listing schema                     | ❌ | ❌ | ✅ |
| Categories, browse, search                     | ❌ | ❌ | ✅ |
| Verified-buyer review system                   | ❌ | ❌ | ✅ |
| Reports + DMCA flow                            | ❌ | ❌ | ✅ |
| MoR routing on every charge                    | Reserved by [`payments-checkout.md`](../specs/commerce/payments-checkout.md) §5 | ❌ | ✅ wire |
| Revenue-share configuration (default 80/20)    | Reserved by PR #120 lane #05 | ❌ | ✅ row |
| Auto-install on purchase                       | ❌ | ❌ | ✅ |
| Per-listing media (gallery, preview-PDF / video) | ❌ | ❌ | ✅ |
| Off-platform-deal scanner                      | ❌ | ❌ | ✅ |

## Cross-cutting platform-readiness lane crosswalk (PR #120)

Each commerce lane maps onto multiple platform-readiness lanes from PR #120:

| PR #120 lane                                       | #40 | #41 | #42 | #43 | #44 | #45 |
| -------------------------------------------------- | --- | --- | --- | --- | --- | --- |
| #01 feature flags + entitlements                   | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |
| #02 API versioning + contracts                     | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |
| #03 security, RBAC, tenant boundaries              | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |
| #04 data lifecycle, privacy, export, delete        | ✅  | ✅  | ✅  | ✅ (90d decline TTL) | ✅ (30d click TTL) | ✅  |
| #05 billing packaging + monetization               | —   | ✅ (the runtime shape) | ✅ (per-offer fee) | —   | ✅ (share bps) | ✅ (revshare) |
| #06 observability + incident response              | ✅  | ✅ (heaviest) | ✅  | ✅  | ✅  | ✅  |
| #07 migration, seed, backfill safety               | ✅  | ✅ (heaviest — money tables) | ✅  | ✅  | ✅  | ✅  |
| #08 AI governance + prompt ops                     | —   | —   | ✅ (`AI_PROGRAM_DRAFT` fulfilment) | ✅ (S2 scoring) | —   | ✅ (listings of AI assets) |
| #09 support + self-serve operations                | ✅ (takedown SOP) | ✅ (refund SOP) | ✅  | ✅  | ✅  | ✅ (heaviest) |
| #10 analytics + telemetry                          | ✅  | ✅  | ✅  | ✅  | ✅  | ✅  |
| #11 release QA + regression gates                  | ✅  | ✅ (heaviest) | ✅  | ✅  | ✅  | ✅ (canary required) |

## What this wave does NOT cover

Out-of-scope, will be addressed in future waves or in a separate spec:

- **Coupon codes** (S2 of #42). Not in this wave.
- **Subscription marketplace listings** (S2 of #45).
- **Live event ticketing** beyond what PR #122 §4 + the deposit-balance flow in #42 already cover.
- **Multi-currency payouts** beyond Stripe Connect's per-country support; multi-currency *charging* is supported from day 0 via the `currency` column.
- **Crypto / on-chain payments.** Hard no.
- **Coach-to-coach community surfaces** (parking-lot row in PR #119).
- **Multi-tier MLM affiliate.** Hard no.
- **In-app advertising between coaches inside the marketplace.** Out of scope.
- **Custom-domain DNS provisioning automation** beyond Cloudflare-for-SaaS pattern.
- **Coach-side tax filing** (the coach's 1099-K from Stripe is automatic on Connect; we do not file the coach's income tax).
- **Mobile push fan-out** to clients on offer publish (parking-lot row in PR #119).
- **Paid promoted-listing slots** in the marketplace (S2+; explicit non-goal in #45 §6).

## Coexistence with in-flight drafts — exact diff intent

| Draft PR | Diff intent against this wave                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **#117** | Adjacent. Storefront's offer can publish a Program Draft; offer-builder reuses per-kind validators. **This wave does not modify #117.**         |
| **#118** | Hard dependency. Every commerce table reserves `acted_by_member_user_id`. **This wave does not modify #118.**                                   |
| **#119** | Index dependency. Rows #40–#45 reserved here in the same numbering scheme. Folded by [`expansion-roadmap-addendum-commerce.md`](./expansion-roadmap-addendum-commerce.md). **Not modified.** |
| **#120** | Hard dependency. Lanes #01, #03, #04, #05, #06, #07, #08 (where applicable), #09, #10, #11 all referenced by lane. **Not modified.**           |
| **#121** | Adjacent. #28 (templates) is a precursor to #42 fulfilment; #26 (intake) reconciled with #43 in spec §6; #29 (revenue dashboard) reads commerce ledger. **Not modified.** |
| **#122** | Hard dependency. §2 (tier model) and §7 (commercial model) describe the offers #42 must support; §3 (qualification funnel) is the runtime backing of #43. MoR routing in #41 §5 is the runtime shape behind #122 §7. **Not modified.** |
| **#123** | Adjacent. #34/#35 are fulfilment kinds for #42; #37 (tiering L2/L3) is the entitlement axis that gates which lanes a coach unlocks. #36 (messaging) is a downstream consumer of approval / install events. **Not modified.** |
