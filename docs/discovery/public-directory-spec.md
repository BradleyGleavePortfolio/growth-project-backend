# Public Directory Spec — Cards, Filters, Pagination, URLs, SSR

Status: DRAFT spec. Docs only. Schema deltas illustrative.

This file defines the public-facing read surface for coach and app discovery. It owns the canonical card schema, filter taxonomy, ranking input shape (ranking algorithm itself in `recommendation-engine.md`), pagination contract, URL structure, and SSR/crawler policy.

## Table of contents

1. Card schema (coach card + sub-coach team + app card)
2. Filter taxonomy
3. Search input + canonicalisation
4. Pagination + cursor
5. Sub-coach surfacing under parent
6. URL structure + slug rules
7. SSR + crawler policy
8. Prisma schema deltas (illustrative)
9. State-transition table — `CoachListing`, `AppListing`
10. Failure modes
11. Day-1 implementation order
12. Test plan
13. Performance budget detail

---

## 1. Card schema

### 1.1 Coach card (`CoachCardV1`)

```ts
interface CoachCardV1 {
  schemaVersion: "v1";
  coachId: string;                    // ULID
  slug: string;                       // public, lowercase, kebab-case, 3-48 chars
  displayName: string;                // 2-60 chars, unicode-safe, no zero-width
  avatar: {
    url: string;                      // CDN URL, signed
    blurhash: string;                 // for SSR placeholder
    width: number;
    height: number;
  };
  headline: string;                   // 8-120 chars, plain text, no markdown
  archetypeTags: ArchetypeTag[];      // 1-3, see Section 2.1
  nicheTags: NicheTag[];              // 1-5, see Section 2.2
  modality: Modality;                 // online | in_person | hybrid
  geo?: {
    cityLabel: string;                // "Austin, TX" — display only
    countryCode: string;              // ISO 3166-1 alpha-2
    h3CellResolution: number;         // 7 (~5km) — used for radius search
    h3Cell: string;                   // for filter; never display raw
  };
  startingPrice?: {
    amount: string;                   // Decimal(14,2) serialised as string
    currency: string;                 // ISO 4217
    cadence: "month" | "week" | "session" | "one_time";
    isStartingFrom: true;             // always "from X" — never absolute
  };
  verifiedAchievements: VerifiedAchievementChip[]; // 0-4 surfaced; max 8 stored
  team?: {
    subCoachCount: number;            // computed; sub-coaches with capability granted
    surfacedSubCoachIds: string[];    // up to 3 most relevant
  };
  trustBadges: TrustBadge[];          // earned, see trust-and-safety.md
  cta: {
    primary: "apply" | "checkout" | "book_call" | "join_waitlist";
    secondary?: "view_profile";
  };
  featuredSlot?: {
    tier: "bronze" | "silver" | "gold";
    expiresAt: string;                // ISO8601
    sponsoredLabel: "Sponsored";      // mandatory disclosure
  };
  freshnessSignal: {
    profileUpdatedAt: string;         // ISO8601
    lastActiveAt: string;             // ISO8601 — derived
  };
  noindex: boolean;                   // honored at SSR
}
```

Notes:
- `verifiedAchievements` are chips, max 4 surfaced on card, 8 on profile. Each chip has issuer, type, issued-at, proof-id (opaque). See `trust-and-safety.md` Section 1.
- `trustBadges` are platform-issued: `verified_identity`, `multi_year_coach` (>= 2y on platform), `program_completion_count_500plus` (Wave 8 ledger). Never invented for marketing.
- `startingPrice.isStartingFrom` is always `true` to enforce that displayed prices are starting points; absolute pricing is on the coach profile, not the card.
- `geo.h3Cell` uses Uber H3 hex grid; resolution 7 (~5km edge). Display string is city/country only; precise location never returned.
- `noindex` is set per coach toggle; SSR adds `<meta name="robots" content="noindex">` when true.

### 1.2 Sub-coach surfacing (`team` block)

Sub-coaches with capability `SUB_COACH_INDEPENDENT_LISTING = false` (default) appear ONLY under parent's `team.surfacedSubCoachIds`. Sub-coaches with capability granted appear independently in `/discover/coaches` results AND under parent.

`surfacedSubCoachIds` is computed by:
1. all sub-coaches under parent with `is_active = true`,
2. filtered by parent's listing visibility,
3. ranked by `(verified_achievements_count desc, last_active_at desc)`,
4. top 3.

### 1.3 App card (`AppCardV1`)

```ts
interface AppCardV1 {
  schemaVersion: "v1";
  appId: string;
  slug: string;
  displayName: string;
  iconUrl: string;
  shortDescription: string;           // 8-180 chars
  category: AppCategory;              // enum, see 2.5
  pricing: {
    model: "free" | "freemium" | "subscription" | "one_time";
    startingPrice?: { amount: string; currency: string; cadence: string };
  };
  installCount: number;               // bucketed: 0-9, 10-49, 50-99, 100-499, 500+
  publisherCoachId?: string;          // null if platform-published
  trustBadges: TrustBadge[];
  freshnessSignal: { lastReleasedAt: string };
  noindex: boolean;
}
```

