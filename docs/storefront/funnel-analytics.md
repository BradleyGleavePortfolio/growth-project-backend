# Funnel Analytics

Wave 9 / Storefront. Status: DRAFT. Docs only.

This file specifies the event taxonomy, ingestion contract, attribution model, performance budgets, sampling rules, retention, and dashboard contracts for storefront funnel analytics. It cross-links to Wave 7's buyer-funnel attribution.

Companion files:
- `block-editor-spec.md` — what triggers events at edit time (RUM, internal).
- `block-types-catalog.md` — Section 24 maps block -> events.
- `publishing-and-versioning.md` — version + variant context that flows through events.

---

## 1. Goals

The funnel analytics surface answers, for each coach:

1. How many people visited my storefront in [date range]?
2. Where did they come from? (Referrer / UTM / Discover-funnel from Wave 7.)
3. Which blocks did they see / interact with?
4. Where in the funnel did they drop off?
5. How many visitors converted to applications? To checkouts?
6. How does cohort A compare to cohort B (page-level A/B)?

Hard rule: NO PII to PostHog. Visitor identity is a salted ULID cookie; visitor email captured by an Application form goes into the Application row server-side, NEVER into the analytics ledger as PII.

---

## 2. Event taxonomy

```ts
type StorefrontEvent =
  | PageView
  | BlockImpression
  | BlockClick
  | CtaClick
  | PricingCadenceToggle
  | FaqExpand
  | EmbedPlay
  | ScheduleSlotClick
  | ApplicationStart
  | ApplicationSubmit
  | CheckoutStart
  | CheckoutComplete
  | CustomBlockEvent;

interface BaseEvent {
  /** ULID generated client-side (or server-side for server-emitted events). */
  eventId: string;
  /** ISO-8601 timestamp. */
  occurredAt: string;
  /** Salted ULID — the visitor's identity. */
  visitorId: string;
  /** Session id — rotates per 30-min idle. */
  sessionId: string;
  /** The page being viewed. */
  pageId: string;
  /** The coach owning the page. */
  coachId: string;
  /** The published version being viewed. */
  versionId: string;
  /** Variant for A/B (a or b); null if no A/B running. */
  variant: "a" | "b" | null;
  /** Attribution token (set by Wave 7 Discover, propagated). */
  attributionToken: string | null;
  /** Page locale at render time. */
  locale: string;
  /** Coarse geo (country code only). */
  country: string;
  /** Device class. */
  device: "mobile" | "tablet" | "desktop";
  /** Referrer host (no path), or null. */
  referrer: string | null;
}

interface PageView extends BaseEvent { kind: "page.view" }

interface BlockImpression extends BaseEvent {
  kind: "block.impression";
  blockId: string;
  blockType: string;
  /** Position in tree — useful for above-the-fold analysis. */
  positionIndex: number;
  /** Time visible before scrolled out, ms. */
  visibleMs: number;
}

interface BlockClick extends BaseEvent {
  kind: "block.click";
  blockId: string;
  blockType: string;
  /** Sub-action — e.g. "card.click" for Programs-Grid. */
  actionId: string;
}

interface CtaClick extends BaseEvent {
  kind: "cta.click";
  blockId: string;
  /** href that was clicked. */
  href: string;
  /** Label that was clicked. */
  label: string;
  /** Where on page — block-relative anchor. */
  position: "above-fold" | "below-fold";
}

interface PricingCadenceToggle extends BaseEvent {
  kind: "pricing.cadence_toggle";
  blockId: string;
  cadence: "monthly" | "annual";
}

interface FaqExpand extends BaseEvent {
  kind: "faq.expand";
  blockId: string;
  itemId: string;
}

interface EmbedPlay extends BaseEvent {
  kind: "embed.play";
  blockId: string;
  provider: string;
}

interface ScheduleSlotClick extends BaseEvent {
  kind: "schedule.slot_click";
  blockId: string;
  cohortId: string;
}

interface ApplicationStart extends BaseEvent {
  kind: "application.start";
  /** Tier id if started from a Pricing-Table. */
  tierId?: string;
}

interface ApplicationSubmit extends BaseEvent {
  kind: "application.submit";
  applicationId: string;
  /** Server-emitted; visitorId is the Application's own. */
}

interface CheckoutStart extends BaseEvent {
  kind: "checkout.start";
  /** Stripe Checkout session id. */
  stripeSessionId: string;
  tierId: string;
  amount: string;        // Decimal(14,2)
  currency: string;
}

interface CheckoutComplete extends BaseEvent {
  kind: "checkout.complete";
  stripeSessionId: string;
  tierId: string;
  amount: string;
  currency: string;
  /** Where in funnel — derived from attributionToken. */
  funnel: {
    discoverSessionId?: string;
    pageVisitSessionId: string;
  };
}

interface CustomBlockEvent extends BaseEvent {
  kind: "custom_block.event";
  blockId: string;
  manifestId: string;
  /** Per-manifest schema — see integration-with-apps.md Section 5. */
  payload: Record<string, unknown>;
}
```

