# API & Mobile

Status: DRAFT spec. Docs only.

This file owns the REST/JSON surface for discovery: endpoints, error envelopes, pagination, idempotency, rate limits, cache strategy, mobile parity.

## Table of contents

1. Endpoint surface
2. Auth + scope
3. Error envelope
4. Pagination
5. Idempotency
6. Rate limits
7. Cache strategy (CDN + Redis)
8. Mobile parity
9. Versioning
10. OpenAPI source
11. Test plan
12. Day-1 implementation order

---

## 1. Endpoint surface

### 1.1 Public read

```
GET /v1/discover/coaches
GET /v1/discover/coaches/:slug
GET /v1/discover/apps
GET /v1/discover/apps/:slug
GET /v1/discover/categories
GET /v1/discover/niches
GET /v1/discover/landing
```

### 1.2 Public write (events only)

```
POST /v1/discover/events
```

### 1.3 Coach console (auth required)

```
GET    /v1/coach/discovery/listing
PATCH  /v1/coach/discovery/listing
POST   /v1/coach/discovery/listing/publish
POST   /v1/coach/discovery/listing/unpublish
GET    /v1/coach/discovery/funnel
GET    /v1/coach/discovery/sources
GET    /v1/coach/discovery/refund-rate
POST   /v1/coach/discovery/featured-slots
GET    /v1/coach/discovery/featured-slots
DELETE /v1/coach/discovery/featured-slots/:id
POST   /v1/coach/discovery/achievements
GET    /v1/coach/discovery/achievements
DELETE /v1/coach/discovery/achievements/:id
POST   /v1/coach/discovery/testimonials/:id/hide
POST   /v1/coach/discovery/testimonials/:id/request-edit
POST   /v1/coach/discovery/transformation-photos
DELETE /v1/coach/discovery/transformation-photos/:id
POST   /v1/coach/discovery/reports/:id/appeal
GET    /v1/coach/discovery/moderation
```

### 1.4 Client console (auth required)

```
POST   /v1/client/testimonials
PATCH  /v1/client/testimonials/:id/consent
DELETE /v1/client/testimonials/:id     # revoke + cascade
GET    /v1/client/testimonials
POST   /v1/client/transformation-photos/:id/consent
DELETE /v1/client/transformation-photos/:id
```

### 1.5 Admin (auth required, ADMIN role)

```
GET    /v1/admin/discovery/queue
POST   /v1/admin/discovery/queue/:id/decide
GET    /v1/admin/discovery/listings
PATCH  /v1/admin/discovery/listings/:id
POST   /v1/admin/discovery/listings/:id/suspend
POST   /v1/admin/discovery/listings/:id/reinstate
POST   /v1/admin/discovery/achievements/:id/decide
POST   /v1/admin/discovery/featured-slots/:id/refund
GET    /v1/admin/discovery/banned-claims
PATCH  /v1/admin/discovery/banned-claims
GET    /v1/admin/discovery/experiments
POST   /v1/admin/discovery/experiments
POST   /v1/admin/discovery/experiments/:id/start
POST   /v1/admin/discovery/experiments/:id/end
```

### 1.6 GDPR

```
GET    /v1/me/discovery/export        # NDJSON of own DiscoveryEvents
POST   /v1/me/discovery/delete        # GDPR delete request
```

### 1.7 Route table

| Verb | Path                                    | Auth scope            | Rate-limit class | Cache       |
| ---- | --------------------------------------- | --------------------- | ---------------- | ----------- |
| GET  | /v1/discover/coaches                    | none                  | public-read      | edge 30s    |
| GET  | /v1/discover/coaches/:slug              | none                  | public-read      | edge 60s    |
| GET  | /v1/discover/apps                       | none                  | public-read      | edge 30s    |
| GET  | /v1/discover/apps/:slug                 | none                  | public-read      | edge 60s    |
| GET  | /v1/discover/categories                 | none                  | public-read      | edge 600s   |
| GET  | /v1/discover/niches                     | none                  | public-read      | edge 600s   |
| GET  | /v1/discover/landing                    | none                  | public-read      | edge 60s    |
| POST | /v1/discover/events                     | none                  | events           | none        |
| GET  | /v1/coach/discovery/listing             | coach:listing:read    | coach            | none        |
| PATCH| /v1/coach/discovery/listing             | coach:listing:write   | coach            | none        |
| POST | /v1/coach/discovery/listing/publish     | coach:listing:write   | coach-strict     | none        |
| GET  | /v1/coach/discovery/funnel              | coach:funnel:read     | coach            | redis 60s   |
| POST | /v1/coach/discovery/featured-slots      | coach:featured:write  | coach-strict     | none        |
| POST | /v1/admin/discovery/queue/:id/decide    | admin:moderation:write| admin            | none        |
| GET  | /v1/me/discovery/export                 | self                  | gdpr             | none        |

