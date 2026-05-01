# Buyer Discovery via UGC Content Rewards

Status: DRAFT (Wave 8). Docs only. No runtime changes.

## Purpose

This document specifies how user-generated content (UGC) clips on TikTok, Instagram, and YouTube drive **buyer discovery** of coach pages. It defines the click-to-conversion flow, attribution model, server-side event schema, dashboard surface for coaches, and known failure modes.

It is the bridge between the **Content Rewards program** (`./rewards-spec.md`) and the **Wave 7 buyer funnel** (`../buyer-funnel/buyer-funnel-and-attribution.md`). Where the rewards spec defines "how a creator gets paid for posting a clip," this doc defines "how that clip turns into a coaching customer."

## Scope

In scope:

- Short-link / UTM semantics for UGC clips
- Click ledger + server-side attribution events
- Multi-channel attribution model (last-touch with first-touch tiebreaker)
- Coach-facing discovery dashboard
- Failure modes and mitigation

Out of scope (covered elsewhere):

- Reward calculation and payout to the creator (`./rewards-spec.md`, `./payout-pipeline.md`)
- Buyer checkout funnel and Stripe billing (`../buyer-funnel/buyer-funnel-and-attribution.md`)
- Affiliate program (separate revenue share, see `../affiliate/`)

## Discovery Flow

A clip on a public platform drives a buyer to the coach in five hops:

1. **Impression**: buyer scrolls a TikTok/Reel/Short and watches the creator's clip about coach `C`.
2. **Bio click**: buyer taps the link in bio, the pinned comment, or the "swipe up" — all of which resolve to a TGP short link `https://tgp.link/c/{slug}?u={utm_pack}`.
3. **Short-link redirect**: TGP edge handler logs a `UgcAttributionEvent(kind=CLICK)` row, sets a signed first-party cookie (`tgp_ugc=<eventId>`), then 302s to the coach's public page (`/c/{coachSlug}`).
4. **Page view + warm-up**: buyer lands on the coach page. Client-side hydration fires a `PAGE_VIEW` event tied to the same `eventId`. They may bounce, schedule a discovery call, or click "Apply / Buy."
5. **Conversion**: buyer completes checkout (or books a paid call). The Stripe webhook handler resolves the `eventId` from the cookie and the persisted click ledger, then writes a `UgcAttributionEvent(kind=CONVERSION)` row joined to the originating click.

Each hop produces an event row. The conversion row carries the full attribution chain.

## Short-Link and UTM Semantics

### Slug structure

```
https://tgp.link/c/{coachSlug}?u={utmPack}
```

- `coachSlug`: the coach's public slug (already used by the coach page).
- `utmPack`: opaque base32 (8 chars, server-generated, stored in `UgcShortLink.utmPackId`). Decodes server-side to a `{creatorId, clipId, platform, campaignId, version}` tuple. We do NOT put raw UTM params in the URL — short, clean, and tamper-resistant.

### UTM pack expansion

When the edge handler resolves `utmPack`, it expands to canonical UTM fields and writes them into the click row:

| Field         | Source                          | Example                |
| ------------- | ------------------------------- | ---------------------- |
| `utm_source`  | `clip.platform`                 | `tiktok`               |
| `utm_medium`  | const `ugc`                     | `ugc`                  |
| `utm_campaign`| `clip.campaignId`               | `summer-2026-bjj`      |
| `utm_content` | `clip.id` (8-char public hash)  | `c_8qvk2lh`            |
| `utm_term`    | `creator.handle`                | `@somebjjcreator`      |

These are also forwarded as querystring on the redirect target so downstream client analytics (PostHog) sees them. PII (creator real name, email) is **never** sent to PostHog — only the public handle and the opaque clip id.

### Short-link rotation

Slugs are immutable once issued. If a creator deletes a clip, the short link still resolves but writes `UgcAttributionEvent.kind = CLICK_DEAD` and 302s to `/c/{coachSlug}` without UTM params (so traffic is preserved but no longer attributed to the dead clip).

## Click Ledger

Every click on a `tgp.link/c/...` URL produces exactly one row. The ledger is append-only.

### Edge handler responsibilities

1. Parse `utmPack`, look up `UgcShortLink` row (in-memory cache, 60s TTL).
2. Compute device fingerprint (IP-prefix-hashed + UA hash, salted, 24h rotation; never raw IP stored).
3. Insert `UgcAttributionEvent(kind=CLICK, ...)`.
4. Set signed cookie `tgp_ugc` (HMAC-signed JSON `{eventId, exp}`, 30-day max-age, `SameSite=Lax`, `Secure`).
5. 302 to `/c/{coachSlug}?<expandedUtm>`.