### 2.1 Event taxonomy table

| Kind                     | Triggered by                                | PII? |
|--------------------------|---------------------------------------------|:----:|
| `page.view`              | Public page render in browser               | no   |
| `block.impression`       | IntersectionObserver crossed 50% visible    | no   |
| `block.click`            | Block-internal click that's not a CTA       | no   |
| `cta.click`              | Click on a CTA / Buy / Apply                | no   |
| `pricing.cadence_toggle` | Pricing-Table cadence switch                | no   |
| `faq.expand`             | FAQ item expanded                           | no   |
| `embed.play`             | Video play (YouTube / Vimeo postMessage)    | no   |
| `schedule.slot_click`    | Schedule-Widget slot clicked                | no   |
| `application.start`      | Application form opened                     | no   |
| `application.submit`     | Application form submitted                  | no   |
| `checkout.start`         | Stripe Checkout session created             | no   |
| `checkout.complete`      | Stripe webhook `checkout.session.completed` | no   |
| `custom_block.event`     | App-emitted via postMessage                 | per-manifest |

PII column means: does the event payload contain any field that maps to a real human's identity? Always must be `no`. Application id and stripeSessionId are platform-internal; the joining of Application -> visitor email happens only inside the platform DB, never in PostHog.

---

## 3. Where events come from

### 3.1 Client-side (browser)

```
page.view, block.impression, block.click, cta.click,
pricing.cadence_toggle, faq.expand, embed.play, schedule.slot_click,
application.start
```

Emitted by `storefront-runtime.js` after page load. Buffered in memory; flushed every 5s or on `pagehide`/`beforeunload` via `navigator.sendBeacon`.

### 3.2 Server-side

```
application.submit, checkout.start, checkout.complete
```

Emitted by API handlers and Stripe webhook handlers. These carry sensitive context that MUST NOT touch the browser (e.g. Stripe session id).

### 3.3 App-side (custom blocks)

```
custom_block.event
```

Emitted by app iframes via postMessage to the host; host validates and proxies to the ingestion endpoint with the visitor context attached.

---

## 4. Ingestion contract

```
POST /api/storefront/events/ingest
Body: { events: StorefrontEvent[] }   // up to 100 per batch
Headers:
  Idempotency-Key: <ULID per batch>
Response 200: { accepted: number; rejected: { eventId, reason }[] }
```

Rules:

- Max 100 events per batch; >100 returns 413.
- Each event MUST validate against the per-kind schema; invalid events are rejected per-event (not the whole batch).
- Rate limit: 60 batches per minute per visitor. Above limit, drop with 429 (silent drop on client).
- The endpoint is unauthenticated (anyone can hit it) but rate-limited per visitorId+IP. The visitorId is in the cookie; an attacker without a cookie gets a fresh one and is rate-limited per IP only.
- Server validates that `visitorId, sessionId, pageId, coachId, versionId` form a coherent set (e.g. version exists, page exists, coach matches). Mismatched rejects the event.
- All events are persisted to `BlockEvent` table (see Section 5) AND mirrored to PostHog.
- Server enriches each event with `serverReceivedAt, serverIp(hash), userAgent(coarse)`.

---

## 5. Schema (`BlockEvent`)