`installCount` is bucketed to prevent exact-count gaming and to avoid implying social-proof manipulation.

### 1.4 Card-render contract

Cards are rendered server-side for the first viewport (SSR for SEO + LCP) and hydrated client-side for filtering. All fields except `featuredSlot` and `team.surfacedSubCoachIds` are deterministic per coach state. Featured-slot is per-request because it's time-sensitive.

---

## 2. Filter taxonomy

Filters are exposed as query parameters. All values canonicalised before hashing into cache keys (Section 4 of README).

### 2.1 `archetype` (multi-select, OR)

Canonical archetype set (closed enum):

- `strength` — powerlifting, strongman, hypertrophy.
- `endurance` — running, cycling, triathlon, hyrox.
- `aesthetics` — bodybuilding, physique, contest prep.
- `general` — general fitness, weight loss, health span.

Coach picks 1-3. Surfaces in card.

### 2.2 `niche` (multi-select, OR; max 5 in URL)

Canonical 50-niche set v1. Stored in code as `NICHE_TAXONOMY_V1`. Coach selects 1-5 from this list. Free-text niches not allowed in v1 (anti-gaming + filter consistency).

Strength bucket: `powerlifting`, `strongman`, `hypertrophy`, `bodybuilding_natural`, `bodybuilding_enhanced_research`, `crossfit`, `olympic_lifting`, `kettlebell`, `calisthenics`.

Endurance bucket: `marathon`, `ultra`, `triathlon`, `cycling`, `hyrox`, `obstacle_race`, `swimming`, `rowing`, `running_5k_10k`.

Aesthetics bucket: `physique_men`, `physique_women`, `bikini_competition`, `figure_competition`, `classic_physique`, `wellness_competition`.

Goal bucket: `fat_loss`, `muscle_gain`, `body_recomposition`, `health_span`, `performance_general`, `injury_rehab` (with disclaimers; see banned claims), `mobility`, `posture`.

Population bucket: `women_only`, `men_only`, `over_40`, `over_50`, `pregnancy_postpartum`, `menopause`, `youth_athletes`, `masters_athletes`.

Lifestyle bucket: `vegan`, `vegetarian`, `keto_research_only`, `intermittent_fasting`, `plant_forward`.

Modality bucket (overlaps with `modality` filter but kept for niche depth): `online_only`, `in_person_only`, `hybrid`, `app_only`, `group_only`, `one_on_one_only`.

Sport bucket: `tennis`, `golf`, `combat_sports`, `bjj`, `mma`, `boxing`, `team_sports`.

Total: 50 canonical niches. Versioning: any change is `NICHE_TAXONOMY_V2` with migration plan. Old slugs are 301-redirected; cards mapped automatically with a confidence threshold; coaches notified to confirm.

### 2.3 `priceBand`