Rate-limit classes defined in Section 6.

---

## 2. Auth + scope

### 2.1 Auth methods

- Public reads: anonymous.
- Coach console: JWT cookie (Wave 1 admin auth).
- Client console: JWT cookie.
- Admin: JWT + role claim `ADMIN`.
- Mobile: bearer token via OAuth2 PKCE.

### 2.2 Scopes (capability hash inputs)

- `coach:listing:read`
- `coach:listing:write`
- `coach:funnel:read`
- `coach:featured:write`
- `coach:moderation:read`
- `client:testimonial:write`
- `client:photo:write`
- `admin:moderation:read`
- `admin:moderation:write`
- `admin:experiments:write`
- `admin:billing:write`

### 2.3 Capability matrix references

See README Section "Personas + permission matrix".

### 2.4 Sub-coach scoping

- Sub-coaches use parent's scope unless `SUB_COACH_INDEPENDENT_LISTING` capability granted.
- Funnel queries scoped to parent + sub-coaches' aggregate (parent), or sub-coach's slice (sub-coach).

---

## 3. Error envelope

### 3.1 Shape

```ts
interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}
```

### 3.2 Canonical codes

- `validation_failed` (HTTP 400/422)
- `invalid_cursor` (HTTP 400)
- `unauthenticated` (HTTP 401)
- `forbidden` (HTTP 403)
- `not_found` (HTTP 404)
- `slug_taken` / `slug_reserved` (HTTP 409 / 422)
- `slot_capacity_exceeded` (HTTP 409)
- `eligibility_failed` (HTTP 403)
- `rate_limited` (HTTP 429)
- `consent_required` (HTTP 403)
- `payment_required` (HTTP 402)
- `internal` (HTTP 500)
- `service_unavailable` (HTTP 503)

### 3.3 Localisation

`message` is in English by default. Localised via `Accept-Language`. Translation table maintained per code.

### 3.4 Request ID

- Every response includes `X-Request-Id` header.
- Logged server-side with correlation across services.

---

## 4. Pagination

### 4.1 Cursor-based

All list endpoints use cursor-based pagination. See `public-directory-spec.md` Section 4 for cursor format.

### 4.2 Request

```
GET /v1/discover/coaches?archetype=strength&niche=powerlifting&cursor=eyJzY29...&limit=24
```

- `limit` default 24, max 48.
- `cursor` opaque; clients pass through unchanged.

### 4.3 Response

```json
{
  "items": [ /* CoachCardV1[] */ ],
  "nextCursor": "eyJzY29...",
  "rebased": false,
  "snapshotId": "01J7..."
}
```

- `nextCursor: null` indicates last page.
- `rebased: true` indicates snapshot rotated; client may surface "Updated" indicator.

---

## 5. Idempotency

### 5.1 Write endpoints

All POST/PATCH/DELETE endpoints support `Idempotency-Key` header.

- Format: ULID or UUIDv4.
- Server stores key + result for 24h.
- Replays return same response.
- Mismatched body with same key → 409 `code: "idempotency_conflict"`.

### 5.2 Event ingestion

`POST /v1/discover/events` uses per-event `clientEventId` (idempotent dedupe; see `buyer-funnel-and-attribution.md` Section 6.5).

### 5.3 Stripe webhooks

Featured-slot webhooks are idempotent on Stripe `event.id`.

---

## 6. Rate limits

### 6.1 Classes

| Class          | Limit                                  | Burst    | Scope          |
| -------------- | -------------------------------------- | -------- | -------------- |
| public-read    | 600 / min per IP                       | 60       | IP             |
| events         | 100 / 10s per IP, 200 / 10min per visitor | 30   | IP + visitor   |
| coach          | 600 / min per coach                    | 60       | coach          |
| coach-strict   | 30 / min per coach                     | 5        | coach          |
| admin          | 1200 / min per admin                   | 120      | admin          |
| gdpr           | 5 / day per user                       | 1        | user           |

### 6.2 429 response

```json
{
  "code": "rate_limited",
  "message": "Too many requests",
  "details": { "retryAfter": 30, "class": "public-read" }
}
```