```prisma
model BlockEvent {
  id                  String   @id @default(cuid())
  eventId             String   @unique  // ULID from client
  kind                String
  occurredAt          DateTime
  serverReceivedAt    DateTime @default(now())
  visitorId           String
  sessionId           String
  pageId              String
  coachId             String
  versionId           String
  variant             String?  // "a" | "b" | null
  attributionToken    String?
  locale              String
  country             String
  device              String
  referrer            String?
  blockId             String?
  blockType           String?
  /** Per-kind structured payload. */
  payload             Json
  /** For dedup. */
  idempotencyBatchKey String?

  @@index([coachId, occurredAt])
  @@index([pageId, occurredAt])
  @@index([visitorId, sessionId])
  @@index([attributionToken])
  @@index([versionId, kind])
}
```

GDPR cascade: deleting a coach cascades; deleting a `StorefrontPage` cascades. Visitor right-to-erase: a visitor can request "delete events for visitorId X" via support; the row-level delete is fast (indexed).

Retention: 18 months (Section 8). Older events are archived to cold storage (S3 + Glacier) for compliance, then hard-deleted after 24 months.

Storage: at 10k coach scale, expect ~100M events / month. Each event ~500 bytes -> ~50GB / month -> ~900GB / 18 months. Use Postgres partitioning by month; cold partitions move to TimescaleDB or BigQuery (TBD by data platform).

---

## 6. Per-block CTR

The flagship metric for coaches: "of people who saw block X, how many clicked it?"

```sql
WITH impressions AS (
  SELECT blockId, COUNT(DISTINCT (visitorId, sessionId)) AS imp_n
  FROM "BlockEvent"
  WHERE kind = 'block.impression'
    AND occurredAt BETWEEN $start AND $end
    AND coachId = $coachId
  GROUP BY blockId
),
clicks AS (
  SELECT blockId, COUNT(DISTINCT (visitorId, sessionId)) AS clk_n
  FROM "BlockEvent"
  WHERE kind IN ('block.click', 'cta.click')
    AND occurredAt BETWEEN $start AND $end
    AND coachId = $coachId
  GROUP BY blockId
)
SELECT i.blockId,
       i.imp_n,
       COALESCE(c.clk_n, 0) AS clk_n,
       CASE WHEN i.imp_n = 0 THEN 0
            ELSE ROUND(100.0 * c.clk_n / i.imp_n, 2)
       END AS ctr_pct
FROM impressions i
LEFT JOIN clicks c ON c.blockId = i.blockId
ORDER BY i.imp_n DESC;
```

This query runs against a read replica with a per-coach index; p95 < 200ms at 10k scale.

The dashboard caches per-coach CTR for 5 minutes (capability-hash cache key per Wave 3).

### 6.1 CTR contract (TypeScript)

```ts
interface BlockCtr {
  blockId: string;
  blockType: string;
  impressions: number;
  clicks: number;
  ctrPct: number;        // 0..100, 2 decimals
}

interface PageBlockCtrReport {
  pageId: string;
  versionId: string;
  range: { start: string; end: string };
  blocks: BlockCtr[];
  totalImpressions: number;
  totalClicks: number;
  /** Compare to previous equal-length period. */
  delta: {
    impressionsPctChange: number;
    clicksPctChange: number;
  };
}
```

API:

```
GET /api/storefront/analytics/block-ctr?pageId=...&start=...&end=...
Response: PageBlockCtrReport
```

---

## 7. Conversion attribution

The chain we track:

```
[Discover Wave 7]                              [Wave 9 storefront]
discover.session.start  -> attribution_token   -> page.view (token attached)
                                                 -> cta.click (Apply)
                                                 -> application.start
                                                 -> application.submit
                                                 -> (if pricing-table buy)
                                                    checkout.start
                                                    checkout.complete
```

`attribution_token` is generated by Wave 7's Discover funnel. When a visitor lands on `/c/<slug>?ref=<discoverSessionId>`, the storefront extracts and persists the token in the `tgp_attribution` cookie (90-day TTL). All subsequent storefront events carry it; downstream Application and Checkout events propagate it.

The server-side ledger:

```prisma
model FunnelAttribution {
  id                  String   @id @default(cuid())
  attributionToken    String   @unique
  visitorId           String
  /** Earliest event in the funnel. */
  firstSeenAt         DateTime
  /** Most recent event. */
  lastSeenAt          DateTime
  /** Funnel state machine — see Section 7.1. */
  state               String
  /** Result references. */
  applicationId       String?
  stripeCheckoutId    String?
  /** Conversion timing. */
  appliedAt           DateTime?
  paidAt              DateTime?
  /** Total events in funnel. */
  eventCount          Int      @default(0)

  @@index([visitorId])
  @@index([state, lastSeenAt])
}
```

### 7.1 Funnel states

```
ARRIVED    — page.view fired
ENGAGED    — at least one block.impression OR cta.click after page.view
APPLYING   — application.start fired
APPLIED    — application.submit fired
PURCHASING — checkout.start fired
PAID       — checkout.complete fired
ABANDONED  — no event in 30 minutes since last (rolling)
LAPSED     — no event in 24h
EXPIRED    — token TTL passed (90 days)
```

State transitions: forward only (well, not strictly — `APPLYING` -> `APPLIED` -> `PURCHASING` -> `PAID` is the happy path, but `APPLYING` -> `LAPSED` -> `APPLIED` is possible if the user comes back the next day). The state row is upserted by the event ingestion handler.

### 7.2 Conversion query

```sql
SELECT
  COUNT(*) FILTER (WHERE state = 'PAID') AS paid,
  COUNT(*) FILTER (WHERE state IN ('APPLIED', 'PURCHASING', 'PAID')) AS applied,
  COUNT(*) FILTER (WHERE state IN ('ENGAGED', 'APPLYING', 'APPLIED', 'PURCHASING', 'PAID')) AS engaged,
  COUNT(*) AS arrived
FROM "FunnelAttribution"
WHERE firstSeenAt BETWEEN $start AND $end
  AND visitorId IN (
    SELECT DISTINCT visitorId FROM "BlockEvent"
    WHERE coachId = $coachId AND occurredAt BETWEEN $start AND $end
  );
```

Conversion rates: `paid / arrived`, `applied / engaged`, etc.

---

## 8. Performance budgets

| Metric                                                 | Budget                |
|--------------------------------------------------------|-----------------------|
| Event ingestion p95                                    | <= 50ms (Wave 7 same) |
| Event ingestion p99                                    | <= 200ms              |
| Dashboard "block CTR" query p95                        | <= 2s at 10k coach scale |
| Dashboard "funnel conversion" query p95                | <= 2s                 |
| Real-time event lag (ingestion -> dashboard visible)   | <= 30s                |
| PostHog mirror lag                                     | <= 5min               |
| Storage retention                                      | 18 months hot, 6 months archive |

Sampling: NONE in v1. Every event is persisted and mirrored. Reasoning: at 10k coach scale (~100M events/month), Postgres handles this. Sampling adds variance to coach-level numbers; coaches with few visits would see noisy data. We may add tail-sampling at 100k coach scale (out of scope for Wave 9).

---

## 9. Capacity

At 10k coaches and 100k storefront visits/day average:

```
page.view       100k events/day
block.impression  ~600k events/day (6 blocks/page * 100k)
block.click       ~30k events/day (5% CTR)
cta.click         ~10k events/day
application.start  ~3k events/day
application.submit ~1.5k events/day
checkout.start     ~500 events/day
checkout.complete  ~250 events/day
faq.expand         ~3k events/day
embed.play         ~5k events/day
schedule.slot_click ~2k events/day

total           ~750k events/day
                ~20M events/month
                ~360M events/18mo
size estimate   ~180GB (500B/event)
```

This sits in a single Postgres cluster comfortably with monthly partitioning. PostHog mirror does its own sharding.

---

## 10. PostHog mirror

The `postHog-mirror` worker subscribes to the event stream, transforms each event into a PostHog `capture()` payload, and ships.

Strict rules:
- NO PII fields. The transformer DROPS `applicationId, stripeSessionId, attributionToken`.
- Transformations are append-only — adding fields is fine, removing requires a backfill plan.
- Sample rate: 100% mirror; PostHog can sample on its end if cost dictates.

PostHog distinct_id = visitorId (the salted ULID; PostHog never sees the cookie value).

PostHog event names mirror our `kind` field 1:1: `page.view`, `block.impression`, etc.

---

## 11. Cohort comparisons

Coaches can define cohorts:

- "Visitors from Discover" (filter on `attribution_token` prefix `disc_`).
- "Visitors from Twitter" (filter on `referrer = 'twitter.com'`).
- "Mobile visitors" (filter on `device = 'mobile'`).
- A/B variant cohorts (filter on `variant = 'a'` or `'b'`).

Dashboard renders side-by-side conversion rates for any 2 cohorts.

Cohort definition shape (TypeScript):

```ts
interface Cohort {
  id: string;
  coachId: string;
  name: string;
  filter: {
    attributionTokenPrefix?: string;
    referrer?: string[];
    device?: ("mobile" | "tablet" | "desktop")[];
    country?: string[];
    variant?: ("a" | "b")[];
    locale?: string[];
  };
  createdAt: string;
}
```

Stored in `Cohort` table; queries are computed on-the-fly (no pre-materialised cohort assignment). At 10k coach scale, an indexed query on `(coachId, attributionToken/device/...)` runs in <1s.

---

## 12. Real-time vs batch

The dashboard has two modes:

- **Real-time** (last 60 minutes). Reads from a hot in-memory cache (Redis), updated by the ingestion handler. Lag <= 30s.
- **Batch** (any range > 1 hour). Reads from Postgres with 5-min query cache (capability-hash key per Wave 3).

Switching between is transparent in the UI; the picker shows "Live" for the 60-min view.

---

## 13. Failure modes

### F-Funnel-1: Ingestion endpoint down

- Detection: Health check / 5xx rate.
- Recovery: Client buffers events in localStorage (cap 100). Retries on next page-view. After 100 events buffered, oldest are dropped; emit a `client.buffer.overflow` warning to Sentry.
- Acceptable data loss: minimal — clients sustain >5 minutes downtime without loss.

### F-Funnel-2: PostHog mirror lag

- Detection: Mirror queue depth alarm.
- Recovery: Postgres remains the source of truth for dashboards. Mirror catches up; no data lost.

### F-Funnel-3: Tampered visitorId

- Detection: visitorId not a valid ULID, or rate-limit violation per IP.
- Recovery: Reject the event, count toward IP rate limit. Visitor gets a fresh cookie on next page load.

### F-Funnel-4: Bot / crawler traffic

- Detection: User-Agent matches known-bot list (Googlebot, Bingbot, etc.).
- Recovery: Bot events persist with `device: "bot"` and are excluded from default dashboards. A toggle exposes them.

### F-Funnel-5: Replay attack on checkout.complete

- Detection: Stripe webhook idempotency guarantees one delivery; we additionally check that `stripeSessionId` not already present.
- Recovery: Duplicate events dropped. The Stripe webhook handler is the only emitter of `checkout.complete`.

### F-Funnel-6: Time-travel events (clock skew)

- Detection: `occurredAt > serverReceivedAt + 1 hour` or `< serverReceivedAt - 24 hours`.
- Recovery: Event accepted, but `occurredAt` clamped to `serverReceivedAt`; flag set so analysts can spot the anomaly.

### F-Funnel-7: Schema drift between client and server

- Detection: Validation rejects.
- Recovery: Client falls back to omitting unrecognised fields; server logs warning. Editor's `REGISTRY_HASH` mechanism (block-editor-spec Section 18.15) prevents most cases.

---

## 14. Sampling and rate limiting

Per visitor, per minute:
- 10 `page.view` (rare to legitimately exceed; most visitors view <5 pages/min)
- 30 `block.impression`
- 30 `block.click + cta.click + faq.expand + ...`
- 60 batches of any size up to 100 events

Above limits: drop silently on client (no error UI), emit `client.rate_limit` to Sentry.

Server-side rate limit per IP per minute: 1000 events. Above this, return 429.

---

## 15. Privacy and consent

- Storefront pages do not require consent banners in the EU/UK because we do not set non-essential cookies. The visitor id cookie is essential for the platform's functioning (load balancing, fraud prevention) — analytics derived from it is first-party and aggregate.
- Hard rule: no third-party tracking pixels. No Facebook Pixel, no Google Analytics, no Hotjar, no Segment. PostHog is our self-hosted analytics; mirror payload contains no PII.
- Visitor right-to-erase: support@ flow allows a visitor to request "delete events for cookie X". Row-level delete by `visitorId`. Audit log preserves the count of deleted rows for SAR responses.