Canonical bands (USD-equivalent at last daily ECB rate; coach's own currency stored on row):

- `under_99_per_month`
- `99_to_249_per_month`
- `250_to_499_per_month`
- `500_to_999_per_month`
- `1000_plus_per_month`
- `one_time_under_499`
- `one_time_500_plus`
- `free_intro`

Cadence-aware: `per_session` and `per_week` mapped into per-month equivalents for filter purposes; profile shows real cadence.

### 2.4 `geo` (radius)

Query: `lat`, `lng`, `radius` (number), `unit` (`mi` | `km` | omitted → locale-default).

Server converts to H3 cells covering the radius; matches against `coach.h3Cell` (resolution 7). Max radius 500 km / 310 mi to bound query cost. If no `lat/lng`, fall back to country code (`country=US`).

### 2.5 `appCategory` (apps surface)

Closed enum: `nutrition_tracking`, `programming`, `accountability`, `community`, `analytics`, `payments_addon`, `content`, `assessment`, `recovery`, `mindset`.

### 2.6 `outcomeCategory` (multi-select)

Closed enum: `fat_loss`, `muscle_gain`, `strength_pr`, `endurance_pr`, `competition_prep`, `health_metric_improvement`, `habit_formation`. Ties to verified-achievement chip categories. See `trust-and-safety.md`.

### 2.7 `modality`

Closed enum: `online`, `in_person`, `hybrid`. Default: omitted (returns all).

### 2.8 `sort`

Closed enum:
- `recommended` (default; ranking engine, Section 1 of `recommendation-engine.md`)
- `newest` (`profile_published_at desc`)
- `price_asc`
- `price_desc`
- `nearest` (only valid with `lat/lng` provided; else 400)
- `most_completions` (Wave 8 ledger; bucketed)

`sort=recommended` is the canonical default; `recommended` is the only ranking that uses personalisation signals (with consent).

### 2.9 Filter combination rules

- `archetype` OR within filter, AND across filters.
- `niche` OR within filter, AND across filters.
- `outcomeCategory` OR within filter, AND across filters.
- `priceBand` AND across filters.
- `geo` is a hard intersection.
- `modality` is a hard intersection.

Any unknown filter key is dropped silently in cache-key canonicalisation (forward-compat). Logged at debug.

---

## 3. Search input + canonicalisation

### 3.1 Free-text query `q`

Optional. Length 0-80. Stripped to NFKC. Lowercased. Diacritics folded for index match (preserved for display). Used as a BM25 (or pgroonga / pg_trgm) lexical match against `displayName`, `headline`, `nicheTags`, plus a vector match against the coach embedding (recommendation-engine.md Section 4).

Anti-spam: queries with > 5 distinct emoji or repeated characters > 8 are rejected with 400.

### 3.2 Canonicalisation for cache key

```ts
canonicalise(filters: RawFilters): CanonicalFilters {
  return {
    q: filters.q?.trim().toLowerCase().normalize("NFKC") ?? null,
    archetype: [...new Set(filters.archetype ?? [])].sort(),
    niche: [...new Set(filters.niche ?? [])].sort(),
    priceBand: [...new Set(filters.priceBand ?? [])].sort(),
    outcomeCategory: [...new Set(filters.outcomeCategory ?? [])].sort(),
    modality: filters.modality ?? null,
    geo: filters.geo ? {
      h3Cells: h3CellsForRadius(filters.geo).sort(),
      countryFallback: filters.geo.countryCode ?? null,
    } : null,
    sort: filters.sort ?? "recommended",
  };
}

filterHash(c: CanonicalFilters): string {
  return sha256(JSON.stringify(c));
}
```

Stable JSON ordering required (alphabetic keys) for hash stability across versions. JSON serialiser must be deterministic.

---

## 4. Pagination + cursor

Cursor-based; no offset pagination (offset breaks under churn).

### 4.1 Cursor format

```
cursor = base64url( hmac_sha256( server_secret, payload ) || ":" || payload )
payload = { score: number, tieBreaker: ulid, page: number }
```

- `score` is the ranking score from the recommendation engine (or sort-key value for non-recommended sorts).
- `tieBreaker` is the coach's ULID, used to disambiguate equal scores.
- `page` is informational, capped at 100 to bound enumeration.

Cursors are HMAC-signed to prevent forgery. Forged cursor → 400 with `code: "invalid_cursor"`.

### 4.2 Page size

- Default: 24 cards.
- Max: 48 cards.
- SSR first page: 12 cards above the fold, hydrated.

### 4.3 Stability under churn

Ranking is computed against a snapshot taken at first-page request time. Snapshot ID is embedded in cursor. If snapshot is older than 5 minutes, a new snapshot is computed and the user is gently rebased (response includes `rebased: true`, client may show subtle "results updated" indicator).

### 4.4 Empty / partial pages

Empty result returns `{ items: [], nextCursor: null }`. Partial last page returns items + `nextCursor: null`.

---

## 5. Sub-coach surfacing under parent

Three modes determined by parent's capability grant:

- **Mode A — bundled** (default; `SUB_COACH_INDEPENDENT_LISTING = false`): sub-coaches appear only under parent card's `team.surfacedSubCoachIds`. Profile page shows full team.
- **Mode B — independent** (`SUB_COACH_INDEPENDENT_LISTING = true`): sub-coach appears as own card in `/discover/coaches` AND under parent's `team`.
- **Mode C — independent-only**: not in v1. Reserved for future where sub-coach is fully independent. Requires parent severance — out of scope.

Sub-coach card in Mode B has:
- own `slug`,
- `parentCoachId` field (rendered as "Part of {parent} team" badge),
- inherits parent's `trustBadges` of class `parent_inherited` (e.g. parent's `verified_identity` propagates as `inherited_verified_identity`),
- own `verifiedAchievements`,
- own `startingPrice`.

---

## 6. URL structure + slug rules

### 6.1 URL surface

| URL                                  | Purpose                                  | Indexable | Cache TTL  |
| ------------------------------------ | ---------------------------------------- | --------- | ---------- |
| `/discover`                          | landing — featured + categories          | Y         | 60s edge   |
| `/discover/coaches`                  | coach grid with filters                  | Y         | 30s edge   |
| `/discover/apps`                     | app grid with filters                    | Y         | 30s edge   |
| `/discover/c/{slug}`                 | coach profile                            | Y/N (per coach) | 60s edge |
| `/discover/c/{slug}/team/{subSlug}`  | sub-coach profile (Mode A bundled)       | Y/N       | 60s edge   |
| `/discover/c/{slug}/{programSlug}`   | program landing under coach              | Y         | 60s edge   |
| `/discover/a/{appSlug}`              | app profile                              | Y         | 60s edge   |
| `/discover/category/{archetype}`     | archetype landing                        | Y         | 300s edge  |
| `/discover/niche/{nicheSlug}`        | niche landing                            | Y         | 300s edge  |
| `/discover/near/{country}/{citySlug}` | geo landing                             | Y         | 300s edge  |

