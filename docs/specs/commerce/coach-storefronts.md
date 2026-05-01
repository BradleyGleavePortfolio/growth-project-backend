# Spec: Coach Storefronts

> **Status:** Draft — docs only. Roadmap row #40. No runtime, schema, env-var, or module-wiring change in this PR.
>
> Read [`payments-checkout.md`](./payments-checkout.md) first. Storefronts are the public surface every other commerce lane attaches to.

## 1. Cross-references

- **PR #117** AI Program Builder RFC — adjacent; storefront's offer can publish a Program Draft.
- **PR #118** Team Mode foundation — `acted_by_member_user_id` reserved on every storefront row.
- **PR #120** platform readiness — lanes #01 (flags), #02 (API contract), #03 (RBAC), #04 (lifecycle), #06 (observability), #11 (release QA).
- **PR #121** spec #27 (public-coach-profile) — **partial overlap**. The §6 reconciliation explains the cleavage: spec #27 is the **identity / about-me** card; this spec is the **commerce surface**. They share a slug namespace and a `CoachProfile` row but render different pages.
- **PR #122** masterminds operating model — §5 product surfaces; storefront hosts the cohort + application card.
- **PR #123** coach-experience wave — #32 avatar media (header image), #33 content boards (storefront sections), #37 tiering (entitlement on advanced features).
- **Existing runtime:** `src/public-pages/` (public invite-landing). `docs/invite-landing.md` operator runbook. `src/coach/`, `src/profile/`. `docs/api-conventions.md`.

## 2. WHY

