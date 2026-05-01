# Handoff brief: #45 Coach Marketplace

**Spec:** [`docs/specs/commerce/coach-marketplace.md`](../../../specs/commerce/coach-marketplace.md).

## WHY

A coach with a great $5k template, $200 journal, or $500 1-month reset can today only sell on their own storefront (limited audience) or Gumroad / Whop / Etsy (TGP earns $0). A TGP-owned coach marketplace lets buyers discover other coaches' assets, purchase them with TGP-as-merchant-of-record, have them auto-installed into their TGP account, and pays the seller-coach a revenue-share (default 80/20).

This is the lane closest in shape to **Whop** itself — a multi-sided marketplace where TGP earns by enabling discovery and trust, on top of the per-seat SaaS plan and the platform-fee on coach→client charges.

## WHEN

This is the **last** lane to ship in the wave. Gates:

- All four prior commerce specs at S1+.
- [`payments-checkout.md`](../../../specs/commerce/payments-checkout.md) `PLATFORM_MOR` path counsel-reviewed.
- [`offer-builder.md`](../../../specs/commerce/offer-builder.md) `OfferKind.MARKETPLACE_LICENSE` flag accepted.
- PR #121 #28 (program-templates) at S2+ (at least one SKU shape exists).
- PR #120 lane #11 (release QA) — marketplace gets canary + 24h watch.
- Counsel sign-off on seller-agreement TOS.
- §20 OQs closed (revshare default, refund window, self-serve gating, review visibility, auto-install default, featured policy).

## WHERE

- New sub-module `src/commerce/marketplace/`.
- New tables: `MarketplaceCategory`, `MarketplaceListing`, `MarketplaceListingMedia`, `MarketplaceReview`, `MarketplaceReport`, `MarketplaceInstall`, `MarketplaceRevShareConfig`.
- New routes: `/api/v1/coach/marketplace/listings/*` (seller), `/api/v1/marketplace/*` (buyer), `/api/v1/owner/marketplace/*`.
- Public SSR `/marketplace`, `/marketplace/c/:slug`, `/marketplace/l/:slug`.

## WHO

- Sign-off: founder (commercial + brand), backend lead, counsel (TOS + MoR + DMCA), trust-and-safety owner (named at GA).
- Pager: backend lead. Founder for category curation S1.

## WHAT

**Always MoR.** `MARKETPLACE_LICENSE` offers force `payment_routing=PLATFORM_MOR`. TGP files tax, files 1099-NEC for sellers > $600/yr, absorbs Stripe processor fee (industry-standard), pays seller 80% of gross via `Payout` after refund window.

**Reviews are gated to verified buyers.** One per install. Velocity heuristics flag bombing / paid-review fraud.

**Listings are gated by OWNER review** in S1 + S2; self-serve approval in S3 with prior-track-record gate.

**Off-platform-deal abuse** is the single biggest seller-side risk. Mitigations: description scanner, two-reporter auto-queue, TOS revoke-and-claw-back-earnings rule.

**Non-goals:** no auctions, no S1 subscriptions, no social shopping, no physical goods, no paid promotion S1.

## HOW

S0 spec → S1 (admission-only listings, hardcoded categories, OWNER-only create) → S2 (reviews, reports, auto-install, self-serve listing for L3+) → S3 GA. Smallest first PR: `MarketplaceListing` + `MarketplaceCategory` tables + OWNER-only create + public listing detail GET, ~500 LOC.

## Risk + dependency highlights

- Off-platform-deal abuse — scanner + report + revoke seller privileges.
- Review-fraud — velocity heuristics + verified-buyer gate + bombing detection.
- DMCA / IP — scanner + 24h SLA + counter-notice flow.
- MoR tax / nexus — Stripe Tax + finance-owner nexus map + counsel.
- Disputed marketplace charge — revshare clawback; seller TOS limits TGP exposure.
- Catalog brand drift — hand-curated categories S1; OWNER-managed featured slots.

## Operator handoff

`MARKETPLACE_ENABLED`, `MARKETPLACE_SELF_SERVE_LISTING_ENABLED`, `MARKETPLACE_REVIEWS_ENABLED`, `MARKETPLACE_AUTO_INSTALL_ENABLED` flags. Per-listing `status='paused' | 'taken_down'`. Per-seller entitlement revocable. Runbook `docs/commerce/marketplace-runbook.md` covers listing review, DMCA, off-platform-deal SOP, review fraud, revshare config, featured curation. Moderation queue depth + install fulfilment + revshare drift dashboards.