### 6.2 Slug rules

- Slug regex: `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$` (3-48 chars, no leading/trailing hyphen).
- Reserved slugs: `admin`, `api`, `app`, `apps`, `c`, `coach`, `coaches`, `discover`, `help`, `health`, `static`, `team`, `tgp`, `the-growth-project`, `whop`, `system`, `null`, `undefined`, `webhooks`, `auth`, `login`, `logout`, `signup`. Reserved set lives in `RESERVED_SLUGS_V1` constant.
- Slug uniqueness: globally unique per `Coach`. Sub-coach slug unique per parent.
- Slug change history: previous slugs 301-redirect for 12 months; old slug stored in `CoachSlugHistory`.

### 6.3 Canonical URL handling

- Trailing slash: stripped (canonical = no trailing slash).
- Query parameter ordering: canonicalised in `<link rel="canonical">` (sorted alphabetically).
- Pagination: `?cursor=...` is in canonical, but `<link rel="canonical">` for page 1 omits cursor.
- UTM parameters: stripped from canonical URL but preserved in tracking (see `buyer-funnel-and-attribution.md` Section 4).

---

## 7. SSR + crawler policy

### 7.1 SSR strategy

- Edge SSR (Vercel/CDN) for `/discover`, `/discover/coaches`, `/discover/apps`, `/discover/c/{slug}` first viewport.
- HTML cache TTL 30-60s (per Section 6.1) at edge; revalidate-on-demand on coach profile mutation via cache-tag invalidation.
- Below-the-fold cards loaded via client-side fetch with cursor.
- Schema.org JSON-LD embedded for crawler: `Person` for coach, `LocalBusiness` for in-person coaches, `SoftwareApplication` for apps.

### 7.2 Crawler-specific behaviour

- `robots.txt` allows `/discover/*` except `/discover/c/{slug}` for coaches with `noindex = true`.
- `sitemap.xml` generated daily; includes only listing-on coaches with `noindex = false`.
- `<meta name="robots">` honored per-coach.
- Crawler detection (User-Agent allowlist for Googlebot, Bingbot, etc.) used to disable A/B test traffic split.

### 7.3 OWNER_DECISION 6 honoring

Default policy is **opt-out indexing** (recommended). Coach toggle `profile.publicListingEnabled` defaults to `true` on first profile completion; coach toggle `profile.searchEngineIndexable` defaults to `true` and can be set to `false` for `noindex`.

---

## 8. Prisma schema deltas (illustrative)

```prisma
model CoachListing {
  id                       String           @id @default(cuid())
  coachId                  String           @unique
  coach                    Coach            @relation(fields: [coachId], references: [id], onDelete: Cascade)
  slug                     String           @unique
  displayName              String
  headline                 String           @db.VarChar(120)
  archetypeTags            String[]         // closed enum stored as text[]
  nicheTags                String[]
  modality                 ListingModality
  startingPriceAmount      Decimal?         @db.Decimal(14, 2)
  startingPriceCurrency    String?          @db.Char(3)
  startingPriceCadence     PriceCadence?
  countryCode              String?          @db.Char(2)
  cityLabel                String?
  h3Cell                   String?
  publicListingEnabled     Boolean          @default(false)
  searchEngineIndexable    Boolean          @default(true)
  publishedAt              DateTime?
  lastActiveAt             DateTime         @default(now())
  state                    ListingState     @default(DRAFT)
  createdAt                DateTime         @default(now())
  updatedAt                DateTime         @updatedAt
  // Audit
  createdById              String
  updatedById              String
  // GDPR cascade is via Coach.onDelete: Cascade through coachId
  slugHistory              CoachSlugHistory[]
  verifiedAchievements     VerifiedAchievement[]
  trustBadges              TrustBadge[]
  featuredSlot             FeaturedSlot?
  @@index([state, publicListingEnabled, lastActiveAt])
  @@index([h3Cell])
  @@index([archetypeTags])
}

enum ListingState {
  DRAFT
  PENDING_REVIEW
  ACTIVE
  SUSPENDED
  REMOVED
}

enum ListingModality {
  ONLINE
  IN_PERSON
  HYBRID
}

enum PriceCadence {
  MONTH
  WEEK
  SESSION
  ONE_TIME
}

model CoachSlugHistory {
  id              String       @id @default(cuid())
  listingId       String
  listing         CoachListing @relation(fields: [listingId], references: [id], onDelete: Cascade)
  oldSlug         String
  changedAt       DateTime     @default(now())
  retiresAt       DateTime     // = changedAt + 12 months
  @@index([oldSlug])
}

model AppListing {
  id                   String        @id @default(cuid())
  appId                String        @unique
  slug                 String        @unique
  displayName          String
  shortDescription     String        @db.VarChar(180)
  category             AppCategory
  pricingModel         AppPricingModel
  startingPriceAmount  Decimal?      @db.Decimal(14, 2)
  startingPriceCurrency String?      @db.Char(3)
  publisherCoachId     String?
  state                ListingState  @default(DRAFT)
  publishedAt          DateTime?
  lastReleasedAt       DateTime?
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt
  @@index([state, category])
}

enum AppCategory {
  NUTRITION_TRACKING
  PROGRAMMING
  ACCOUNTABILITY
  COMMUNITY
  ANALYTICS
  PAYMENTS_ADDON
  CONTENT
  ASSESSMENT
  RECOVERY
  MINDSET
}

enum AppPricingModel {
  FREE
  FREEMIUM
  SUBSCRIPTION
  ONE_TIME
}

model DiscoverySnapshot {
  id           String   @id @default(cuid())
  takenAt      DateTime @default(now())
  filterHash   String
  capabilityHash String
  resultIds    String[]
  // 5 minute TTL; rotated by background job
  expiresAt    DateTime
  @@index([filterHash, capabilityHash, expiresAt])
}
```

