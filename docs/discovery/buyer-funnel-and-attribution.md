# Buyer Funnel & Attribution

Status: DRAFT spec. Docs only. Schema deltas illustrative.

This file owns the discovery-to-conversion buyer funnel: event ledger, attribution model (OWNER_DECISION 2), UTM handling, cookie-consent integration, coach-facing dashboards, conversion rate baselines.

## Table of contents

1. Funnel definition
2. Event ledger (`DiscoveryEvent`)
3. Attribution model (OWNER_DECISION 2)
4. UTM parameter handling
5. Cookie consent integration
6. Server-side ingestion contract
7. Coach-facing dashboards
8. Conversion rate baseline targets
9. PII boundary + PostHog rules
10. State + retention
11. Failure modes
12. Test plan
13. Schema deltas
14. Day-1 implementation order

---

## 1. Funnel definition

The canonical funnel:

```
1. landing_view          (visit /discover or /discover/coaches)
2. card_impression       (card rendered above fold OR scrolled into view)
3. card_click            (click coach card or app card)
4. profile_view          (land on /discover/c/{slug})
5. cta_click             (click apply / checkout / book / waitlist)
6. application_submit    (apply form submitted; or checkout intent)
7. checkout_initiated    (Stripe Checkout session created)
8. checkout_completed    (payment_intent.succeeded)
9. refund                (post-conversion negative event)
```

Step 2 (`card_impression`) requires the card to be at least 50% in viewport for >= 200ms. Anti-fraud: scroll-spam bots throttled.

Steps 1-5 are anonymous-allowed (with consent for analytics). Steps 6-8 require auth (or guest checkout per Wave 5).

Step 9 (`refund`) is reconciled from Stripe webhook; tied back to original conversion via `attributionId`.

---

## 2. Event ledger (`DiscoveryEvent`)

Append-only. One row per event.

```ts
interface DiscoveryEventV1 {
  id: string;                       // ULID
  schemaVersion: "v1";
  kind: DiscoveryEventKind;
  occurredAt: string;               // ISO8601, server-stamped
  visitorId: string;                // 30d cookie (anon) OR auth user ID
  authUserId: string | null;        // populated when authenticated
  sessionId: string;                // 30min idle session
  coachId: string | null;           // for coach-scoped events
  appId: string | null;             // for app-scoped events
  programId: string | null;         // for program-scoped events
  featuredSlotId: string | null;    // populated for featured impressions/clicks
  position: number | null;          // 1-indexed slot position
  filterHash: string | null;        // for impression/click events
  capabilityHash: string;           // wave-3 capability hash
  scope: "public" | "auth";
  source: {
    referrer: string | null;        // truncated to origin + path
    utm: {
      source: string | null;
      medium: string | null;
      campaign: string | null;
      content: string | null;
      term: string | null;
    };
    ip_country: string | null;      // coarse only
    user_agent_class: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  };
  attributionId: string | null;     // links downstream events to upstream
  metadata: Record<string, unknown>; // event-specific
}

type DiscoveryEventKind =
  | "landing_view"
  | "card_impression"
  | "card_click"
  | "profile_view"
  | "cta_click"
  | "application_submit"
  | "checkout_initiated"
  | "checkout_completed"
  | "refund";
```

### 2.1 Idempotency

- Client-generated `clientEventId` (ULID) on every event.
- Server dedupes on `(visitorId, clientEventId)` for 24h.
- Retries safe.

### 2.2 Volume estimate

At 10k coaches, 100k DAU, 30 cards / page, 2 page views / session:

- card_impression: ~6M / day.
- card_click: ~120k / day (2% CTR).
- conversion events: ~1k / day.

Storage: 365-day hot retention; cold archive thereafter (S3 + Athena), 7-year total.

### 2.3 Bot filtering

- IP velocity > 10 events / second per IP → throttled at edge.
- UA classifier: known bots tagged `user_agent_class = "bot"`; counted separately, NOT in coach dashboards.
- Behavioural fingerprint flag for sophisticated bot suspicion; flagged events excluded from priors but stored.

