# Spec: Coach Marketplace

> **Status:** Draft — docs only. Roadmap row #45. No runtime, schema, env-var, or module-wiring change in this PR.
>
> Read all four prior commerce specs first. The marketplace is the **highest-leverage** lane (TGP keeps the largest take-rate share here) and the one that **stretches the platform's regulatory posture** most (TGP is merchant-of-record for every sale; reviews moderation matters).

## 1. Cross-references

- **PR #117** AI Program Builder RFC — adjacent. Marketplace listings of "AI program template" become a future row.
- **PR #118** Team Mode foundation — `acted_by_member_user_id` reserved.
- **PR #120** lanes #01 (entitlements), #03 (RBAC), #04 (lifecycle), #05 (billing packaging — marketplace revenue-share shape **explicitly reserved here**), #08 (AI governance — when listings include AI-generated content), #11 (release QA — marketplace is a high-blast-radius surface).
- **PR #121** spec #28 (program-templates) — the **first** marketplace listing kind. Templates spec'd there are the SKU shape this spec wraps in a buyer-facing surface.
- **PR #122** masterminds — §11 post-event software adoption loop. Mastermind alumni will be the largest seller cohort.
- **PR #123** spec #34 (regimens) — Regimen-as-marketplace-item is a future kind.

## 2. WHY

A coach who has built a great $5,000 fitness program template, a $200 mindset journal, a $500 1-month reset, can today only sell it via:

1. Their own storefront (hits only their existing audience).
2. Gumroad / Whop / Etsy (leaves TGP entirely; we earn $0).

A TGP-owned **coach marketplace** lets a buyer (any TGP user, or any anonymous customer of an offer that requires a marketplace-licensed asset) discover **other coaches' assets**, purchase them, and have them auto-installed into their TGP account. Every purchase:

- Has TGP as the merchant-of-record (chargeback risk centralised).
- Pays the seller-coach a revenue-share (default 80/20; configurable per L2/L3 tier).
- Generates a TGP take-rate the seller never has to think about.
- Routes the buyer's relationship through the marketplace (refunds via TGP, support via TGP, never via the seller's email inbox).

This is the lane closest in shape to **Whop** itself — a multi-sided marketplace where TGP earns by enabling discovery and trust.

### What "shipped" unlocks