GDPR cascade: `CoachListing.onDelete: Cascade` from `Coach`. `DiscoveryEvent` (in `buyer-funnel-and-attribution.md`) cascades from `Coach` and `Client`. All audit fields in `CoachListing`. No PII stored on `AppListing`.

---

## 9. State-transition table

### 9.1 `CoachListing.state`

| From            | To              | Trigger                           | Side effects                             |
| --------------- | --------------- | --------------------------------- | ---------------------------------------- |
| DRAFT           | PENDING_REVIEW  | coach submits for review          | enqueue moderation job                   |
| PENDING_REVIEW  | ACTIVE          | admin approves                    | publish; clear cache; emit `listing.activated` |
| PENDING_REVIEW  | DRAFT           | admin rejects                     | reason recorded; coach notified          |
| ACTIVE          | SUSPENDED       | refund-rate breach OR admin       | hide from public; preserve URL; sponsored slot pro-rata refund |
| ACTIVE          | DRAFT           | coach edits material fields       | re-enter review; list visibility paused  |
| SUSPENDED       | ACTIVE          | admin reinstates                  | clear cache; emit `listing.reactivated`  |
| any             | REMOVED         | coach offboarding OR admin        | hard-delete cascade per GDPR; URL 410    |

Transitions are recorded in `AuditLog` with actor, reason, before/after state, scope.

### 9.2 `AppListing.state`

Mirrors `CoachListing.state` with same enum; suspended apps are unsearchable but install entitlements continue per Wave 6.

---

## 10. Failure modes

### 10.1 Slug collision at creation

- **Detection**: `Prisma` unique constraint violation on `CoachListing.slug`.
- **User-facing**: 409 `code: "slug_taken"`.
- **Recovery**: client retries with suggested suffix (`-2`, `-3`, etc.) up to `-9`; beyond that, ask coach to choose new slug.
- **Audit**: collision attempts logged; pattern of collisions on a high-value slug triggers ADMIN review.

### 10.2 Slug change abuse (squatting on retired slugs)

- **Detection**: rate-limit of 1 slug change per 30 days per coach. Burst > 3 changes / 12 months → ADMIN flag.
- **Recovery**: admin override via console.
- **Audit**: `CoachSlugHistory` is append-only.

### 10.3 Filter cache poisoning

- **Detection**: cache-key uses HMAC of canonicalised filter; client cannot inject arbitrary keys.
- **Recovery**: any deserialisation error → 400; never a stale-cache serve.
- **Audit**: invalid-cursor attempts logged.

### 10.4 SSR cache poisoning via crafted query string

- **Detection**: SSR cache key includes only canonicalised filters; unknown params are stripped before key derivation.
- **Recovery**: even if a poisoned cache served, content is public-tier only — no PII risk. Refresh on next TTL.
- **Audit**: anomalous query-string entropy logged.

### 10.5 Snapshot drift causing duplicate / missing items

- **Detection**: ranking snapshot keyed by `(filter_hash, capability_hash, taken_at)`. If TTL expired, force resnapshot.
- **Recovery**: response field `rebased: true` flagged to client; client may show "results updated" toast.
- **Audit**: rebase rate tracked; > 5% rebase rate triggers backend SLO alert.

### 10.6 Crawler indexing private profile

- **Detection**: profile mutated to `noindex = true` while crawler last cached `noindex = false`.
- **Recovery**: cache-tag invalidation on `noindex` toggle clears edge cache; SSR re-renders with `<meta robots noindex>`. Coach can additionally request emergency `X-Robots-Tag` header via support.
- **Audit**: every `noindex` toggle is audited.