---

## 3. Attribution model

OWNER_DECISION 2: 30-day last-touch (recommended) for v1, multi-touch position-based as v2 dashboard toggle.

### 3.1 Last-touch (v1)

A conversion is attributed to the most recent `card_click` or `profile_view` within the 30-day window, with the click given priority.

```
attribution_chain(conversionEventId, windowDays=30) {
  events = DiscoveryEvent.where(
    visitorId = conversionEvent.visitorId,
    occurredAt in [conversion - 30d, conversion],
    kind in ['card_click', 'profile_view'],
    coachId = conversion.coachId    // attributed coach must match
  ).orderByDesc(occurredAt);
  return events[0]?.attributionId ?? null;
}
```

### 3.2 First-touch (alternative)

Same query but `events[events.length - 1]` (oldest in window). Available as dashboard toggle.

### 3.3 Multi-touch position-based (40/20/40) — v2

Distribute credit:
- 40% to first touch.
- 20% distributed evenly across middle touches.
- 40% to last touch.

Computed offline nightly, stored in `AttributionAssignment` table. Coach dashboard toggle reveals.

### 3.4 Attribution boundaries

- Cross-device: tied to `authUserId` once authenticated; before auth, cookie-only.
- Cross-coach: a click on Coach A then conversion on Coach B does NOT attribute to Coach A. Attribution is coach-scoped.
- Featured-slot click: attributed normally; revenue still goes to coach for the program purchase. Featured-slot fee is separate (Section 4 of `featured-placements-and-monetization.md`).

### 3.5 Attribution honesty

- Direct (no referral source) conversions counted as `direct`.
- Coach-private link (UTM `source=coach_share`) attributed but flagged as "coach-promoted, not platform-discovery".
- Coach dashboard distinguishes "platform discovery attributed" vs "self-attributed" conversions.

### 3.6 Refund attribution

Refund event references the original conversion via `attributionId`; refund-rate metrics use this linkage.

---

## 4. UTM parameter handling

### 4.1 Capture

- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` captured on first event of a session.
- Stored on `DiscoveryEvent.source.utm`.
- Persisted to session-scope cookie for re-attachment to subsequent events.

### 4.2 Sanitization

- Max 80 chars per UTM value.
- Stripped of HTML, JS, control chars.
- Lowercased for analytics consistency; original casing preserved on event.

### 4.3 Stripped from canonical URL

- `<link rel="canonical">` does NOT include UTM params.
- Browser URL bar still shows UTM (no auto-strip; just canonical hint to crawlers).
- UTM persisted in session cookie + first-event row.

### 4.4 UTM-based attribution override

- If UTM `source` is `coach_share`, attribution flagged as "coach-promoted".
- If UTM `source` is `editorial` or `discover_landing`, attribution flagged as "platform-promoted".

---

## 5. Cookie consent integration

### 5.1 Consent categories

Three cookie consent categories, separately togglable:

- **Strictly necessary** (always on): session, auth, CSRF.
- **Analytics** (default off): event ledger writes, PostHog.
- **Personalisation** (default off): personalised ranking signals.

### 5.2 Consent gates

- Without `Analytics` consent, `DiscoveryEvent` writes are MINIMAL: only `landing_view` and `profile_view` with no UTM, no visitor ID, no IP country. Used for aggregate counts only. PostHog not called.
- With `Analytics` consent only, full event ledger enabled. PostHog called with non-PII fields.
- With `Analytics + Personalisation` consent, ranker uses history. See `recommendation-engine.md` Section 7.

### 5.3 Geographic compliance

- EU/UK/EEA: opt-in required.
- California: opt-out via "Do Not Sell" link.
- Brazil (LGPD): opt-in.
- Other: opt-out default.

Geo detection via Cloudflare country header; banner shown accordingly.

### 5.4 Consent revocation

- User can revoke consent at any time.
- Revocation triggers backfill: `DiscoveryEvent` rows for that visitor anonymised (PII fields cleared) within 24h.
- Personalisation cache invalidated immediately.

---

## 6. Server-side ingestion contract

### 6.1 Endpoint

```
POST /v1/discover/events
Content-Type: application/json
Body: { events: DiscoveryEventV1[] }   // up to 50 events per batch
```

Auth: optional. Anonymous allowed for events 1-5.

### 6.2 Rate limits

- Per IP: 100 events / 10 sec.
- Per visitor: 200 events / 10 min.
- Per session: 500 events / 30 min.
- Burst allowance: 2x for 60s.

### 6.3 Validation

- `kind` in enum.
- `clientEventId` is ULID.
- Per-event size < 4 KB.
- Batch < 200 KB.
- `occurredAt` within [now-1h, now+5min] (clock-skew tolerance).

### 6.4 Server stamps

- `occurredAt` overwritten with server time if client time outside tolerance window.
- `ip_country` set from Cloudflare header.
- `user_agent_class` derived from UA.
- `capabilityHash` set from request principal.

### 6.5 Idempotent dedupe

- `(visitorId, clientEventId)` unique constraint with ON CONFLICT DO NOTHING.

### 6.6 Error envelope

```ts
{ code: "validation_failed", message: "...", details: { field: "..." } }
{ code: "rate_limited", message: "...", details: { retryAfter: 30 } }
{ code: "consent_required", message: "...", details: { category: "Analytics" } }
```

---

## 7. Coach-facing dashboards

### 7.1 Dashboard surfaces

- `/coach/console/discovery/funnel` — funnel chart (impression → click → application → checkout).
- `/coach/console/discovery/attribution` — attribution toggle (last-touch v1; multi-touch v2).
- `/coach/console/discovery/sources` — breakdown by source (organic discovery, featured slot, coach-share, editorial, direct).
- `/coach/console/discovery/refunds` — refund-rate trailing 90d, with breakdown.

### 7.2 Funnel chart

Daily granularity. Bars per step. Hover shows exact counts.

Fields:
- impressions (organic + featured separately).
- card_clicks.
- profile_views.
- cta_clicks.
- application_submits.
- checkout_completed.
- refunds.

Conversion rates between steps shown as percentages.

### 7.3 Cohort analysis (forward-look v2)

Cohort by week of first impression; track week-over-week conversion. Out of v1.

### 7.4 Coach-scope vs platform-aggregate

- Coach sees own data only; aggregated across all their listings (parent + sub-coaches).
- ADMIN sees platform aggregate.
- Sub-coach sees their slice only (if independent listing capability granted).

### 7.5 Privacy on dashboards

- No client identities exposed.
- No client PII exposed.
- Only aggregated counts and percentages.
- Coach-scope query goes through `capabilityHash` enforcement.

### 7.6 Export

- CSV export of funnel data with daily granularity, max 365 days.
- Audited.

---

## 8. Conversion rate baseline targets

These are guidance baselines; A/B experiments will measure delta.

| Funnel step                   | v1 target (median coach) | v1 target (top quartile) |
| ----------------------------- | ------------------------ | ------------------------ |
| impression → click (CTR)      | 1.5%                     | 4.0%                     |
| click → profile_view          | 92%                      | 96%                      |
| profile_view → cta_click      | 8%                       | 18%                      |
| cta_click → application       | 35%                      | 55%                      |
| application → checkout        | 18%                      | 32%                      |
| impression → checkout (e2e)   | 0.06%                    | 0.4%                     |
| refund-rate post-checkout     | < 4%                     | < 2%                     |

Sources: industry benchmarks for high-ticket coaching, validated against early TGP cohort. Targets refreshed quarterly.

If a coach's CTR drops below 0.5% sustained over 14 days, ranking suppresses card from `recommended` (probable click-bait or off-target). See `recommendation-engine.md` Section 5.2.

---

## 9. PII boundary + PostHog rules

### 9.1 PII never to PostHog

- No email.
- No phone.
- No physical address.
- No client name.
- No payment data.

### 9.2 What does go to PostHog (with Analytics consent)

- `event_kind`.
- `coach_id` (entity ID, not PII).
- `app_id`.
- `archetype`, `niche` (taxonomy).
- `position` (in slot).
- `featuredSlotTier`.
- `country_iso` (coarse).
- `device_class`.

### 9.3 Visitor ID

- Visitor ID sent to PostHog is a separate `analytics_id` (deterministic hash of `visitorId` with platform salt). Never the raw `visitorId`.
- `authUserId` NEVER sent to PostHog.

### 9.4 PostHog group key

- `coach_id` is a group property for coach-scope dashboards.
- No client property.

### 9.5 Audit

- Periodic review of PostHog events to confirm no PII leak.
- Automated linter on event payload schemas.

---

## 10. State + retention

### 10.1 Retention

- `DiscoveryEvent` hot: 365 days in primary DB.
- Cold archive: years 2-7 in S3 + Athena.
- After 7 years: hard delete.

### 10.2 GDPR delete

- On `Coach` delete: cascade hard-deletes all `DiscoveryEvent` rows where `coachId` = that coach.
- On user delete: anonymise all `DiscoveryEvent` rows where `visitorId` or `authUserId` matches; replace with `tombstone:{hash}`.
- Cold archive: tombstone within 30 days; hard delete on next quarterly cleanup.

### 10.3 GDPR export

- User can export all `DiscoveryEvent` rows where `visitorId = me OR authUserId = me`.
- Export format: NDJSON.
- Delivered via signed URL; expires 7 days.

---

## 11. Failure modes

### 11.1 Event spam from single IP

- **Detection**: rate-limit + behavioural fingerprint.
- **Recovery**: 429 response; events dropped; not stored.
- **Audit**: rate-limit hit count metric.

### 11.2 Attribution confusion (clicked Coach A, converted Coach B)

- **Detection**: attribution joins on `coachId`. No cross-coach attribution.
- **Recovery**: conversion attributed to direct/last-touch on Coach B's events only.
- **Audit**: cross-coach mismatch logged for analytics review.

### 11.3 Cookie revocation race

- **Detection**: revocation timestamp; events with `occurredAt > revokedAt` should not exist; events between consent and revocation are anonymised.
- **Recovery**: backfill anonymisation job within 24h.
- **Audit**: revocation lag metric.

### 11.4 PostHog leak of PII

- **Detection**: event payload linter at ingestion.
- **Recovery**: payload rejected; CI test catches.
- **Audit**: any leak is P0; quarterly external audit.

### 11.5 Refund event arrives after 30-day attribution window

- **Detection**: refund timestamp - original conversion timestamp can exceed 30 days for late refunds.
- **Recovery**: refund still attributed to original conversion via `attributionId`. Window applies only to PRE-conversion attribution chain.
- **Audit**: orphan refund detection.

### 11.6 Featured-slot impression vs organic impression conflation

- **Detection**: every impression event has `featuredSlotId` (nullable). Featured impressions excluded from organic priors.
- **Recovery**: ranking pipeline filters; dashboard separates.
- **Audit**: cross-filter.

### 11.7 Visitor cross-device merge collision

- **Detection**: when anonymous visitor authenticates, all events from `visitorId` cookie are merged to `authUserId`. If two visitor IDs end up authenticating to the same user, both merged.
- **Recovery**: audit; rare but harmless.

### 11.8 Bot impressions inflating coach's view count

- **Detection**: `user_agent_class = "bot"` filtered from coach dashboards.
- **Recovery**: bot events stored but not surfaced.
- **Audit**: bot share metric.

---

## 12. Test plan

### 12.1 Unit

- Attribution chain (last-touch, first-touch, position-based 40/20/40).
- UTM sanitisation.
- Consent gate logic.
- Server-stamp logic for clock-skew.

### 12.2 Integration

- Anonymous flow: landing → click → profile → application → auth → checkout. Attribution preserved across auth.
- Cookie revocation flow: events written, then anonymised.
- PostHog payload assertion: no PII fields.

### 12.3 E2E

- Coach dashboard renders correct funnel for synthesized event stream.
- Refund event reduces refund-rate baseline.

### 12.4 Load

- 1k events/sec sustained; p95 ingestion < 80ms.
- Batch of 50 events: p95 < 100ms.

### 12.5 Privacy

- GDPR delete cascade on coach: events removed; verified with count.
- GDPR export NDJSON validity.
- Bot UA filter: synthetic bot events do not surface in dashboard.

---

## 13. Schema deltas (illustrative)

```prisma
model DiscoveryEvent {
  id              String   @id @default(cuid())
  kind            DiscoveryEventKind
  occurredAt      DateTime @default(now())
  visitorId       String
  authUserId      String?
  sessionId       String
  coachId         String?
  appId           String?
  programId       String?
  featuredSlotId  String?
  position        Int?
  filterHash      String?
  capabilityHash  String
  scope           String   // "public" | "auth"
  utmSource       String?
  utmMedium       String?
  utmCampaign     String?
  utmContent      String?
  utmTerm         String?
  referrer        String?
  ipCountry       String?
  userAgentClass  String
  attributionId   String?
  clientEventId   String
  metadata        Json?
  // GDPR cascade via Coach.id (hard delete) and via User.id (anonymise)
  @@unique([visitorId, clientEventId])
  @@index([coachId, kind, occurredAt])
  @@index([visitorId, occurredAt])
  @@index([occurredAt])
}