---

## 16. Dashboards

### 16.1 Coach-facing dashboard

Lives at `/coach/storefront/analytics`. Tabs:

- **Overview.** Visitors / day, applications / day, conversion %, revenue (Decimal(14,2) per Wave 5).
- **Funnel.** Page-view -> CTA click -> Application -> Checkout chart with drop-off counts at each step.
- **Blocks.** Per-block CTR (Section 6).
- **Cohorts.** A/B comparison; custom cohort builder.
- **Visitors.** No PII; aggregate stats by country / device / referrer.

Queries:

```
GET /api/storefront/analytics/overview?range=...
GET /api/storefront/analytics/funnel?range=...
GET /api/storefront/analytics/blocks?range=...
GET /api/storefront/analytics/cohorts?cohortId=...&range=...
```

All return per-coach scoped data; SUB_COACH access is restricted to their assigned program/cohort scope (per `EditScope`).

### 16.2 Admin-facing dashboard

`/admin/storefront/health` — internal SRE view (block-editor-spec Section 18.12).

`/admin/storefront/analytics?coachId=...` — admin can drill into any coach's funnel for support cases. Read-only; logs access in `audit.read.coach_analytics`.

---

## 17. Privacy and audit log entries

```
analytics.event.ingest             { batchSize, accepted, rejected }
analytics.event.rate_limited       { visitorId(hashed), ipPrefix }
analytics.dashboard.read           { coachId, viewerUserId, range }
analytics.dashboard.read_admin     { coachId, viewerUserId, range }
analytics.visitor.erase_request    { visitorId(hashed), rowsDeleted }
analytics.cohort.created           { coachId, cohortId, byUserId }
funnel.attribution.token_minted    { token, byCoachId }
funnel.attribution.lapsed          { token, lastSeenAt }
funnel.attribution.expired         { token, firstSeenAt, lastSeenAt }
```

`visitorId(hashed)` means we hash the value before logging — even the audit log doesn't carry raw cookie values.

---

## 18. Test plan

- Unit: every event-kind validator with positive/negative cases.
- Integration: emit a batch -> persist in BlockEvent -> appears in dashboard query.
- e2e: Playwright simulates a full funnel — page view, block clicks, application submit, checkout complete; verify FunnelAttribution row reaches PAID.
- Load: 1000 events/s sustained, p95 ingestion <= 50ms, no row loss.
- Privacy: assert no PII fields reach the mirror; mirror payload golden file diffed against current.

---

## 19. Senior-engineer onboarding checklist

- [ ] Read this file end-to-end.
- [ ] Read Wave 7 buyer-funnel attribution spec.
- [ ] Run `pnpm analytics:emit-fixture` to push test events into the dev cluster.
- [ ] Inspect a real `BlockEvent` and `FunnelAttribution` row.
- [ ] Read the PostHog mirror config; confirm no PII transforms.

---

## 21. Detailed event payload examples

For implementation reference. All examples valid in v1.

### 21.1 page.view

```json
{
  "kind": "page.view",
  "eventId": "01HXEVENT_PV1",
  "occurredAt": "2026-05-01T12:00:00.123Z",
  "visitorId": "01HXVISITOR_AB",
  "sessionId": "01HXSESS_001",
  "pageId": "01HXPAGE_BG",
  "coachId": "01HXCOACH_BG",
  "versionId": "01HXVER_17",
  "variant": "a",
  "attributionToken": "disc_3f9b2a",
  "locale": "en-US",
  "country": "US",
  "device": "desktop",
  "referrer": "google.com"
}
```

### 21.2 block.impression

```json
{
  "kind": "block.impression",
  "eventId": "01HXEVENT_IMP1",
  "occurredAt": "2026-05-01T12:00:01.500Z",
  "visitorId": "01HXVISITOR_AB",
  "sessionId": "01HXSESS_001",
  "pageId": "01HXPAGE_BG",
  "coachId": "01HXCOACH_BG",
  "versionId": "01HXVER_17",
  "variant": "a",
  "attributionToken": "disc_3f9b2a",
  "locale": "en-US",
  "country": "US",
  "device": "desktop",
  "referrer": "google.com",
  "blockId": "01HXBLOCK1",
  "blockType": "hero",
  "positionIndex": 0,
  "visibleMs": 1450
}
```