### 10.7 Geo H3 cell mis-quantisation

- **Detection**: H3 cells computed server-side from coach lat/lng on profile mutation; never trusted from client.
- **Recovery**: re-derivation job runs nightly to detect drift; mismatches trigger backfill.

### 10.8 Reserved-slug brute-force

- **Detection**: any attempt to set a reserved slug → 422 `code: "slug_reserved"`. Rate-limit of 5 attempts per IP per hour.
- **Recovery**: blocked.
- **Audit**: > 20 attempts / hour from one IP → CAPTCHA challenge.

---

## 11. Day-1 implementation order

1. `CoachListing` Prisma model + migration; `ListingState` state machine.
2. Slug rules + reserved set; `CoachSlugHistory`.
3. `CoachCardV1` projection from `CoachListing` + `Coach`.
4. Filter taxonomy constants (`ARCHETYPE_V1`, `NICHE_TAXONOMY_V1`, `PRICE_BAND_V1`).
5. Canonicalisation + cache key.
6. Cursor encoding + HMAC.
7. `GET /v1/discover/coaches` route with stub ranking (insertion order; recommendation engine added in PR after).
8. SSR for `/discover/coaches` page first viewport.
9. `<link rel="canonical">` + sitemap.xml + robots.txt.
10. `AppListing` model + `/discover/apps` endpoint.

---

## 12. Test plan

### 12.1 Unit

- Slug regex coverage (positive and negative, including unicode trickery).
- Filter canonicalisation determinism (1000-fuzz).
- Cursor encode/decode roundtrip + HMAC tamper rejection.
- H3 cell containment math for radius queries.
- Price band classification across cadences (per_month, per_session, per_week, one_time).

### 12.2 Integration

- Coach creates listing → submits → admin approves → public card visible.
- Listing in DRAFT not surfaced.
- Featured-slot precedence in ordering.
- Reserved-slug rejection.
- Slug history 301 redirect after slug change.
- `noindex` toggle reflected in `<meta>` and sitemap.

### 12.3 E2E

- Anonymous browse `/discover/coaches?archetype=strength&niche=powerlifting`, click card, land on profile, click apply.
- Crawler simulation (Googlebot UA) returns full SSR HTML with JSON-LD.

### 12.4 Load

- 10k coaches, 1k QPS on `GET /discover/coaches` with mixed filters; p95 < 250ms.
- 100k profile-mutation rate verifying cache-tag invalidation does not stampede.

### 12.5 Security

- Cursor forgery → 400.
- Reserved-slug attempts rate-limited.
- IDOR on `CoachListing.update` (only owner-coach or admin can edit).
- SSRF on avatar URL upload (handled in Wave 1 admin upload pipeline; ref).

### 12.6 Privacy

- GDPR delete cascade on `Coach` removes `CoachListing`, `CoachSlugHistory`, `VerifiedAchievement`, `DiscoveryEvent` (Wave 7 + 8).
- Crawler does not see coaches with `publicListingEnabled = false`.

---

## 13. Performance budget detail

| Endpoint                       | 100 coaches p95 | 1k p95 | 10k p95 | Cache strategy                            |
| ------------------------------ | --------------- | ------ | ------- | ----------------------------------------- |
| `GET /discover/coaches`        | 80ms            | 150ms  | 250ms   | Edge 30s + Redis 60s + read-replica       |
| `GET /discover/coaches/:slug`  | 60ms            | 100ms  | 180ms   | Edge 60s + Redis 120s                     |
| `GET /discover/apps`           | 70ms            | 130ms  | 220ms   | Edge 30s + Redis 60s                      |
| Profile SSR TTFB               | 200ms           | 300ms  | 400ms   | Edge HTML 60s + ISR 5min                  |
| Sitemap generation             | 5s              | 30s    | 90s     | Daily background; static                  |

Read-replica: all `/discover/*` reads go to read-replica with 1s lag tolerance. Coach-side mutation goes to primary with read-after-write on profile detail.

Redis keys:
- `discovery:coaches:filter:{filterHash}:{capabilityHash}:{cursor}` TTL 60s.
- `discovery:coach:slug:{slug}` TTL 120s.
- `discovery:snapshot:{snapshotId}` TTL 5min, eviction-allowed.

CDN tags:
- `coach-card-{coachId}` invalidated on profile mutation.
- `coach-list` invalidated on featured-slot change or moderation event.

---

## 14. Audit log entries

Every listing mutation emits an `AuditLog` row with:
- actor (`coachId` or `adminId`),
- action (`listing.create | listing.update | listing.publish | listing.suspend | slug.change | featured.purchase | trustbadge.grant`),
- before/after JSON diffs (PII-redacted),
- scope (`org/coach`),
- request_id, ip_hash, user_agent_hash.