- A coach with one popular template can earn passive revenue from other coaches' clients buying it.
- A coach onboarding can browse ready-made templates / regimens / content packs in their first 30 minutes; each install instantly populates their account.
- TGP gains a 20% revenue-share lane on top of the per-seat SaaS plan and the platform-fee on coach→client charges.
- The mastermind alumni cohort (PR #122 §11) has a place to sell their methodology beyond their own client base.

## 3. WHEN

This is the **last** lane to ship in the wave because it depends on every prior lane being live:

1. ✅ This spec is reviewed and accepted.
2. ✅ [`payments-checkout.md`](./payments-checkout.md) **PLATFORM_MOR** path is live and counsel-reviewed (every marketplace charge is MoR).
3. ✅ [`offer-builder.md`](./offer-builder.md) `OfferKind.MARKETPLACE_LICENSE` is live behind its flag.
4. ✅ PR #121 #28 (program-templates) at S2+ — at least one template SKU shape exists.
5. ✅ PR #120 lane #11 (release QA) gate passed — marketplace gets canary + 24h watch.
6. ✅ Counsel sign-off on the seller-agreement TOS (separate document; not in this repo).
7. ✅ Open questions §20 closed (default revenue-share, refund window, review-moderation policy).

## 4. WHERE

- **New module:** `src/commerce/marketplace/`.
- **New tables:** `MarketplaceListing`, `MarketplaceListingMedia`, `MarketplaceCategory`, `MarketplaceReview`, `MarketplaceReport`, `MarketplaceInstall`, `MarketplaceRevShareConfig`. (`Offer` row is shared; `payment_routing` forced to `PLATFORM_MOR`. `Charge`, `Payout`, `LedgerEntry` are shared with [`payments-checkout.md`](./payments-checkout.md).)
- **Touches:** `Offer.kind=MARKETPLACE_LICENSE` (created by [`offer-builder.md`](./offer-builder.md)); read-only on PR #121 #28 `ProgramTemplate`; read-only on PR #123 #34 `Regimen` (future kinds).
- **New routes:** `/api/v1/coach/marketplace/listings/*` (seller), `/api/v1/marketplace/*` (buyer-facing browse / search), `/api/v1/owner/marketplace/*`.
- **Public pages:** `/marketplace`, `/marketplace/c/:category_slug`, `/marketplace/l/:listing_slug`. SSR.

## 5. WHO

| Role             | Responsibility                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-off         | Founder (commercial + brand), backend lead (architecture), counsel (TOS + MoR), trust-and-safety owner (named at GA).                |
| On the hook      | Backend lead. Frontend specialist for marketplace browse UX. Founder for category curation S1.                                       |
| Downstream       | Revenue dashboard (PR #121 #29) reads marketplace earnings; messaging (PR #123 #36) auto-DMs install confirmations.                  |
| Hard boundaries  | Does **not** own SKU schema (`offer-builder.md` + spec #28 + spec #34 own); does **not** own the storefront page (#40 owns).         |

## 6. WHAT

### Already exists

- Nothing marketplace-specific.
- `Offer` schema (after [`offer-builder.md`](./offer-builder.md) lands) is the SKU substrate; `OfferKind.MARKETPLACE_LICENSE` is the flag.

### Net-new

- The seven tables in §8.
- A curated-categories taxonomy (S1: ~10 categories, hand-rolled).
- A buyer-facing browse + search surface.
- A reviews + moderation pipeline (with abuse mitigations).
- A revenue-share configuration that defaults 80/20 (seller / TGP) with per-L3 override.

### Non-goals

- **No bidding / auction model.** Fixed price only.
- **No subscriptions for marketplace items in S1.** One-time `TEMPLATE_LICENSE` purchases only; subscription kinds defer to S2.
- **No "marketplace as the only place to buy a coach's offer".** Marketplace items are listings of an offer; the underlying offer can also live on the seller's storefront. Marketplace is a separate channel, not a wrap.
- **No social shopping** (follow other shoppers, share haul carts). Out of scope.
- **No physical-goods marketplace.** Hard no.

## 7. HOW — phases

- **S0 spec.** Accepted.
- **S1 skeleton (private alpha).** `MarketplaceListing` + `MarketplaceCategory` + `MarketplaceInstall` tables. Hardcoded categories. Listings are admission-only (OWNER must approve to list). Browse + search APIs. `MARKETPLACE_ENABLED=false`.
- **S2 private beta.** `MarketplaceReview` + `MarketplaceReport`. Reviews moderation queue. Auto-install on purchase. Self-serve listing creation behind L3 entitlement gate.
- **S3 GA.** Flag-on; expanded category curation; OWNER-managed featured listings.

### 7.1 Smallest first runtime PR

PR-1: `MarketplaceListing` + `MarketplaceCategory` tables; OWNER-only create endpoints; public `GET /marketplace/l/:slug` with hardcoded test data. ~500 LOC.

### 7.2 Kill-switch

`MARKETPLACE_ENABLED=false`: all `/marketplace/*` routes 503. Existing installs continue to be readable. Existing listings hidden from browse but readable to seller via console.

## 8. Data model sketch (additive, **not** committed)

```prisma
model MarketplaceCategory {
  id                       String                     @id @default(cuid())
  slug                     String                     @unique
  title                    String
  description_md           String?                    @db.Text
  parent_id                String?                    // FK → MarketplaceCategory.id
  position                 Int
  visible                  Boolean                    @default(true)
  parent                   MarketplaceCategory?       @relation("CategoryTree", fields: [parent_id], references: [id])
  children                 MarketplaceCategory[]      @relation("CategoryTree")
  listings                 MarketplaceListing[]
  @@index([parent_id, position])
}

model MarketplaceListing {
  id                       String                     @id @default(cuid())
  // Sell-side
  seller_user_id           String                     // FK → User.id
  // SKU points to an Offer (kind=MARKETPLACE_LICENSE, payment_routing=PLATFORM_MOR enforced)
  offer_id                 String                     @unique
  // Buyer-facing
  slug                     String                     @unique  // global slug
  title                    String
  subtitle                 String?                    @db.Text
  description_md           String                     @db.Text
  hero_media_id            String?                    // FK → MarketplaceListingMedia.id
  category_id              String
  // Lifecycle
  status                   MarketplaceListingStatus   @default(DRAFT)
  rejection_reason         String?                    @db.Text
  approved_by_user_id      String?                    // OWNER who approved
  approved_at              DateTime?
  // Aggregates (denormalised; refreshed by cron)
  install_count            Int                        @default(0)
  rating_avg               Float?                     // 1..5
  rating_count             Int                        @default(0)
  // Revenue share (overrides default; null = inherit MarketplaceRevShareConfig.default_seller_bps)
  seller_share_bps_override Int?
  // Forward-compat
  acted_by_member_user_id  String?
  created_at               DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  archived_at              DateTime?
  seller                   User                       @relation("ListingSeller", fields: [seller_user_id], references: [id])
  category                 MarketplaceCategory        @relation(fields: [category_id], references: [id])
  media                    MarketplaceListingMedia[]
  reviews                  MarketplaceReview[]
  reports                  MarketplaceReport[]
  installs                 MarketplaceInstall[]
  @@index([seller_user_id, status])
  @@index([category_id, status])
}

enum MarketplaceListingStatus {
  DRAFT
  PENDING_REVIEW          // submitted by seller; awaiting moderation
  APPROVED                // public; appears in browse
  REJECTED                // moderation declined
  PAUSED                  // seller-paused
  TAKEN_DOWN              // operator moderation
  ARCHIVED                // soft-delete; existing installs preserved
}

model MarketplaceListingMedia {
  id                       String                     @id @default(cuid())
  listing_id               String
  kind                     ListingMediaKind
  storage_path             String                     // Supabase Storage prefix per PR #117 §8
  mime_type                String
  byte_size                Int
  width_px                 Int?
  height_px                Int?
  alt_text                 String?
  position                 Int
  listing                  MarketplaceListing         @relation(fields: [listing_id], references: [id], onDelete: Cascade)
}

enum ListingMediaKind {
  HERO
  GALLERY
  PREVIEW_PDF
  PREVIEW_VIDEO
}

model MarketplaceReview {
  id                       String                     @id @default(cuid())
  listing_id               String
  buyer_user_id            String                     // FK → User.id; only verified buyers can review
  install_id               String                     @unique  // 1 review per install
  rating                   Int                        // 1..5
  body                     String?                    @db.Text
  status                   ReviewStatus               @default(PUBLISHED)
  // Moderation
  hidden_at                DateTime?
  hidden_reason            String?
  reported_count           Int                        @default(0)
  // Forward-compat
  created_at               DateTime                   @default(now())
  updated_at               DateTime                   @updatedAt
  listing                  MarketplaceListing         @relation(fields: [listing_id], references: [id], onDelete: Cascade)
  buyer                    User                       @relation(fields: [buyer_user_id], references: [id])
  @@unique([listing_id, buyer_user_id])
  @@index([listing_id, status, rating])
}

enum ReviewStatus {
  PUBLISHED
  HIDDEN_BY_BUYER
  HIDDEN_BY_OPERATOR
  REMOVED
}

model MarketplaceReport {
  id                       String                     @id @default(cuid())
  reporter_user_id         String?                    // null = anonymous
  reporter_email           String?                    // captured for anonymous
  // Polymorphic by convention
  target_kind              ReportTargetKind
  target_id                String                     // listing_id OR review_id
  reason                   ReportReason
  body                     String                     @db.Text
  status                   ReportStatus               @default(OPEN)
  resolution_note          String?                    @db.Text
  resolved_by_user_id      String?
  resolved_at              DateTime?
  created_at               DateTime                   @default(now())
  @@index([target_kind, target_id])
  @@index([status, created_at])
}

enum ReportTargetKind {
  LISTING
  REVIEW
}

enum ReportReason {
  COPYRIGHT
  MEDICAL_CLAIM
  HATE_OR_HARASSMENT
  SPAM
  OFF_PLATFORM_DEAL        // seller asks buyer to pay outside TGP (forbidden)
  FAKE_REVIEW
  OTHER
}

enum ReportStatus {
  OPEN
  UNDER_REVIEW
  RESOLVED_NO_ACTION
  RESOLVED_TAKEN_DOWN
  RESOLVED_REMOVED
}

model MarketplaceInstall {
  id                       String                     @id @default(cuid())
  listing_id               String
  buyer_user_id            String                     // FK → User.id (the coach who bought it)
  // Source charge
  charge_id                String                     @unique  // FK → Charge.id
  // Fulfilment outcome (per the listing's underlying Offer fulfilment)
  installed_at             DateTime?
  install_target_kind      String                     // mirrors OfferFulfilmentKind
  install_target_id        String                     // e.g. ProgramTemplate.id created in buyer's account
  install_failed_at        DateTime?
  install_failure_reason   String?                    @db.Text
  refunded_at              DateTime?
  acted_by_member_user_id  String?
  listing                  MarketplaceListing         @relation(fields: [listing_id], references: [id])
  buyer                    User                       @relation(fields: [buyer_user_id], references: [id])
  @@index([buyer_user_id])
  @@index([listing_id, installed_at])
}

model MarketplaceRevShareConfig {
  id                       String                     @id @default(cuid())
  // Singleton row by convention; key='default'
  key                      String                     @unique
  default_seller_bps       Int                        @default(8000)   // 80%
  default_platform_bps     Int                        @default(2000)   // 20%
  // Per-L3 override map; e.g. {"L3_alumni": 8500} for promoted alumni coaches
  l3_override              Json?
  updated_at               DateTime                   @updatedAt
  updated_by_user_id       String
}
```

### 8.1 Retention

| Table                       | Retention                      | GDPR scrub                                                              |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `MarketplaceCategory`       | Permanent                      | None.                                                                   |
| `MarketplaceListing`        | Lifetime + 7y after archive (tax) | Free-text fields pseudonymised on seller RTBE.                          |
| `MarketplaceListingMedia`   | Lifetime of listing            | Storage path delete on archive.                                         |
| `MarketplaceReview`         | Lifetime of listing            | `body` pseudonymised on buyer RTBE; rating preserved as `[deleted]`.    |
| `MarketplaceReport`         | 90 days after resolution       | Free-text dropped after window unless `RESOLVED_TAKEN_DOWN`.            |
| `MarketplaceInstall`        | 7y (tax)                       | None (no PII present beyond IDs).                                       |
| `MarketplaceRevShareConfig` | Permanent                      | None.                                                                   |

## 9. API sketch + payment routing

### 9.1 Seller-facing

```
POST   /api/v1/coach/marketplace/listings            → create draft (links to existing Offer of kind MARKETPLACE_LICENSE)
GET    /api/v1/coach/marketplace/listings            → my listings
GET    /api/v1/coach/marketplace/listings/:id        → full listing + recent installs
PATCH  /api/v1/coach/marketplace/listings/:id        → update title/subtitle/desc/media
POST   /api/v1/coach/marketplace/listings/:id/submit → DRAFT → PENDING_REVIEW
POST   /api/v1/coach/marketplace/listings/:id/pause  → APPROVED → PAUSED
POST   /api/v1/coach/marketplace/listings/:id/archive → soft-delete; existing installs preserved
GET    /api/v1/coach/marketplace/sales               → seller's sales + earnings
```

Throttle: 30/min/coach. RBAC: `team.marketplace.manage` (PR #118 matrix).

Validators: `Offer.payment_routing` must be `PLATFORM_MOR`; `Offer.kind` must be `MARKETPLACE_LICENSE`. Otherwise reject at submit.

### 9.2 Buyer-facing

```
GET   /marketplace                                   → SSR landing
GET   /marketplace/c/:category_slug                  → category browse
GET   /marketplace/l/:listing_slug                   → listing detail page
GET   /api/v1/marketplace/listings                   → JSON browse with filters
GET   /api/v1/marketplace/listings/:slug             → JSON listing
POST  /api/v1/marketplace/listings/:slug/checkout    → mints checkout session via payments-checkout.md §9.3
GET   /api/v1/marketplace/installs                   → my installs (authenticated)
POST  /api/v1/marketplace/installs/:id/review        → buyer leaves a review (only if installed)
POST  /api/v1/marketplace/listings/:slug/report      → public; rate-limited; captcha
```

Cache: SSR landing + category 60s; listing detail 30s.

Throttle: anonymous 60/min/IP; authenticated 120/min/user.

Reviews:
- Only buyers with `MarketplaceInstall` (and not refunded) can leave one.
- One review per install.
- Review body limited to 2000 chars; soft-warn on profanity (review still publishes; flagged for queue).
- Sellers cannot leave reviews on their own listings (DB-enforced).

### 9.3 Operator

```
GET   /api/v1/owner/marketplace/listings             → cross-coach search by status
POST  /api/v1/owner/marketplace/listings/:id/approve → PENDING_REVIEW → APPROVED
POST  /api/v1/owner/marketplace/listings/:id/reject  → PENDING_REVIEW → REJECTED with reason
POST  /api/v1/owner/marketplace/listings/:id/takedown → APPROVED → TAKEN_DOWN with reason
POST  /api/v1/owner/marketplace/listings/:id/restore → undo takedown
GET   /api/v1/owner/marketplace/reports              → moderation queue
POST  /api/v1/owner/marketplace/reports/:id/resolve  → body { status, action_taken? }
PATCH /api/v1/owner/marketplace/rev-share            → update default + L3 overrides (audited)
GET   /api/v1/owner/marketplace/featured             → featured listings management
```

### 9.4 Payment routing

**Always** `PLATFORM_MOR`. The pricing engine in [`offer-builder.md`](./offer-builder.md) §9.4 produces a Stripe call where TGP is merchant. On `payment_intent.succeeded`:

1. `Charge` row written (TGP-side; no transfer_data).
2. `LedgerEntry` rows:

   | account            | coach_user_id | amount_cents | category |
   | ------------------ | ------------- | ------------ | -------- |
   | `CASH`             | null          | +10000       | CHARGE   |
   | `PLATFORM_FEE`     | null          | +2000        | CHARGE   |  *(default 20% goes to TGP)*
   | `PROCESSOR_FEE`    | null          | -320         | CHARGE   |
   | `COACH_REVENUE`    | <seller>      | +8000        | CHARGE   |  *(80% revenue-share)*
   | `COACH_RECEIVABLE` | <seller>      | -7680        | CHARGE   |  *(8000 - 320 = 7680 net coach payable, after Stripe fee absorbed by TGP per §11)*

   Note: per §11 below, TGP absorbs the processor fee on MoR offers (this is the standard Whop model). The seller earns the full 80% of gross.

3. `MarketplaceInstall` row created in `installed_at=null` state.
4. Fulfilment runner attempts to install (per the underlying offer's fulfilment kind — typically `PROGRAM_TEMPLATE`). On success, `installed_at` set; on failure, alarm + retry.
5. Payout to seller is held until `Offer.refund_window_days` elapses (default 7 for marketplace), then transferred.

## 10. Tax, refund, chargeback, dispute

- **Tax.** TGP files. Stripe Tax engaged on platform account; sales tax computed at checkout for US destination buyers and EU/UK VAT for international buyers (subject to nexus map maintained by finance owner).
- **Refunds.** Default window 7 days from purchase, no questions asked. Buyer-self-serve via "Refund this purchase" button on `/marketplace/installs`. Seller has no refund authority on marketplace items (TGP is MoR; the buyer's relationship is with TGP). Operator can override window for fraud / abuse.
- **Chargebacks.** TGP carries liability. Seller's revenue-share is reversed on `Charge.status=DISPUTED`. Stripe dispute fee absorbed by TGP.
- **Refund clawback to seller.** Refund within hold reverses pending revenue-share; refund post-payout creates a debit on next `Payout` (mirrors affiliate clawback in [`affiliate-referral.md`](./affiliate-referral.md) §11).
- **Refund attribution to install.** Refund un-installs the asset only on `Offer.uninstall_on_refund=true` (an `Offer` column reserved here; default `false` because un-installing causes UX whiplash — buyer keeps the template even after refund unless seller explicitly opted-in).

## 11. Ledger and reconciliation

- TGP absorbs Stripe processor fee on MoR (industry-standard for marketplaces; budgeted into the 20% take). Documented as a constant in revenue-share computation; reviewed annually.
- Reconciliation joins `Charge.metadata.marketplace_listing_id` against `MarketplaceInstall` and `LedgerEntry COACH_REVENUE` rows; drift alarms.
- Featured-listing slots are NOT a paid product in S1 (so no separate ledger). If S2 introduces paid promotion, that becomes a new `Offer` of its own kind (out of scope this spec).

## 12. RBAC, privacy, GDPR scrub

- Tenant: marketplace data is **cross-coach by design**. Seller scope `seller_user_id == self`; buyer scope `buyer_user_id == self`. Public reads scoped to `status=APPROVED`.
- **Buyers can be coach users or non-coach users.** A non-coach buyer who purchases a marketplace item becomes a `User` (auto-registered at checkout per `payments-checkout.md` §9.3). Their installs are scoped to themselves.
- Right-to-erasure: buyer pseudonymises review bodies; install rows preserve IDs for tax. Seller pseudonymises listing free text; existing installs reference an archived listing (becomes `[archived]` in buyer view) but content already installed in their account is owned by the buyer (a coach who bought a template **owns the copy**).
- Reviews are **public**; buyers must consent at submit; consent is a checkbox + `AuditLog`.

### 12.1 Audit log additions

```
MARKETPLACE_LISTING_SUBMITTED
MARKETPLACE_LISTING_APPROVED
MARKETPLACE_LISTING_REJECTED
MARKETPLACE_LISTING_TAKEN_DOWN
MARKETPLACE_LISTING_RESTORED
MARKETPLACE_REVIEW_PUBLISHED
MARKETPLACE_REVIEW_HIDDEN
MARKETPLACE_REPORT_OPENED
MARKETPLACE_REPORT_RESOLVED
MARKETPLACE_REVSHARE_CHANGED
MARKETPLACE_INSTALL_FAILED
```

## 13. Abuse, fraud, moderation

This is the densest abuse surface in the wave. Concrete rules:

### 13.1 Listing moderation

- **All listings are gated by OWNER review in S1 + S2.** Self-serve approval (S3) is opt-in per coach after a positive review history.
- **Pre-review automation.** On submit, a content scanner runs: medical-claim regex, copyright phrases ("Hormozi-style", literal book quotes), profanity, off-platform-deal language ("DM me to pay via Venmo"). Hits write `MarketplaceReport` rows automatically and queue the listing.
- **Required disclosures.** Listings with health-adjacent kinds (e.g., a meal plan listing) auto-append a disclaimer that buyer can edit but not remove.

### 13.2 Review fraud

- One review per install (DB unique). Sellers cannot review their own listings.
- **Buyer must have completed install** (`MarketplaceInstall.installed_at != null`) and not be refunded.
- **Velocity heuristic.** A listing receiving > 5 5-star reviews in 6 hours is auto-queued for review-fraud check.
- **Review-bombing detection.** A listing receiving > 10 1-star reviews in 24h triggers an alarm; reviews held in `PUBLISHED` until human review confirms.
- Reviews **before** the 7-day refund window can be edited by the buyer; reviews after are immutable except by operator.

### 13.3 Off-platform-deal abuse

The single biggest seller-side abuse vector: seller in description / DM tells buyer to pay outside TGP. Mitigations:

- **Description scanner** flags seed phrases ("send via Cash App", "DM to pay", "Venmo me", "off-platform").
- **Report category** explicitly named `OFF_PLATFORM_DEAL`. Reports of this category triggered by 2+ unique reporters auto-queue the listing for takedown.
- **Seller TOS** (separate doc) forbids; first violation = warning, second = revoke marketplace privileges + reverse all earnings on flagged listings.
- **Messaging surface** (PR #123 #36) — an OWNER-mode flag scans messages for the same seed phrases when seller and buyer are also marketplace counterparties. Out of scope this spec; cross-reference noted.

### 13.4 IP / copyright

- DMCA SOP under `docs/commerce/marketplace-runbook.md`. Counter-notice flow per US standard.
- `ReportReason.COPYRIGHT` reports auto-suspend the listing pending review (24h SLA).

### 13.5 Buyer abuse

- **Refund abuse.** A buyer with 30-day refund rate > 60% is flagged; rate > 80% auto-blocks new marketplace purchases (`User.marketplace_purchase_blocked=true` reserved on User table).
- **Account sharing for free templates.** Out of scope — TGP cannot prevent it.

### 13.6 Catalog quality

- Pause + warn listings with install_count > 50 and rating_avg < 2.5.
- Re-review listings with > 3 unresolved `MarketplaceReport` open in 30d.

## 14. Feature flags + entitlements

| Flag                                    | Default | Effect                                                          |
| --------------------------------------- | ------- | --------------------------------------------------------------- |
| `MARKETPLACE_ENABLED`                   | `false` | All marketplace routes 503; existing installs readable.         |
| `MARKETPLACE_SELF_SERVE_LISTING_ENABLED`| `false` | Block non-OWNER list submission; OWNER submits on behalf.       |
| `MARKETPLACE_REVIEWS_ENABLED`           | `false` | Block POST review; existing reviews readable.                   |
| `MARKETPLACE_AUTO_INSTALL_ENABLED`      | `false` | Mark `installed_at` only on operator click; manual install path.|

Entitlements:

- `marketplace.buy` — any L1+ coach can buy marketplace items.
- `marketplace.sell.basic` — L3 only. Manual listing approval per item.
- `marketplace.sell.self_serve` — L3 + 5 prior approved listings + `rating_avg >= 4.0`.

## 15. Tests

### 15.1 Unit

- `listing.lifecycle.spec.ts` — full state machine.
- `pricing-routing.spec.ts` — marketplace listings always force `PLATFORM_MOR`.
- `review.gate.spec.ts` — only verified buyers; one per install; seller cannot self-review.
- `revshare.calculator.spec.ts` — default 80/20 + L3 override matrix.
- `moderation.scanner.spec.ts` — medical-claim, off-platform-deal, copyright detectors.

### 15.2 Integration

- Buy flow: browse → checkout → install fulfilment → review → refund within window → revshare clawback.
- Operator approve → listing appears in browse → search hits.
- Off-platform-deal report → 2 reporters → auto-queue → takedown → buyer notified.
- DMCA report → 24h SLA path.

### 15.3 Smoke

- Daily synthetic install on staging; alarm on fulfilment failure or revshare drift.

## 16. Risks

| Risk                                             | Mitigation                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Off-platform-deal abuse                          | Scanner + report + revoke seller privileges (§13.3).                                        |
| Review-fraud (paid reviews, sock-puppets)        | Velocity heuristics + verified-buyer gate + bombing detection (§13.2).                       |
| DMCA / IP infringement                           | Scanner + reporter + 24h SLA + counter-notice (§13.4).                                       |
| Listing low-quality drift                        | Auto-pause on low ratings + high install (§13.6).                                            |
| MoR tax / nexus exposure                         | Stripe Tax + counsel + finance-owner nexus map (PR #41 §16).                                 |
| Disputed marketplace charge (TGP loss)           | Revshare clawback; seller TOS limits TGP exposure to seller's accrued balance.              |
| Catalog brand drift                              | Hand-curated categories S1; OWNER-managed featured slots; TOS enforces tone.                 |
| Auto-install introduces malicious template       | All templates are TGP-modeled rows (no executable code); per-kind validator on install.      |
| Seller leaving TGP keeps customer relationship   | Buyers' installs are TGP-owned; seller-account close revokes any seller-side dashboards.    |
| Featured-listing pay-to-play                     | S1: featured is editorial only. Paid promotion is a separate spec if it ever ships.          |
| Cross-currency revshare drift                    | Per-currency `LedgerEntry`; never mix at write time; reconciliation per-currency.            |

## 17. Dependencies

- **Internal:** all four prior commerce specs. PR #121 #28 (template SKU shape) at S2+. PR #117 §8 storage prefix. PR #123 #36 (messaging).
- **External:** Stripe Tax (MoR). Hosted images / video preview (Supabase Storage). Counsel for TOS + DMCA.
- **Human:** Founder closes §20 OQs. Counsel signs TOS. Trust-and-safety owner named at GA.

## 18. Acceptance criteria

1. OWNER can approve a draft listing; listing appears in browse within 60s.
2. Buyer purchases; charge writes ledger pair (default 80/20); install fulfilment success within 30s.
3. Refund within window reverses revshare; install row marked refunded.
4. Operator takedown returns 410 on `/marketplace/l/:slug` within 60s.
5. Off-platform-deal report from two unique reporters auto-queues.
6. Self-review blocked at DB layer (test).
7. PR #118 forward-compat columns present.
8. Counsel sign-off on seller TOS logged.
9. PR #120 lane #11 canary + 24h watch ran clean before flag-on.
10. Operator runbook merged.

## 19. Operator handoff

- **Kill-switches:** flags above; per-listing `status='paused' | 'taken_down'`; per-seller `marketplace.sell.basic` entitlement revocable.
- **Dashboards:** Grafana — listings approved/rejected/taken-down rate, install fulfilment success rate, refund rate, revshare drift. PostHog — browse → listing-view → checkout → install funnel. Moderation queue depth.
- **Runbook:** `docs/commerce/marketplace-runbook.md` — listing review SOP, DMCA flow, off-platform-deal SOP, review fraud SOP, revshare config flip SOP, featured-listings curation.
- **Alerts:** moderation queue > 50 items; install fulfilment failure rate > 1%; revshare drift > $25/24h; sudden spike of `OFF_PLATFORM_DEAL` reports against any single seller.

## 20. Open questions

- **OQ-1** Default revenue-share. Bias: 80/20. Premium-alumni override 85/15. **Owner: founder.**
- **OQ-2** Default refund window for marketplace items. Bias: 7d. Some industries (e.g. consumed PDFs) might be 0d. **Owner: founder.**
- **OQ-3** Self-serve listing in S2 vs. S3. Bias: S3 only. **Owner: backend lead.**
- **OQ-4** Reviews: visible to public anonymously, or require auth? Bias: public. **Owner: founder.**
- **OQ-5** Auto-install vs. manual install. Bias: auto-install once OFF-by-default flag flips. **Owner: backend lead.**
- **OQ-6** Featured listings: editorial-only S1 (no paid promotion). Confirm. **Owner: founder.**