enum DiscoveryEventKind {
  LANDING_VIEW
  CARD_IMPRESSION
  CARD_CLICK
  PROFILE_VIEW
  CTA_CLICK
  APPLICATION_SUBMIT
  CHECKOUT_INITIATED
  CHECKOUT_COMPLETED
  REFUND
}

model AttributionAssignment {
  id                 String   @id @default(cuid())
  conversionEventId  String   @unique
  conversionEvent    DiscoveryEvent @relation(fields: [conversionEventId], references: [id], onDelete: Cascade)
  model              AttributionModel
  attributedToEventIds String[]   // ordered chain
  weights            Decimal[]    @db.Decimal(5, 4)  // sums to 1.0
  computedAt         DateTime  @default(now())
  @@index([model])
}

enum AttributionModel {
  LAST_TOUCH
  FIRST_TOUCH
  POSITION_BASED
}

model CookieConsent {
  id              String   @id @default(cuid())
  visitorId       String
  authUserId      String?
  analytics       Boolean  @default(false)
  personalisation Boolean  @default(false)
  geo             String   // ISO country
  consentedAt     DateTime
  revokedAt       DateTime?
  @@unique([visitorId, consentedAt])
  @@index([authUserId])
}
```

---

## 14. Day-1 implementation order

1. `DiscoveryEvent` model + ingestion endpoint.
2. Idempotency + dedupe.
3. Rate-limit middleware.
4. Server stamps + UA classification.
5. Cookie consent service + categories.
6. Attribution service (last-touch v1).
7. Coach-funnel dashboard query (read-only).
8. PostHog payload mapper + linter.
9. GDPR delete + export jobs.
10. Cold archive job to S3.

---

## 15. Cross-repo

- `growth-project-mobile`: emits same `DiscoveryEvent` payload via REST. Mobile cookie equivalent is keychain-stored visitor ID.
- `tgp-finance-app`: subscribes to `checkout_completed` and `refund` events for finance reconciliation.

---

## 16. Audit log

Every dashboard query is audited (actor, scope, query window) for compliance. Coach console queries scoped via capability hash.

GDPR delete and export operations audited.

---

## 17. Senior-engineer onboarding

1. Read Section 1 (funnel) and Section 2 (event ledger).
2. Read Section 3 (attribution) — note OWNER_DECISION 2.
3. Read Section 5 (cookie consent) and Section 9 (PII boundary) — non-negotiable.
4. Skim Section 7 (dashboards).
5. Confirm rate limits and consent gates are wired to CDN edge before launch.

---

End `buyer-funnel-and-attribution.md`.