Audit retention: 7 years. GDPR delete on coach offboarding tombstones audit rows (replaces PII with `coach:tombstone:{hashedId}`) but preserves action history for compliance.

---

## 15. Cross-repo

- `growth-project-mobile`: native filter UI mirrors `ARCHETYPE_V1`, `NICHE_TAXONOMY_V1` constants. Constants exported from a shared package or duplicated with version pin.
- `tgp-finance-app`: not directly affected by directory; only by featured-slot billing (separate file).

---

## 16. Schema.org JSON-LD shapes

### 16.1 Coach profile (`Person` + `LocalBusiness` if in-person)

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Jane Doe",
  "url": "https://thegrowthproject.app/discover/c/jane-doe",
  "image": "https://cdn.tgp.app/coach/01J7.../avatar.jpg",
  "jobTitle": "Powerlifting Coach",
  "description": "Natural powerlifting coach for masters athletes",
  "knowsAbout": ["Powerlifting","Strength Training","Masters Athletes"],
  "hasCredential": [
    { "@type": "EducationalOccupationalCredential",
      "credentialCategory": "Certification",
      "name": "USAPL National Qualifier 2024" }
  ],
  "worksFor": { "@type": "Organization", "name": "The Growth Project" }
}
```

For in-person coaches, additional `LocalBusiness` JSON-LD is emitted with `address`, `geo` (coarse), `priceRange`, `openingHours` (if provided).

For sponsored cards, JSON-LD includes `Advertisement` reference to surface paid disclosure.

### 16.2 App profile (`SoftwareApplication`)

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Macro Tracker Pro",
  "applicationCategory": "HealthApplication",
  "operatingSystem": "Web, iOS, Android",
  "offers": { "@type": "Offer", "price": "9.99", "priceCurrency": "USD" }
}
```

---

## 17. Coach profile additional surfaces

### 17.1 Profile page sections (`/discover/c/{slug}`)

1. Hero (avatar, displayName, headline, primary CTA, sponsored badge if featured).
2. Quick facts (modality, geo label, starting price, trust badges).
3. About (long-form, max 4000 chars, sanitised markdown subset: bold/italic/lists/links).
4. Verified achievements (up to 8 with detail expand).
5. Programs offered (Wave 6).
6. Team (sub-coaches, if Mode A).
7. Testimonials (consent-valid only).
8. Transformation gallery (if uploaded).
9. FAQ (coach-authored q&a).
10. Booking / application form OR checkout CTA.

### 17.2 Long-form sanitisation

Markdown subset whitelist: `**bold**`, `*italic*`, `- list`, `1. ordered`, `[text](url)` (URL allowlist: https only, max 5 links).

Banned: HTML, JS, iframes, scripts, styles, custom data-attributes, raw URLs in plain text without anchor.

Sanitiser: server-side via `dompurify` strict config + custom markdown parser. Test fixtures cover XSS payloads.

### 17.3 FAQ

- Max 10 q/a pairs.
- Each pair: question (max 200 chars), answer (max 1000 chars).
- Same sanitisation as long-form.
- Optional category tag (e.g. "pricing", "scheduling", "approach").

### 17.4 Programs surface

Programs from Wave 6 surface here. Card shape:

```ts
interface ProgramCardOnProfile {
  programId: string;
  title: string;
  durationWeeks: number;
  modality: Modality;
  startingPrice: { amount: string; currency: string; cadence: string };
  enrollmentState: "open" | "waitlist" | "closed";
}
```

Closed programs surface as "Closed — join waitlist" with a waitlist CTA.

---

## 18. Sub-coach profile (`/discover/c/{slug}/team/{subSlug}`)

### 18.1 Distinguishing from parent

- Header: "Part of {parent.displayName}'s team" with link to parent.
- Avatar of sub-coach.
- Sub-coach's own headline + verified achievements (separate from parent).
- Inherited trust badges visually distinct (different color or "Inherited from parent" tooltip).

### 18.2 Independent listing mode

If `SUB_COACH_INDEPENDENT_LISTING = true`:

- Sub-coach has own `/discover/c/{slug}` URL (their own slug, not parent/team/sub).
- AND retains `/discover/c/{parentSlug}/team/{subSlug}` URL (canonical chosen via `<link rel="canonical">` to the independent URL).

### 18.3 Permissions

Sub-coach can edit own headline + display-name only in v1. Pricing, niches, archetype inherit from parent unless capability granted.

---

## 19. Apps profile (`/discover/a/{appSlug}`)

### 19.1 Sections

1. Hero (icon, displayName, shortDescription, install CTA).
2. Screenshots (up to 6, sanitised, EXIF stripped).
3. Pricing (model, starting price, comparison vs platform default).
4. Publisher info (linked to coach profile if coach-published).
5. Compatible coach categories (which archetypes/niches benefit).
6. Long-form description (sanitised markdown).
7. Changelog (last 5 releases, dates).
8. Trust badges + install count bucket.