The handler MUST stay under 50ms p95 — the redirect is on the buyer's critical path.

### Bot filtering

Bots (verified UA list, `X-Datadome-*` headers, prefetch indicators) are tagged `kind=CLICK_BOT` and excluded from attribution. They still get the redirect so we don't break headless previews.

## Attribution Model

### Last-touch with first-touch tiebreaker

Default: **last-touch within a 30-day window**. The conversion attaches to the most recent qualifying click whose timestamp is within 30 days of the conversion event.

Tiebreaker: if two clicks land within the **same 60-second window** (race / refresh / multi-device), the **first** click in the chain wins. This protects the creator who actually drove the discovery vs. a creator who happens to be on the buyer's "for you" feed at conversion time.

### Qualifying click

A click qualifies if **all** of:

- `kind = CLICK` (not `CLICK_BOT`, not `CLICK_DEAD`)
- `clip.status = LIVE` at click time
- Click is not from the same `accountId` as the conversion (no self-attribution)
- The signed cookie passed integrity check OR the server ledger contains the event id

### Cross-device

If the buyer clicks on mobile and converts on desktop, the cookie won't carry. Fallback chain:

1. **Logged-in match**: if the buyer logs in before conversion, we link any UGC clicks tied to the same `accountId` from the last 30 days.
2. **Email match**: at checkout, if `buyer.email` matches a previously seen email on a click row (we store email-hash, not email), we link.
3. **Device fingerprint match** (last resort, low confidence): match on rotated fingerprint; tagged `attributionConfidence=LOW` and surfaced on the dashboard.

If none match, the conversion is `kind=CONVERSION_DIRECT` (no UGC attribution, no creator reward).

## Server-Side Event Schema

All UGC attribution events are stored in a single append-only table. We use a single table (rather than separate click/conversion tables) to make the chain queryable in one scan.

### `UgcAttributionEvent` (Prisma sketch)

```prisma
model UgcAttributionEvent {
  id              String   @id @default(cuid())
  kind            UgcAttributionKind
  // Shortlink + clip
  shortLinkId     String?
  shortLink       UgcShortLink? @relation(fields: [shortLinkId], references: [id])
  clipId          String?
  clip            UgcClip?      @relation(fields: [clipId], references: [id])
  creatorId       String?
  creator         CreatorAccount? @relation(fields: [creatorId], references: [id], onDelete: SetNull)
  // Coach being discovered
  coachId         String
  coach           CoachAccount  @relation(fields: [coachId], references: [id], onDelete: Cascade)
  // Buyer (resolved post-conversion only)
  buyerAccountId  String?
  buyer           BuyerAccount? @relation(fields: [buyerAccountId], references: [id], onDelete: SetNull)
  buyerEmailHash  String?  // sha256(lower(trim(email)) + salt)
  // Device + provenance
  fingerprintHash String?
  ipPrefixHash    String?
  userAgentHash   String?
  platform        UgcPlatform?
  utmCampaign     String?
  utmContent      String?
  // Conversion linkage
  parentClickEventId String?
  parentClickEvent   UgcAttributionEvent? @relation("ChainParent", fields: [parentClickEventId], references: [id])
  childEvents        UgcAttributionEvent[] @relation("ChainParent")
  conversionAmount   Decimal? @db.Decimal(14, 2)
  conversionCurrency String?  // ISO-4217 on row
  attributionConfidence AttributionConfidence?
  // Stripe linkage (conversion only)
  stripeEventId   String?
  stripeChargeId  String?
  // Audit
  createdAt       DateTime @default(now())
  // GDPR cascade: all PII-bearing fields nullable on creator/buyer delete via SetNull;
  // coach delete cascades full row.
  @@index([coachId, createdAt])
  @@index([creatorId, createdAt])
  @@index([buyerAccountId, createdAt])
  @@index([buyerEmailHash])
  @@index([fingerprintHash])
}

enum UgcAttributionKind {
  CLICK
  CLICK_BOT
  CLICK_DEAD
  PAGE_VIEW
  CONVERSION
  CONVERSION_DIRECT
}

enum UgcPlatform { TIKTOK INSTAGRAM YOUTUBE OTHER }

enum AttributionConfidence { HIGH MEDIUM LOW }
```

### `UgcShortLink` (Prisma sketch)

```prisma
model UgcShortLink {
  id          String   @id @default(cuid())
  utmPackId   String   @unique  // 8-char base32 in URL
  coachId     String
  coach       CoachAccount @relation(fields: [coachId], references: [id], onDelete: Cascade)
  clipId      String
  clip        UgcClip      @relation(fields: [clipId], references: [id], onDelete: Cascade)
  creatorId   String
  creator     CreatorAccount @relation(fields: [creatorId], references: [id], onDelete: Cascade)
  campaignId  String?
  createdAt   DateTime @default(now())
  events      UgcAttributionEvent[]
  @@index([coachId])
  @@index([clipId])
}
```