`Retry-After` header included.

### 6.3 Implementation

- Cloudflare edge for IP-based rate limits.
- Redis token bucket for visitor/coach/admin scope.
- Sliding window log for GDPR (low volume).

---

## 7. Cache strategy

### 7.1 Edge (Cloudflare / Vercel)

| Path                        | TTL    | Tags                        |
| --------------------------- | ------ | --------------------------- |
| `/discover` (HTML)          | 60s    | `discover-landing`          |
| `/discover/coaches` (HTML)  | 30s    | `coach-list`                |
| `/discover/c/{slug}` (HTML) | 60s    | `coach-card-{coachId}`      |
| `/v1/discover/coaches`      | 30s    | `coach-list`                |
| `/v1/discover/coaches/:slug`| 60s    | `coach-card-{coachId}`      |
| `/v1/discover/apps`         | 30s    | `app-list`                  |
| `/v1/discover/categories`   | 600s   | `taxonomy`                  |

### 7.2 Redis

| Key pattern                                                       | TTL   | Purpose                       |
| ----------------------------------------------------------------- | ----- | ----------------------------- |
| `discovery:coaches:filter:{filterHash}:{capabilityHash}:{cursor}` | 60s   | filter result page            |
| `discovery:coach:slug:{slug}`                                     | 120s  | coach card                    |
| `discovery:snapshot:{snapshotId}`                                 | 300s  | ranking snapshot              |
| `discovery:embed:query:{queryHash}`                               | 3600s | query embedding               |
| `discovery:funnel:coach:{coachId}:{date}`                         | 60s   | coach funnel chart            |
| `discovery:taxonomy:{version}`                                    | 86400s| niche / archetype constants   |

### 7.3 Invalidation

- Tag-based purge on coach mutation (`coach-card-{id}`, `coach-list`).
- Tag-based purge on featured-slot state change (`coach-list`).
- Tag-based purge on moderation action (specific listing).
- TTL ceiling: 5 min hard for any cache.

### 7.4 Stale-while-revalidate

- Edge serves stale up to TTL + 30s while async revalidate.
- Redis serves stale on origin error (circuit-breaker).

### 7.5 Read-replica routing

- All `/v1/discover/*` GET requests route to read-replica with 1s lag tolerance.
- Coach-side mutations route to primary; read-after-write on `GET /v1/coach/discovery/listing` reads primary.

---

## 8. Mobile parity

### 8.1 Same API

Mobile (`growth-project-mobile`) consumes the SAME REST endpoints. No mobile-specific endpoints in v1.

### 8.2 Cookie-equivalent

Mobile uses keychain-stored visitor ID + bearer token. Visitor ID semantics identical to web cookie.

### 8.3 Response sizing

- Card payload optimised for mobile (avatar URL 2x for retina; blurhash for lazy).
- Mobile sends `Accept: application/vnd.tgp.discovery.v1+json` to opt into mobile-tuned shape (avatar variants).

### 8.4 Offline cache

- Coach detail page: ETag-based; mobile can serve stale-on-offline.
- Filter taxonomy: cached forever with version key; updated on app launch.

### 8.5 Push notifications

- Featured-slot expiring soon notification (3 days out).
- Refund-rate threshold approaching warning (80% of threshold).
- Achievement approved notification.
- All push notifications use OneSignal or Firebase per Wave 4 mobile policy.

### 8.6 In-App Purchase

- Featured-slot purchase NOT in mobile in v1 (App Store / Play Store IAP friction). Mobile shows existing slots' status read-only with "Manage on web" deep link.

### 8.7 Mobile-specific events

- `app_open_from_push`, `app_open_from_universal_link` events captured but not surfaced in coach dashboards in v1.

---

## 9. Versioning

### 9.1 URL prefix

`/v1/discover/*`. Major version bump for breaking changes.

### 9.2 Schema versioning

- Card schemas tagged with `schemaVersion: "v1"`.
- Niche taxonomy versioned (`NICHE_TAXONOMY_V1`).
- Filter canonicalisation versioned.

### 9.3 Deprecation

- 6-month deprecation window for any breaking change.
- `Sunset` header on deprecated endpoints.
- Mobile clients pinned to API version; force-update mechanism for security-critical changes.

### 9.4 Compatibility

- Adding fields to response: non-breaking; clients ignore unknown fields.
- Removing fields: breaking; new version.
- Adding optional query params: non-breaking; clients ignore.
- Renaming: breaking; new version.