### 19.2 Install count bucketing

Buckets: `0-9`, `10-49`, `50-99`, `100-499`, `500+`. Anti-gaming: prevents implication of social proof from low absolute count.

### 19.3 Coach-published vs platform-published

- Coach-published apps show `By {coach.displayName}` with linked profile.
- Platform-published apps show `By The Growth Project` with no coach linkage.
- Distinct visual treatment.

---

## 20. Landing page (`/discover`)

### 20.1 Layout

1. Hero (search bar + popular archetypes).
2. Featured coaches (Gold + Silver tiers, sponsored disclosure).
3. Editorial picks (curated, distinct visual).
4. Browse by archetype (4 archetype tiles).
5. Browse by niche (popular 12 niches).
6. Apps marketplace (top 6 apps).
7. Coaches near you (geo-detected, up to 8).
8. Trust + safety footer (link to policy).

### 20.2 SSR + hydration

- Hero + featured + editorial: SSR.
- Below the fold: client-fetch.
- TTFB target: 200ms (100 coaches), 400ms (10k coaches).

### 20.3 Sponsored disclosure on landing

- Featured coach cards: "Sponsored" badge.
- Editorial picks: "Editor's Pick" badge.
- Browse-by sections: NO sponsored placements (organic only).

---

## 21. Search bar UX

### 21.1 Autocomplete

- Suggests: coach names, niches, archetypes, popular queries.
- Backend: `/v1/discover/autocomplete?q=...&limit=10`.
- Cache: per-`q` 5-min TTL.
- Privacy: query strings logged with hash only (not raw) unless analytics consent.

### 21.2 Empty-state

When no results:

- "No coaches match your filters. Try broadening?" with suggestion chips.
- Suggest related niches via co-occurrence matrix.
- Surface "All coaches in {archetype}" CTA.

### 21.3 Clarification prompts

For ambiguous queries (e.g. "fitness"), surface clarifying chips: "Strength?", "Endurance?", "Aesthetics?".

---

## 22. Filter UI conventions

### 22.1 Sticky filter rail

- Desktop: left rail, sticky, collapsible per section.
- Mobile: bottom-sheet drawer, sticky CTA "Apply (N coaches)".
- Filter count chips on top show selected.

### 22.2 Reset

- Per-filter reset (X icon next to chip).
- Global reset (button at top).

### 22.3 Persistence

- Filters preserved in URL (canonicalised).
- Back/forward navigation restores filter state.
- Browser back from profile returns to scroll position + filters intact.

---

## 23. Accessibility

- Card markup: `<article>` with `aria-labelledby`.
- CTA buttons: focusable, keyboard-accessible.
- Filter chips: ARIA roles `listbox` / `option`.
- Color contrast: WCAG AA minimum.
- Screen reader: "Sponsored" badge text read aloud before card content.
- Keyboard nav: tab through cards in DOM order; arrow keys within filter rail.

---

## 24. Internationalisation

### 24.1 Languages

v1: English (en-US, en-GB), Spanish (es-ES, es-MX), French (fr-FR), German (de-DE), Portuguese (pt-BR).

### 24.2 Translation layer

- UI strings (filter labels, CTA copy, badges) translated via `i18next`.
- Coach-authored content NOT auto-translated; surfaces in coach's preferred language.
- Optional v2: AI-summarised translation with explicit "machine-translated" disclosure.

### 24.3 RTL

Hebrew (he), Arabic (ar) layout supported via CSS logical properties; v2.

---

## 25. Migration / backfill plan

### 25.1 No schema backfill in this wave

- `prisma/schema.prisma` not touched by this PR.
- Implementation PR sequence creates `CoachListing` table fresh; coaches must opt in via console.

### 25.2 Coach onboarding for existing coaches

- Banner in coach console: "Set up your public profile (5 min)" with link to listing form.
- One-click prefill from existing `Coach.profile` fields if present.
- Prefilled draft surfaces in PENDING_REVIEW after coach completes required fields.

### 25.3 Sub-coach onboarding

- Parent coach grants `SUB_COACH_INDEPENDENT_LISTING` per sub-coach (default off).
- Without grant, sub-coach surfaces under parent only.

### 25.4 Slug claim race

- During onboarding, slug uniqueness contention possible. First-come-first-served. Late submitter prompted to choose alternative.

---

## 26. Operations runbooks (forward-pointer)

- `docs/deploy-runbook.md` (existing) extended with discovery cache flush procedure: `curl -X PURGE` against Cloudflare with tag pattern.
- Sitemap regeneration: nightly cron OR manual `bin/discovery-sitemap-rebuild` (to be authored in implementation PR).
- ADMIN moderation queue health check endpoint: `/v1/admin/discovery/queue/health`.

---

End `public-directory-spec.md`.