### 21.3 cta.click

```json
{
  "kind": "cta.click",
  "eventId": "01HXEVENT_CTA1",
  "occurredAt": "2026-05-01T12:00:08.732Z",
  "visitorId": "01HXVISITOR_AB",
  "sessionId": "01HXSESS_001",
  "pageId": "01HXPAGE_BG",
  "coachId": "01HXCOACH_BG",
  "versionId": "01HXVER_17",
  "variant": "a",
  "attributionToken": "disc_3f9b2a",
  "locale": "en-US",
  "country": "US",
  "device": "desktop",
  "referrer": "google.com",
  "blockId": "01HXBLOCK1",
  "href": "#apply",
  "label": "Apply now",
  "position": "above-fold"
}
```

### 21.4 checkout.complete (server-emitted)

```json
{
  "kind": "checkout.complete",
  "eventId": "01HXEVENT_CHK1",
  "occurredAt": "2026-05-01T12:05:42.000Z",
  "visitorId": "01HXVISITOR_AB",
  "sessionId": "01HXSESS_001",
  "pageId": "01HXPAGE_BG",
  "coachId": "01HXCOACH_BG",
  "versionId": "01HXVER_17",
  "variant": "a",
  "attributionToken": "disc_3f9b2a",
  "locale": "en-US",
  "country": "US",
  "device": "desktop",
  "referrer": "google.com",
  "stripeSessionId": "cs_test_a1b2c3",
  "tierId": "01HXTIER_S",
  "amount": "97.00",
  "currency": "USD",
  "funnel": {
    "discoverSessionId": "01HXDISC_001",
    "pageVisitSessionId": "01HXSESS_001"
  }
}
```

---

## 22. Funnel chart contract (TypeScript)

The "funnel" tab in the coach dashboard is rendered from this contract:

```ts
interface FunnelStep {
  /** A canonical step name. */
  name: "arrived" | "engaged" | "applied" | "purchasing" | "paid";
  /** Display label. */
  label: string;
  /** Number of visitors who reached this step. */
  count: number;
  /** Conversion from previous step. */
  pctFromPrev: number;
  /** Conversion from arrived. */
  pctFromArrived: number;
  /** Median time from previous step, ms. */
  medianMsFromPrev: number;
}

interface FunnelChart {
  pageId: string;
  range: { start: string; end: string };
  /** Optional cohort filter. */
  cohortId: string | null;
  steps: FunnelStep[];
  /** Total revenue at the bottom of the funnel. */
  revenue: { amount: string; currency: string };
}
```

Rendering: a horizontal bar chart per step, with the count and pctFromArrived; a "drop-off" gap visualises where visitors are lost.

API:

```
GET /api/storefront/analytics/funnel?pageId=...&start=...&end=...&cohortId=...
Response: FunnelChart
```

---

## 23. Per-block funnel chart contract (TypeScript)

Beyond the overall funnel, coaches can ask "for this specific block, what's the conversion?":

```ts
interface BlockFunnel {
  blockId: string;
  blockType: string;
  range: { start: string; end: string };
  /** People who saw the block. */
  impressions: number;
  /** People who clicked it. */
  clicks: number;
  /** Of clicks, how many started an application. */
  applicationStarts: number;
  /** Of those, how many submitted. */
  applicationSubmits: number;
  /** Of those, how many checked out. */
  checkoutStarts: number;
  /** Of those, how many paid. */
  checkoutCompletes: number;
}
```

API:

```
GET /api/storefront/analytics/block-funnel?blockId=...&start=...&end=...
Response: BlockFunnel
```

This is what powers the editor's per-block tooltip (block-editor-spec Section 18.42).

---

## 24. Anti-fraud heuristics

Spurious traffic is removed from coach-facing dashboards (but kept in raw `BlockEvent` for forensics):

- User-Agent matches known bot list -> exclude.
- visitorId arrives from > 50 unique IPs in 24h -> flag (cookie likely shared / synthetic).
- Click bursts: > 10 cta.click on the same href in 60s from one visitor -> include first, suppress rest.
- Headless browser detection (Puppeteer / Playwright fingerprint heuristics) -> mark `device: "synthetic"`, exclude.