---

## 10. OpenAPI source

### 10.1 Spec lives at

`docs/discovery/openapi.discovery.v1.yaml` (NOT created in this PR; declared as next-PR artifact).

### 10.2 Generation

- Schemas generated from TypeScript interfaces via `zod-to-openapi`.
- Server validates requests against zod schemas.
- Clients (mobile) generate via `openapi-typescript`.

### 10.3 Examples

- Every endpoint has at least 1 success + 1 error example.
- Examples reviewed by docs team quarterly.

---

## 11. Test plan

### 11.1 Unit

- Cursor encode/decode roundtrip.
- Idempotency-key replay logic.
- Rate-limit token bucket.
- Cache key derivation determinism.

### 11.2 Integration

- All endpoints with mock data; assert response shape.
- Auth scope enforcement (negative tests).
- Read-after-write on coach mutation.

### 11.3 E2E

- Full mobile + web parity test suite running against same API.
- Crawler-UA test path.

### 11.4 Load

- 1k QPS on `GET /v1/discover/coaches`; p95 < 250ms.
- 100 QPS on `POST /v1/discover/events` with batches of 50; p95 < 100ms.

### 11.5 Security

- IDOR on coach console endpoints.
- Cursor forgery.
- Rate-limit bypass via header spoofing.
- SSRF on avatar URL.
- CSRF on coach console mutations (Wave 1 patterns).

### 11.6 Privacy

- GDPR export NDJSON shape.
- Consent gate on `POST /v1/discover/events` for personalisation features.
- PII not in PostHog payload.

---

## 12. Day-1 implementation order

1. Public read endpoints (coaches, apps, slug detail).
2. Filter taxonomy + canonicalisation.
3. Cursor pagination.
4. Event ingestion endpoint.
5. Coach console listing endpoints.
6. Featured-slot endpoints (after billing path ready).
7. Trust-and-safety endpoints (achievements, testimonials, photos).
8. Admin moderation queue endpoints.
9. GDPR export + delete endpoints.
10. OpenAPI spec generation.

---

## 13. Cross-repo

- `growth-project-mobile`: consumes API; pins `v1`.
- `tgp-finance-app`: subscribes to event stream for finance reconciliation; not direct API consumer.

---

## 14. Audit log

Every coach/admin mutation audited (actor, scope, before/after, request_id).

GDPR export and delete operations audited; export delivered via signed URL with expiry.

---

## 15. Senior-engineer onboarding

1. Read Section 1 (endpoint surface).
2. Read Section 3 (error envelope) and Section 5 (idempotency).
3. Read Section 6 (rate limits) and Section 7 (cache).
4. Read Section 8 (mobile parity).
5. Confirm OpenAPI spec generation pipeline before launch.

---

## 16. Performance budget recap

| Endpoint                    | 100 coaches | 1k    | 10k   |
| --------------------------- | ----------- | ----- | ----- |
| `GET /v1/discover/coaches`  | 80ms        | 150ms | 250ms |
| `GET /v1/discover/coaches/:slug` | 60ms   | 100ms | 180ms |
| `POST /v1/discover/events`  | 40ms        | 50ms  | 80ms  |
| `GET /v1/coach/discovery/funnel` | 100ms  | 150ms | 200ms |
| `POST /v1/coach/discovery/featured-slots` | 200ms | 250ms | 300ms |

---

## 17. Detailed request/response shapes

### 17.1 `GET /v1/discover/coaches`

Query parameters:

```
archetype           string[]    optional, max 4
niche               string[]    optional, max 5
priceBand           string[]    optional
outcomeCategory     string[]    optional
modality            string      optional, "online"|"in_person"|"hybrid"
country             string      optional, ISO alpha-2
lat                 number      optional
lng                 number      optional
radius              number      optional, requires lat/lng
unit                string      optional, "mi"|"km"
q                   string      optional, max 80 chars
sort                string      optional, default "recommended"
cursor              string      optional, opaque
limit               number      optional, default 24, max 48
```

Response 200:

```json
{
  "items": [
    {
      "schemaVersion": "v1",
      "coachId": "01J7...",
      "slug": "jane-doe",
      "displayName": "Jane Doe",
      "avatar": { "url": "...", "blurhash": "L5H2EC=PM+yV0g-mq.wG", "width": 400, "height": 400 },
      "headline": "Natural powerlifting coach for masters athletes",
      "archetypeTags": ["strength"],
      "nicheTags": ["powerlifting","masters_athletes"],
      "modality": "online",
      "geo": { "cityLabel": "Austin, TX", "countryCode": "US", "h3CellResolution": 7, "h3Cell": "872830829ffffff" },
      "startingPrice": { "amount": "199.00", "currency": "USD", "cadence": "month", "isStartingFrom": true },
      "verifiedAchievements": [
        { "id": "01J7...", "category": "competition_result", "title": "USAPL National Qualifier 2024", "issuer": "tgp_admin" }
      ],
      "trustBadges": [{ "kind": "verified_identity" }, { "kind": "multi_year_coach" }],
      "team": { "subCoachCount": 2, "surfacedSubCoachIds": ["01J8...","01J9..."] },
      "cta": { "primary": "apply", "secondary": "view_profile" },
      "featuredSlot": null,
      "freshnessSignal": { "profileUpdatedAt": "2026-04-21T13:22:01Z", "lastActiveAt": "2026-04-30T18:00:00Z" },
      "noindex": false
    }
  ],
  "nextCursor": "eyJzY29yZSI6MC44...",
  "rebased": false,
  "snapshotId": "01J7...",
  "experimentBuckets": [
    { "experimentId": "exp_ranking_v1", "bucket": "treatment_a" }
  ]
}
```

`experimentBuckets` is included only for ADMIN debug; never exposed to public surface client.

### 17.2 `GET /v1/discover/coaches/:slug`

Response 200:

```json
{
  "coach": { /* full CoachCardV1 + extended profile fields */ },
  "team": [ /* SubCoachCardV1[] */ ],
  "programs": [ /* ProgramCardV1[] (Wave 6 + Wave 2) */ ],
  "verifiedAchievements": [ /* up to 8 */ ],
  "testimonials": [ /* consent-valid + display-name policy applied */ ],
  "transformationPhotos": [ /* with disclaimer + consent-valid */ ],
  "faq": [ /* coach-authored q&a */ ],
  "noindex": false
}
```

404 if `slug` not found OR `publicListingEnabled = false` (anonymous).

### 17.3 `POST /v1/discover/events`

Request:

```json
{
  "events": [
    {
      "clientEventId": "01J7...",
      "kind": "card_impression",
      "occurredAt": "2026-05-01T13:22:01.123Z",
      "visitorId": "v_01J7...",
      "sessionId": "s_01J7...",
      "coachId": "01J7...",
      "position": 3,
      "filterHash": "abc123...",
      "featuredSlotId": null,
      "source": {
        "referrer": "https://google.com/",
        "utm": { "source": "google", "medium": "organic", "campaign": null, "content": null, "term": null }
      }
    }
  ]
}
```

Response 202 (accepted, processed async):

```json
{ "accepted": 1, "rejected": 0, "requestId": "req_01J7..." }
```

Response 400:

```json
{
  "code": "validation_failed",
  "message": "events[0].kind invalid",
  "details": { "field": "events[0].kind" },
  "requestId": "req_01J7..."
}
```

### 17.4 `POST /v1/coach/discovery/featured-slots`

Request:

```json
{
  "tier": "silver",
  "scopeArchetype": "strength",
  "scopeNicheTags": ["powerlifting","strongman"],
  "weeks": 2,
  "promoCode": "FIRST30"
}
```

Response 200 (returns Stripe Checkout session URL):

```json
{
  "featuredSlotId": "01J7...",
  "tier": "silver",
  "priceAmount": "598.00",
  "priceCurrency": "USD",
  "stripeCheckoutUrl": "https://checkout.stripe.com/c/...",
  "startsAt": "2026-05-02T00:00:00Z",
  "endsAt": "2026-05-16T00:00:00Z"
}
```

Errors:

- 403 `eligibility_failed` with `details.reasons` array.
- 409 `slot_capacity_exceeded` with `details.alternativeTiers` array.
- 422 `validation_failed`.
- 429 `rate_limited`.

### 17.5 `GET /v1/coach/discovery/funnel`

Query:

```
from        ISO date    required
to          ISO date    required, max 365 day window
granularity day|week    default "day"
sourceFilter direct|organic|featured|coach_share|all  default "all"
```

Response 200:

```json
{
  "from": "2026-04-01",
  "to": "2026-04-30",
  "buckets": [
    {
      "date": "2026-04-01",
      "impressions": 3120,
      "clicks": 78,
      "profile_views": 73,
      "cta_clicks": 14,
      "applications": 5,
      "checkouts_initiated": 3,
      "checkouts_completed": 2,
      "refunds": 0,
      "rates": { "ctr": 0.025, "view_to_cta": 0.192, "cta_to_app": 0.357, "app_to_checkout": 0.4 }
    }
  ],
  "totals": { "impressions": 89320, "clicks": 1980, "checkouts_completed": 47, "refunds": 1 }
}
```