`UgcClip`, `CreatorAccount`, and `CoachAccount` are defined in `./rewards-spec.md`.

### Decimal + currency

All monetary values use `Decimal(14, 2)` with the currency code stored on the same row. We never assume USD.

### GDPR cascade

- Buyer/creator deletion: `SetNull` on `UgcAttributionEvent` PII columns. Event row is preserved (financial audit) but anonymized.
- Coach deletion: `Cascade` (the discovery context no longer exists).
- `buyerEmailHash` is salted with a per-account salt rotated on deletion request, breaking lookup.

## Dashboard Surface for Coaches

Coaches see a `/dashboard/ugc` page with the following widgets. All data is the coach's own; no creator PII beyond public handle.

### Top-line metrics (last 30d, with prior-30d delta)

- Impressions (where the platform reports them; nullable)
- Clicks (`kind=CLICK`, deduped by `fingerprintHash` per-day)
- Page views (`kind=PAGE_VIEW` joined to a click)
- Conversions (`kind=CONVERSION` attributed)
- CVR = conversions / clicks
- GMV attributed (sum of `conversionAmount` per currency, displayed per-row, never silently summed across currencies)

### Per-clip table

| Column            | Source                                            |
| ----------------- | ------------------------------------------------- |
| Clip thumbnail    | `UgcClip.thumbnailUrl`                            |
| Creator handle    | `CreatorAccount.publicHandle`                     |
| Platform          | `UgcClip.platform`                                |
| Posted at         | `UgcClip.publishedAt`                             |
| Clicks            | `count(events where kind=CLICK)`                  |
| CTR               | clicks / impressions (nullable if no impressions) |
| Conversions       | `count(events where kind=CONVERSION)`             |
| CVR               | conversions / clicks                              |
| GMV               | per-currency sum                                  |
| Reward paid       | from `./rewards-spec.md` ledger                   |

### Conversion funnel widget