These exclusions affect dashboard counts only; the underlying rows persist for support investigations.

---

## 25. Funnel state machine — exhaustive

```
events                    --> state transition
page.view (first)         --> ARRIVED
block.impression          --> ARRIVED -> ENGAGED (if not already past ENGAGED)
cta.click                 --> ARRIVED -> ENGAGED
application.start         --> any -> APPLYING
application.submit        --> any -> APPLIED
checkout.start            --> any -> PURCHASING
checkout.complete         --> any -> PAID
30 min idle               --> ENGAGED/APPLYING/PURCHASING -> ABANDONED
24h idle                  --> ABANDONED -> LAPSED
90d age                   --> any -> EXPIRED (token reset)
```

State only advances forward; exception: `LAPSED` -> `APPLYING` is allowed (visitor came back the next day and applied). `EXPIRED` is terminal.

The state machine is computed by the ingestion handler; a row in `FunnelAttribution` is upserted per event.

---

## 26. SLA and SLOs

| Surface                      | SLI                          | SLO target          | Burn alert       |
|------------------------------|------------------------------|---------------------|------------------|
| Event ingestion              | p95 <= 50ms                  | 99.9% / 28d         | 7d burn          |
| Event ingestion success      | 200 / total                  | 99.95% / 28d        | 7d burn          |
| Dashboard load               | p95 <= 2s                    | 99.5% / 28d         | 14d burn         |
| Real-time freshness          | event-to-dashboard <= 30s    | 99% / 28d           | 14d burn         |

Storefront on-call rotation is shared with the editor surface.

---

## 27. Known caveats

- Visitor id rotation: if a visitor clears cookies, they look like a new visitor. Their attribution chain is lost. This is acceptable; it's an industry-standard limitation.
- Cross-device attribution: a visitor who lands on Discover from desktop and converts on mobile breaks the attribution token (different cookie). v2 may add a magic-link-based device-bridging flow. v1 accepts the gap.
- Ad-blockers: aggressive adblockers may block PostHog's pixel. Our ingestion endpoint lives at `/api/storefront/events/ingest` (first-party path) so adblockers rarely block it; the mirror to PostHog is server-side, post-ingest, so client-side adblockers don't affect the source-of-truth Postgres data.
- Web Vitals: not part of this taxonomy; tracked separately in the platform RUM (Wave 1).

---

## 28. Migration / backfill

Wave 9 is net-new. No backfill of old analytics. The day Wave 9 ships, `BlockEvent` starts collecting from zero. Coaches see "0 events" for the first 24 hours; the dashboard shows a "Just shipped — your data starts collecting now" banner.

Future migrations: schema-additive only. Removing a field in `BlockEvent` requires a rewrite plan with row-level migration.

---

## 29. Rollback

If funnel analytics is broken at launch:

- Flag `storefront.analytics.enabled = false` -> `storefront-runtime.js` skips emitting; dashboard shows "Analytics temporarily unavailable".
- Public render is unaffected.
- Coach-side conversion still works; it just isn't measured.

If the schema is wrong post-launch and we have to drop the table:

- BlockEvent partitions are monthly; drop the affected partition.
- FunnelAttribution rebuild from BlockEvent (slow; backlog job).

---

## 30. Cross-link to Wave 7

Wave 7 owns:

- `attribution_token` minting at Discover-funnel entry.
- Discover-funnel events (`discover.session.start`, `discover.click_coach_card`, etc.).
- Cross-page join from Discover to coach storefront.

Wave 9 owns:

- All events that fire ON the coach storefront page.
- The conversion side: application.* and checkout.* events.

Both Waves write to the same `BlockEvent` table for storefront-page events; Wave 7 events live in a separate `DiscoverEvent` table. The `attributionToken` is the join key.

The implementing PRs must coordinate: Wave 7's `attribution_token` shape is ULID prefix `disc_`; Wave 9 expects this prefix when carrying the token in storefront events. A token without the `disc_` prefix is treated as "direct" (no Discover origin).

---

## 20. Open questions

None unresolved beyond OWNER decisions in README.

End of funnel-analytics.