### 17.6 `POST /v1/client/testimonials`

Request:

```json
{
  "coachId": "01J7...",
  "text": "Working with Jane has been transformative for my deadlift; I went from 315 to 415 in 12 months under her programming.",
  "displayNamePolicy": "FIRST_ONLY",
  "photoDisplay": "AVATAR_ONLY",
  "consentText": "I consent to public display of this testimonial on Jane Doe's coach profile."
}
```

Response 201:

```json
{ "testimonialId": "01J7...", "reviewState": "PENDING_REVIEW", "consentId": "01J7..." }
```

### 17.7 `GET /v1/me/discovery/export`

Returns NDJSON stream of all `DiscoveryEvent`, `Testimonial`, `TransformationPhoto`, `CookieConsent` rows for the authenticated user. Signed URL with 7-day expiry. Audited.

---

## 18. Webhook surface

Inbound from Stripe:

```
POST /v1/webhooks/stripe/discovery
```

Verifies Stripe signature. Handles events:
- `payment_intent.succeeded` → activate FeaturedSlot
- `payment_intent.payment_failed` → mark FAILED_PAYMENT
- `charge.refunded` → reconcile refund ledger
- `charge.dispute.created` → mark CHARGEBACK_HOLD

Idempotent on `event.id`.

Outbound (Wave 7 emits to internal services):

- `discovery.listing.activated`
- `discovery.listing.suspended`
- `discovery.featured_slot.activated`
- `discovery.featured_slot.suspended`
- `discovery.checkout_completed`
- `discovery.refund_received`
- `discovery.report_submitted`

Consumed by `tgp-finance-app` (revenue reconciliation), `growth-project-mobile` (push notifications), `ops` (alerting).

---

## 19. Security headers

Every response includes:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; img-src 'self' data: https://cdn.tgp.app; ...
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

`/discover/c/:slug` SSR HTML includes `<meta name="robots" content="noindex">` when coach has noindex toggle.

---

## 20. CORS

- Public read endpoints: `Access-Control-Allow-Origin: *` (idempotent + safe).
- Coach/admin endpoints: same-origin only.
- Mobile uses bearer token; not subject to CORS (native).

---

## 21. CSRF

- Coach/admin/client mutating endpoints require CSRF token via `X-CSRF-Token` header (Wave 1 patterns).
- Public event endpoint does NOT require CSRF (anonymous-allowed) but rate-limited.

---

## 22. Observability

Per request:

- `X-Request-Id` header (UUID) generated at edge.
- Distributed tracing via OpenTelemetry; spans for: filter canonicalisation, candidate set query, second-pass scoring, vector search, cache lookup, Redis read.
- Metrics: p50/p95/p99 latency per endpoint; error rate; cache-hit rate; rebase rate.
- Logs: structured JSON; PII-redacted.

---

## 23. SLO / SLI

| Endpoint                                | SLO p95 | SLO error rate |
| --------------------------------------- | ------- | -------------- |
| `GET /v1/discover/coaches`              | 250ms   | < 0.5%         |
| `GET /v1/discover/coaches/:slug`        | 180ms   | < 0.5%         |
| `POST /v1/discover/events`              | 80ms    | < 0.1%         |
| `POST /v1/coach/discovery/featured-slots` | 300ms | < 1%           |
| Stripe webhook handle                   | 200ms   | < 0.1%         |

Burn-rate alerting: 2% error budget over 7-day window triggers page.

---

## 24. Localisation

- Response shapes are language-agnostic except `displayName`, `headline`, `cityLabel`, `caption`.
- These free-text fields are stored in the coach's preferred language; not translated server-side.
- `Accept-Language` honored only for error messages and label localisation (`Sponsored`, etc.).

---

## 25. Mobile-specific request shape variant

When client sends `Accept: application/vnd.tgp.discovery.v1+json; mobile=true`:

- Avatar URL replaced with mobile variant (3-density: @1x, @2x, @3x).
- Blurhash always included.
- `team.surfacedSubCoachIds` capped at 2 (saves bytes).
- `verifiedAchievements` capped at 3 on card.
- ETag header included for caching.

---

End `api-and-mobile.md`.