A coach today drives prospects to a Linktree → Kajabi / Stan Store → Calendly chain. The chain is a leak (the prospect leaves coach's brand → lands in third-party brand → bounces) and a friction tax (three logins, three checkouts, three "where do I find your stuff" support threads).

A TGP storefront fixes both at once: **one coach-branded URL** (`tgp.app/c/<slug>` or `<slug>.coaches.tgp.app`, plus optional custom domain at L3) that hosts the coach's offers, application form, content samples, social proof, and checkout, all rendered by **this** backend. Every offer purchased on the storefront flows through the connected account specced in [`payments-checkout.md`](./payments-checkout.md), so revenue is attributable, refundable, and reconcilable from day 1.

The storefront is also the **first surface a prospect sees** when they search a coach's name. It must load fast (SSR), look like the coach, and have working CTAs. Anything less and the coach goes back to Kajabi.

### What "shipped" unlocks

- Coach has a public URL they can put on Instagram bio, in DMs, on a podcast.
- Every offer + application + affiliate-link points to a coach-controlled storefront page; conversion is attributable.
- Custom domains (L3) for coaches who already have a brand.
- Storefront analytics (visits, conversion) feed the revenue dashboard (PR #121 spec #29).

## 3. WHEN

1. ✅ This spec is reviewed and accepted by founder + backend lead.
2. ✅ [`payments-checkout.md`](./payments-checkout.md) Stage 1 complete (Connect onboarding live behind flag) — checkout buttons need somewhere to send users.
3. ✅ PR #121 spec #27 (public-coach-profile) reconciled with §6 of this spec — the slug authority, the route owner, and the read-model boundary settled.
4. ✅ PR #117 §8 Supabase Storage prefix conventions are accepted (storefront media reuses).
5. ✅ Open questions §20 closed (slug rename policy, custom-domain ownership).

## 4. WHERE

- **New module:** `src/storefronts/`. Sibling to `src/public-pages/`. Internally split into `coach-side/` (CRUD on the storefront), `public-side/` (SSR rendering), and `media/` (avatar/header/section asset proxy).
- **New tables:** `Storefront`, `StorefrontSection`, `StorefrontMedia`, `StorefrontDomain`, `StorefrontVisit`. (`Offer` lives in [`offer-builder.md`](./offer-builder.md); storefront pulls it.)
- **Touches existing:** read-only on `User`, `CoachProfile`, `Offer`, `Charge`. Extends the slug allocator that PR #121 spec #27 introduces (single source of truth for `coach_slug`).
- **New routes:** `/api/v1/coach/storefront/*` (coach), `/api/v1/storefront/:slug/*` (public read), `/api/v1/owner/storefronts/*` (operator).
- **Public pages:** SSR HTML rendered by `src/storefronts/public-side/` mounted under `/c/:slug`.
- **`new-website` is not touched.**

## 5. WHO

| Role               | Responsibility                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Sign-off           | Founder (brand experience), backend lead (architecture), spec #27 owner (slug authority).                |
| On the hook        | Backend lead S1–S2; frontend specialist for SSR templates; founder during S3 GA.                         |
| Downstream         | Offer-builder, application-funnel, affiliate, marketplace all link **to** storefront URLs.               |
| Hard boundaries    | Does **not** own offer schema, application form schema, payment routing, marketplace card layout.        |
| Pager owner        | Backend lead. Escalation to founder for any takedown decision.                                           |

## 6. WHAT — relationship to PR #121 spec #27 (public coach profile)

PR #121 spec #27 introduces a public coach profile page — an "about me" card + handle + social links. This spec extends rather than replaces:

| Concern                       | PR #121 spec #27                          | This spec                                       |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Slug allocator                | **Owns it.**                              | Reads from spec #27's `coach_slug` namespace.   |
| Identity card (avatar, bio)   | **Owns it.**                              | Renders inside the storefront page header.       |
| Social links                  | **Owns it.**                              | Renders in storefront footer.                    |
| Offers (catalog)              | Out of scope.                             | **Owns it.** Section type `offers`.             |
| Application card              | Out of scope.                             | **Owns it.** Section type `application`.        |
| Custom sections (content)     | Out of scope.                             | **Owns it.** Section type `content`/`testimonials`. |
| Custom domain                 | Out of scope.                             | **Owns it.** Section §13.                       |
| Public route mount            | `/coach/:slug` (about page).              | `/c/:slug` (storefront). Spec #27's about page becomes an anchor on the storefront in S2. |

Resolution: a single `coach_slug` value is shared. Spec #27's "about me" card becomes a default `StorefrontSection` of `kind='about'` once both lanes ship. Until #27 lands, this spec writes against a feature flag that defers to spec #27's allocator.

### 6.1 Already exists in `main`

- `User.id`, `CoachProfile`, `src/public-pages/` (invite-landing only), `src/coach/`.
- `src/billing/`, `Offer` does **not** yet exist.

### 6.2 Net-new

- The five tables above.
- Storefront SSR module.
- Custom-domain DNS validator (S2).

### 6.3 Non-goals

- A theme designer (color picker, font picker) — S2 at earliest. S1 ships with one fixed-but-tasteful template.
- Drag-and-drop section reordering — S2.
- A/B testing of sections — out of scope this wave.
- Email capture forms outside the application section — affiliate spec covers email capture for referrals; storefront does not duplicate.

## 7. HOW — phases

- **S0 spec.** This document accepted.
- **S1 skeleton.** `src/storefronts/` module, two tables (`Storefront`, `StorefrontSection`), CRUD APIs for coach, public read at `/c/:slug` rendering a hard-coded template; `STOREFRONTS_ENABLED=false`.
- **S2 private beta.** Media table, custom domain table, SSR rendering with hardened cache headers, abuse rate limits, takedown vocabulary.
- **S3 GA.** Flag-on for entire roster of L1+ coaches. Custom domains gated to L3.

### 7.1 Smallest first runtime PR

PR-1: `Storefront` + `StorefrontSection` tables, four endpoints (`POST/GET/PATCH /coach/storefront`, `GET /storefront/:slug`), one fixed template, `STOREFRONTS_ENABLED=false`. ≤500 LOC.

### 7.2 Kill-switch

`STOREFRONTS_ENABLED=false` returns 503 on `/api/v1/coach/storefront/*` and serves a static "temporarily unavailable" SSR page on `/c/:slug`. Existing offer / checkout flows untouched.

## 8. Data model sketch (additive, **not** committed in this PR)

```prisma
model Storefront {
  id                       String                   @id @default(cuid())
  coach_user_id            String                   @unique  // FK → User.id
  slug                     String                   @unique  // mirror of CoachProfile.coach_slug
  title                    String                   // "Coach J's Programs"
  tagline                  String?                  @db.Text
  status                   StorefrontStatus         @default(DRAFT)
  template                 StorefrontTemplate       @default(BASIC_V1)
  brand_color_hex          String?                  // S2; ignored in S1
  header_media_id          String?                  // FK → StorefrontMedia.id
  avatar_media_id          String?                  // FK → StorefrontMedia.id  (mirrors PR #123 #32)
  custom_domain_id         String?                  // FK → StorefrontDomain.id
  meta_title               String?                  // <head> / OG override
  meta_description         String?                  @db.Text
  published_at             DateTime?
  // Forward-compat
  acted_by_member_user_id  String?
  created_at               DateTime                 @default(now())
  updated_at               DateTime                 @updatedAt
  coach                    User                     @relation(fields: [coach_user_id], references: [id], onDelete: Cascade)
  sections                 StorefrontSection[]
  domain                   StorefrontDomain?        @relation(fields: [custom_domain_id], references: [id])
  visits                   StorefrontVisit[]
}

enum StorefrontStatus {
  DRAFT
  PUBLISHED
  PAUSED          // coach-paused
  TAKEN_DOWN      // operator-taken-down (moderation)
}

enum StorefrontTemplate {
  BASIC_V1        // S1 default
  // future
}

model StorefrontSection {
  id                       String                   @id @default(cuid())
  storefront_id            String
  kind                     StorefrontSectionKind
  position                 Int                      // 0-indexed within storefront
  visible                  Boolean                  @default(true)
  // Per-kind config; the schema is stable but the JSON shape is version-tagged.
  config                   Json
  created_at               DateTime                 @default(now())
  updated_at               DateTime                 @updatedAt
  acted_by_member_user_id  String?
  storefront               Storefront               @relation(fields: [storefront_id], references: [id], onDelete: Cascade)
  @@unique([storefront_id, position])
  @@index([storefront_id, kind])
}

enum StorefrontSectionKind {
  ABOUT             // pulled from PR #121 spec #27 read model; render-only
  OFFERS            // list of Offer ids (offer-builder spec)
  APPLICATION       // single ApplicationForm id (application-funnel spec)
  CONTENT           // pull from PR #123 spec #33 content boards (read-only embed)
  TESTIMONIALS      // free-text + asset (StorefrontMedia) per item
  FAQ
  CUSTOM_HTML       // OWNER-only kind for hand-rolled cohort pages; sanitised
}

model StorefrontMedia {
  id                       String                   @id @default(cuid())
  storefront_id            String
  kind                     StorefrontMediaKind
  storage_path             String                   // Supabase Storage path; reuses PR #117 §8 prefix
  mime_type                String
  byte_size                Int
  width_px                 Int?
  height_px                Int?
  alt_text                 String?
  created_at               DateTime                 @default(now())
  storefront               Storefront               @relation(fields: [storefront_id], references: [id], onDelete: Cascade)
}

enum StorefrontMediaKind {
  AVATAR
  HEADER
  TESTIMONIAL_PORTRAIT
  SECTION_INLINE
}

model StorefrontDomain {
  id                       String                   @id @default(cuid())
  storefront_id            String                   @unique
  domain                   String                   @unique  // lowercased FQDN
  validation_token         String                   @unique  // TXT record
  validated_at             DateTime?
  ssl_status               DomainSslStatus          @default(PENDING)
  created_at               DateTime                 @default(now())
  storefront               Storefront               @relation(fields: [storefront_id], references: [id])
}

enum DomainSslStatus {
  PENDING
  ISSUING
  ACTIVE
  FAILED
}

model StorefrontVisit {
  id                       String                   @id @default(cuid())
  storefront_id            String
  occurred_at              DateTime                 @default(now())
  visitor_anonymous_id     String                   // cookie-set; rotated 30d
  referrer                 String?
  utm_source               String?
  utm_medium               String?
  utm_campaign             String?
  utm_content              String?
  ip_country               String?
  device_kind              String?                  // 'mobile' | 'desktop' | 'tablet' | 'bot'
  outcome                  StorefrontVisitOutcome   @default(VIEWED)
  storefront               Storefront               @relation(fields: [storefront_id], references: [id], onDelete: Cascade)
  @@index([storefront_id, occurred_at])
}

enum StorefrontVisitOutcome {
  VIEWED
  CLICKED_OFFER
  CLICKED_APPLICATION
  CHECKOUT_STARTED
  CHECKOUT_COMPLETED
}
```

### 8.1 Retention

| Table              | Retention                          | GDPR scrub                                                                  |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| `Storefront`       | Lifetime of coach + 30d soft-delete | Slug + custom domain release back to pool on hard delete.                   |
| `StorefrontSection`| Lifetime of storefront             | None.                                                                       |
| `StorefrontMedia`  | Lifetime of storefront             | Storage path delete + S3 lifecycle policy.                                  |
| `StorefrontDomain` | Lifetime of storefront             | None.                                                                       |
| `StorefrontVisit`  | **30 days rolling**                | `visitor_anonymous_id` is already pseudonymous. IP not stored, only country. |

## 9. API sketch + payment routing

> Storefronts contain *no* payment logic; they link to checkout endpoints owned by [`payments-checkout.md`](./payments-checkout.md). This section is included for template completeness.

### 9.1 Coach-facing

```
POST   /api/v1/coach/storefront                       → create
GET    /api/v1/coach/storefront                       → my storefront + sections
PATCH  /api/v1/coach/storefront                       → update title, tagline, etc.
POST   /api/v1/coach/storefront/sections              → add section
PATCH  /api/v1/coach/storefront/sections/:id          → update section config
DELETE /api/v1/coach/storefront/sections/:id          → remove
POST   /api/v1/coach/storefront/sections/reorder      → body { ids: [...] } single tx
POST   /api/v1/coach/storefront/media                 → multipart upload
DELETE /api/v1/coach/storefront/media/:id             → cascade-detaches
POST   /api/v1/coach/storefront/publish               → DRAFT → PUBLISHED
POST   /api/v1/coach/storefront/pause                 → PUBLISHED → PAUSED
POST   /api/v1/coach/storefront/domain                → request custom domain (L3 only)
GET    /api/v1/coach/storefront/domain/instructions   → DNS records to add
POST   /api/v1/coach/storefront/domain/verify         → trigger TXT-record check
```

Throttle: 30/min/coach (read), 6/min/coach (write), 1/min/coach for media uploads. RBAC: `team.storefront.manage` (PR #118 matrix).

### 9.2 Public

```
GET /api/v1/storefront/:slug                          → JSON read model (used by mobile app + SSR)
GET /c/:slug                                          → SSR HTML
GET /storefront/:slug/og.png                          → OG image (cached)
```

Cache: SSR HTML cached 60s; JSON cached 30s; OG image cached 1h. Cache key includes `Storefront.updated_at` so an edit invalidates.

Throttle: anonymous 60/min/IP; authenticated 120/min/user.

### 9.3 Operator

```
GET    /api/v1/owner/storefronts                      → search by slug, coach, status
POST   /api/v1/owner/storefronts/:id/takedown         → status=TAKEN_DOWN, reason required
POST   /api/v1/owner/storefronts/:id/restore          → undo takedown
GET    /api/v1/owner/storefronts/:id/visits           → raw visit data, last 30d
```

## 10. Tax, refund, chargeback, dispute

Not applicable — storefront is media + links. Money rules live in [`payments-checkout.md`](./payments-checkout.md). The storefront's only money-adjacent surface is the OG-tag rendering of `Offer.price_cents` (read-only).

## 11. Ledger and reconciliation

Not applicable. Storefront does not write `LedgerEntry`. **Visit attribution** does feed revenue dashboards (PR #121 spec #29) by joining `StorefrontVisit.outcome=CHECKOUT_COMPLETED` to the `Charge` row via the visitor anonymous id captured at checkout.

## 12. RBAC, privacy, GDPR scrub

- Tenant: `coach_user_id` on `Storefront`, joined through. Row-level guard.
- Public read is unauthenticated; we serve only `status=PUBLISHED`. Drafts return 404 to non-owner.
- `StorefrontVisit.visitor_anonymous_id` is a cookie. We do not store IP or user-agent verbatim; only country + device-kind.
- Right-to-erasure for a customer who later registered: visit rows by the same anonymous id are pseudonymised on user delete (anonymous id rotated to a `deleted-` prefix).
- Coach right-to-erasure cascades the storefront tree.

### 12.1 Audit log additions

```
STOREFRONT_PUBLISHED
STOREFRONT_PAUSED
STOREFRONT_TAKEN_DOWN
STOREFRONT_RESTORED
STOREFRONT_DOMAIN_REQUESTED
STOREFRONT_DOMAIN_VERIFIED
STOREFRONT_SECTION_KIND_CUSTOM_HTML_EDITED   // for the custom-html OWNER-only section
```

## 13. Abuse, fraud, moderation

### 13.1 Slug abuse

- Slugs go through a profanity + impersonation filter (`coach.tgp.app` blocked, common celebrity names blocked unless OWNER pre-approves).
- Slug squatting: dormant slugs (no `Storefront.published_at` for 90d after creation, no offers linked) are released back to pool by an OWNER cron; documented in operator runbook.
- Slug rename: OWNER-only in S1 (OQ-1). Rename writes a 301 redirect for 30d.

### 13.2 Content moderation

- **Pre-publish:** coach-side warning if `tagline` or `meta_description` contains medical-claim keywords ("cure", "guaranteed weight loss > X lbs", "diagnose"). Soft warning, not a block.
- **Post-publish review queue.** Storefront is added to a queue when (a) coach is on Connect probation, (b) chargeback rate > 0.75%, (c) report-button hit on the public page (S2, anonymous report).
- **Takedown.** Two-OWNER ack required. Takedown returns 410 on `/c/:slug` with a static "this page has been removed" notice. Coach is emailed.

### 13.3 Custom HTML section

`CUSTOM_HTML` kind is OWNER-only — coaches cannot self-create. The HTML is sanitised via DOMPurify-equivalent, allowed tags whitelist, no `<script>`, no inline event handlers. Used for cohort landing pages where a designer hand-rolled markup.

### 13.4 Custom domain

Hard rules:
- L3 only; entitlement-gated.
- Coach must complete TXT-record validation before SSL is issued.
- We do not issue more than 1 custom domain per storefront.
- We use Cloudflare for SaaS-style certificate provisioning (the operator runbook covers setup; this spec assumes its presence).
- Domain takedown is symmetric to slug takedown.

### 13.5 Rate limits on public page

- 60/min/IP global on `/c/:slug` and `/api/v1/storefront/:slug`.
- 6 OG-image requests/min/storefront/IP (image generation is expensive; cache key tight).

## 14. Feature flags + entitlements

| Flag                              | Default | Effect                                                                          |
| --------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `STOREFRONTS_ENABLED`             | `false` | All storefront routes 503; SSR shows "temporarily unavailable" page.            |
| `STOREFRONTS_CUSTOM_DOMAINS_ENABLED` | `false` | Custom domain endpoints return 503; existing verified domains keep serving.    |
| `STOREFRONTS_CUSTOM_HTML_ENABLED` | `false` | OWNER-only kind blocked at section create.                                      |

Entitlement gate (PR #123 #37):

- `storefront.basic` — single fixed template, no custom domain. L1.
- `storefront.advanced` — multi-section, brand colour, OG override. L2.
- `storefront.custom_domain` — L3 + manual OWNER flip per coach.

## 15. Tests

### 15.1 Unit

- `storefront.service.spec.ts` — slug uniqueness, publish state machine, section reorder atomicity.
- `section.config.validator.spec.ts` — per-kind JSON schema validates.
- `media.uploader.spec.ts` — mime allow-list, byte-size cap, image dimension probe.
- `domain.validator.spec.ts` — TXT record check, retry semantics.
- `moderation.scanner.spec.ts` — medical-claim keyword detector.

### 15.2 Integration

- Full coach flow: create → add section → upload media → publish → public read returns 200.
- Takedown by OWNER → public read 410.
- Cache header sanity (max-age, ETag), HEAD = GET for SSR.
- Custom-domain happy + DNS-not-set + DNS-set-wrong-token paths.

### 15.3 Smoke

- After deploy, fetch `/c/<canary-coach-slug>` and assert `Storefront.published_at` < 5 min ago means `Last-Modified` ≤ 5 min ago.

### 15.4 Load

- Cached `/c/:slug` p95 < 80ms at 200 req/s in staging.

## 16. Risks

| Risk                                         | Mitigation                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Slug collision with PR #121 spec #27         | Single allocator (§6); spec #27 owns it.                                                              |
| Custom-domain DNS misconfiguration           | TXT validation + retry + clear instructions in `/coach/storefront/domain/instructions`.                |
| SSR cost / bot scraping                      | Aggressive cache; 60/min/IP rate limit; OG image cached 1h.                                            |
| Moderation latency (post-publish offensive content) | Report-button + 2-OWNER takedown ack; SLA documented in operator runbook.                          |
| `CUSTOM_HTML` XSS                            | OWNER-only; sanitised; CSP locked down on `/c/:slug` (no inline scripts beyond hashed analytics tag).  |
| Storefront drift from offer-builder schema   | Section `config.version` field; per-kind validator enforces version compatibility on publish.          |
| Cache poisoning across storefronts           | Cache key includes `slug` + `Storefront.updated_at`; never includes user-influenced headers.           |

## 17. Dependencies

- **Internal:** [`payments-checkout.md`](./payments-checkout.md) S1 live (for offer CTAs to do anything). PR #121 spec #27 (slug allocator + about card). PR #117 §8 storage prefix. PR #123 #32 (avatar media if storefront wants to read the same).
- **External:** Cloudflare (custom domain SSL); Supabase Storage; OG image renderer (existing or new lib; choice deferred to runtime PR-2).
- **Human:** Founder closes §20 OQs.

## 18. Acceptance criteria

1. Coach can publish a storefront from "create" to live `/c/:slug` URL in <2 min on the happy path.
2. Public `GET /c/:slug` returns SSR HTML in p95 < 80ms (cached) and p95 < 400ms (uncached).
3. OG card on Slack/Twitter renders avatar + tagline + first offer price correctly.
4. Takedown returns 410 within 60s of OWNER action.
5. Custom domain successfully serves over HTTPS within 10 min of TXT validation.
6. PR #118 forward-compat columns present.
7. PR #120 lane #03 RBAC contract green.
8. Visit data flows into PostHog and feeds revenue dashboard funnel chart.
9. Operator runbook entry merged.

## 19. Operator handoff

- **Kill-switches:** `STOREFRONTS_ENABLED=false`, `STOREFRONTS_CUSTOM_DOMAINS_ENABLED=false`. Per-storefront `Storefront.status='paused'` or `='taken_down'`.
- **Dashboards:** PostHog funnel `storefront.viewed → checkout.started → checkout.completed`. Grafana SSR p95, cache hit rate, OG image render time. Moderation queue depth.
- **Runbook:** `docs/storefronts/operator-runbook.md` — slug release, custom-domain setup, takedown SOP, SSR cache flush, moderation queue triage.
- **Alerts:** SSR p95 > 1s for 5 min; cache hit rate < 60% over 30 min; moderation queue > 20 items.

## 20. Open questions

- **OQ-1** Slug rename policy: OWNER-only with 30d 301 redirect (default), or self-serve once-per-90d. **Owner: founder.**
- **OQ-2** Custom-domain ownership: custom domains transfer with the coach if they leave (then we drop SSL), or revert to TGP-managed `coaches.tgp.app/<slug>`. **Owner: founder + counsel.**