Funnel chart: Impressions -> Clicks -> Page views -> Started checkout -> Completed checkout. Drop-off at each stage, with a "compare to coach baseline" overlay (the coach's average funnel from non-UGC traffic).

### TypeScript shape

```ts
export interface CoachUgcDashboard {
  windowDays: 30 | 60 | 90;
  topline: {
    impressions: number | null;
    clicks: number;
    pageViews: number;
    conversions: number;
    cvr: number;
    gmv: Array<{ currency: string; amount: string /* Decimal as string */ }>;
    deltaVsPrior: {
      clicks: number; conversions: number; cvr: number;
    };
  };
  clips: Array<{
    clipId: string;
    creatorPublicHandle: string;
    platform: 'TIKTOK' | 'INSTAGRAM' | 'YOUTUBE' | 'OTHER';
    publishedAt: string;
    thumbnailUrl: string;
    clicks: number;
    ctr: number | null;
    conversions: number;
    cvr: number;
    gmvByCurrency: Array<{ currency: string; amount: string }>;
    rewardPaid: { currency: string; amount: string } | null;
  }>;
  funnel: {
    impressions: number | null;
    clicks: number;
    pageViews: number;
    checkoutStarted: number;
    checkoutCompleted: number;
  };
}
```

The endpoint is `GET /api/coach/ugc/dashboard?window=30`. RBAC: requester must be the coach owner or a coach-team member with `READ_ANALYTICS`.

### Privacy

- No buyer PII exposed to the coach. The conversions row shows GMV and currency only; buyer identity stays internal.
- No creator PII beyond `publicHandle` and platform.
- Aggregates with `n < 3` for any cell are masked to `<3` to prevent re-identification.

## Cross-Link to Wave 7 Funnel

The Wave 7 buyer funnel (`../buyer-funnel/buyer-funnel-and-attribution.md`) defines the **post-click** journey: page view, scheduling, application, checkout, billing webhooks. UGC attribution attaches **before** that funnel.

Integration points:

- The Wave 7 funnel reads `tgp_ugc` cookie at `PAGE_VIEW` and includes the resolved `clickEventId` in its own funnel rows. We do not duplicate the data; the Wave 7 row references our event id.
- On Stripe webhook for a successful charge, the billing handler calls `attributeConversion({ accountId, email, stripeChargeId })`. We resolve the chain and write `kind=CONVERSION` (or `CONVERSION_DIRECT`).
- The Wave 7 attribution dashboard ("where did this customer come from?") shows UGC as one channel alongside organic, paid, affiliate, and direct.

## Failure Modes

### 1. Link rot (deleted clip, dead short link)

- Detection: a periodic job (`ugcClipHealthCheck`, daily) calls each platform's oEmbed/public URL and marks `UgcClip.status = TAKEN_DOWN` on 404.
- Behavior: subsequent clicks tagged `CLICK_DEAD`; redirect still works (ungainly URL still resolves to coach page) but no attribution fires.
- Reward impact: per `./rewards-spec.md`, view-window rewards stop accruing. Already-paid rewards are not clawed back unless fraud is detected.

### 2. Attribution race (two clicks within 60s)

- Detection: the conversion resolver finds >1 qualifying click within 60s of each other.
- Behavior: first-click wins (creator who genuinely drove the discovery, not the noise on top).
- Audit: both events linked via `parentClickEventId`; the runner-up is annotated `attributionLossReason=RACE_LOST`.

### 3. Duplicate creator (same buyer, multiple clips, same creator)

- Behavior: still last-touch within 30d. Single conversion -> single attribution -> single reward. We don't double-pay the same creator for two clips on the same buyer.
- Edge case: if both clips have a `clipReward` (per-conversion bonus), only the winning clip pays out. Spec'd in `./rewards-spec.md`.

### 4. Platform OAuth expiry (creator disconnected)

- Detection: the metadata refresh job fails to load impression counts for `creator.platformAccessToken` after 7 days of refresh failures.
- Behavior: clip stays LIVE (the public URL still works), short link still resolves, click + conversion attribution still works. Only **impression-based** reward calculation pauses (we can't trust counts) — view-verification trust ladder downgrades the clip to "manual proof required" per `./rewards-spec.md`.
- Notification: creator gets an in-app notice + email to re-auth.

### 5. Fingerprint collision (cross-device false positive)

- Detection: low-confidence fingerprint match producing implausible attribution (e.g., conversion country differs from click country by >2 hops).
- Behavior: tagged `attributionConfidence=LOW`. If the dispute window flag is set on the program, the conversion is held in `PENDING_REVIEW` for 24h before the creator's reward enters the payout queue.
- Mitigation: fingerprint is intentionally coarse + rotated to reduce collision but also to limit re-identification — we accept some loss in exchange for not retaining strong identifiers.

### 6. Cookie blocked / cleared (Safari ITP, incognito, manual clear)

- Behavior: fall through to logged-in match -> email match -> fingerprint match. If nothing matches, `kind=CONVERSION_DIRECT` with no creator reward.
- Mitigation: the Wave 7 funnel ALSO sets a server-stored, account-bound attribution row at logged-in checkout, increasing recall.

### 7. Self-referral (buyer is the creator or a known associate)

- Detection: `creatorId` and `buyerAccountId` match, OR creator and buyer share a payment method fingerprint, OR share a household IP-prefix hash.
- Behavior: conversion still recorded; creator reward suppressed. Tagged `selfReferralBlocked=true` for audit.

### 8. Currency mismatch on conversion

- Behavior: we record the conversion in the buyer's checkout currency. Reward calculation is per-program in the program's currency; FX is applied at payout time using a daily-locked rate (per `./payout-pipeline.md`).
- We never silently sum across currencies in a coach dashboard topline.

## Test Plan

- **Unit**: short-link resolver, UTM pack codec, attribution resolver (last-touch, race tiebreaker, self-referral suppression), fingerprint hashing.
- **Integration**: Stripe webhook -> attribution chain -> reward eligibility (mocked Stripe + mocked platform OEmbed).
- **E2E**: synthetic buyer journey on a staging cluster — click, page view, checkout, conversion shows in coach dashboard within 60s.
- **Load**: edge handler at 5k RPS, p95 < 50ms.
- **Privacy**: assert no buyer email or creator email is ever forwarded to PostHog; only hashes and public handles.

## Open Questions

- Should we expose **creator-side** discovery analytics (which of my clips drove buyers to which coaches)? Recommended: yes, behind creator dashboard, masked to `<3` for low-volume cells. Tracked separately in the rewards spec.
- Should we credit **partial** attribution (linear, time-decay) instead of last-touch? OWNER_DECISION: defer to v2; v1 is last-touch with first-touch tiebreaker.
- Cross-platform de-dup of impressions: out of scope; we trust each platform's reported count and apply trust-ladder downgrade for unverified ones.

## References

- `./README.md` — content rewards overview
- `./rewards-spec.md` — full rewards data model and view-verification trust ladder
- `./payout-pipeline.md` — creator payouts via Stripe Connect
- `../buyer-funnel/buyer-funnel-and-attribution.md` (Wave 7) — post-click buyer journey
- `../affiliate/README.md` — affiliate program (separate revenue share, distinct from UGC rewards)
