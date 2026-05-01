# Wave 7 — Public Coach Discovery & Marketplace

Status: DRAFT spec, docs-only. Branch `docs/wave-7-discovery-marketplace`. Base `main`. No runtime, no migrations, no `prisma/schema.prisma` mutation. Schema deltas illustrative inside fenced ` ```prisma ` blocks.

## Purpose

Close TGP's "Discover" gap with Whop. Provide a public, crawler-indexable surface where prospective clients browse coaches, sub-coaches, and apps, filter by archetype/niche/price/geo/modality, and convert into applications or checkouts. Surface earned, verifiable trust signals only. Provide coaches with a buyer-funnel attribution dashboard. Provide TGP with a monetisable featured-placement product gated by anti-spam, refund-rate, and disclosure rules.

The marketplace is a thin read-side projection over the existing `Coach`, `SubCoach`, `Program`, and (Wave 6) `App` entities. It is NOT a separate identity domain. Slugs, profiles, and pricing remain owned by the coach and sub-coach console (Wave 1, Wave 2). Discovery owns: indexing, ranking, filter taxonomy, public card schema, attribution event ledger, and featured-slot billing.

## Non-goals

- No fake testimonials, no fake reviews, no fabricated transformation photos. Trust signals are earned, verifiable, and revocable. See `trust-and-safety.md`.
- No exact-revenue claims by coaches in cards or profiles. Income guarantees are banned-claim territory.
- No medical claims (cure, treat, diagnose). Banned-claim list in `trust-and-safety.md`.
- No public streak counters that shame loss. Doctrine collision: TGP psych doctrine forbids public streak shaming. Discovery may show "verified outcomes" but never current-streak loss state.
- No social-proof inflation. Counts surfaced (e.g. completed-program count) are computed from server-side events with anti-gaming detection.
- No exposed leaderboards by default in discovery surface.
- No private DMs from discovery surface. Conversion path is application form or checkout.
- No dark-pattern dwell-time or interstitial blocking. Card-to-profile is one click.
- No paid review boosts. Featured placement is disclosure-gated; ranking signals are not for sale.
- No backfill of legacy `Coach.profile` to public-card shape in this wave. Coaches must opt in via console.

## OWNER decisions

Tag: `OWNER_DECISION:`. Each surfaces options, recommendation, and downstream impact. Final decisions before Day 1 implementation.

1. **Embedding model for vector profile matching.** Options: (a) `text-embedding-3-large` via OpenAI, (b) local `bge-large-en-v1.5` self-hosted, (c) hybrid (OpenAI for cold-start, local for hot path). Recommendation: **(c) hybrid**. Cost predictability + latency. See `recommendation-engine.md` Section 4.
2. **Attribution window.** Options: (a) 7-day last-touch, (b) 30-day last-touch, (c) 30-day first-touch, (d) multi-touch linear, (e) multi-touch position-based 40/20/40. Recommendation: **(b) 30-day last-touch** for v1, multi-touch position-based as v2 dashboard toggle. See `buyer-funnel-and-attribution.md` Section 3.
3. **Featured-slot pricing model.** Options: (a) CPM auction, (b) flat tier with cap (Bronze/Silver/Gold weekly slots), (c) hybrid auction-with-floor. Recommendation: **(b) flat tier with cap**. Predictable for coach side; anti-spam-friendly; no auction complexity. See `featured-placements-and-monetization.md` Section 2.
4. **Refund-rate auto-suspend threshold for featured placement.** Options: (a) 5%, (b) 8%, (c) 10%, (d) 12%. Recommendation: **(b) 8% trailing 90 days**. Aligns with Stripe industry guidance and gives small coaches noise tolerance. See `trust-and-safety.md` Section 5.
5. **Transformation-photo retention policy.** Options: (a) delete on coach offboarding only, (b) hold 7-year hold per US tax-substantiation, (c) GDPR-aligned hold 30 days post-revocation then hard delete, (d) tombstone for 90 days then hard delete. Recommendation: **(c) GDPR-aligned 30-day post-revocation hard delete**. Lowest legal exposure. See `trust-and-safety.md` Section 4.
6. **Crawler indexing policy.** Options: (a) all coach profiles indexable by default, (b) opt-in indexing only, (c) opt-out indexing. Recommendation: **(c) opt-out indexing** with `noindex` honored on coach console toggle.
7. **Geo-radius unit.** Options: (a) km, (b) mi, (c) auto from locale. Recommendation: **(c) auto from locale** with explicit query-string override.
8. **Sub-coach surfacing.** Options: (a) only parent coach card surfaces, (b) sub-coach cards surface independently, (c) sub-coach surfaces under parent coach card as "team". Recommendation: **(c) sub-coach as team under parent**. Aligns with Wave 2 hierarchy. See `public-directory-spec.md` Section 5.

## Personas + permission matrix

| Action                                          | OWNER | COACH (parent) | SUB_COACH | CLIENT | ADMIN | Public/Anonymous |
| ----------------------------------------------- | ----- | -------------- | --------- | ------ | ----- | ---------------- |
| View public card (`/discover`)                  | Y     | Y              | Y         | Y      | Y     | Y                |
| Toggle profile listing on/off                   | Y     | Y (own)        | N (parent owns) | N | Y | N |
| Edit public card content                        | Y     | Y (own)        | Limited (display name + headline only) | N | Y | N |
| Submit verified-achievement proof               | N     | Y              | Y (parent approves) | N | Y | N |
| Approve verified-achievement                    | N     | N              | N         | N      | Y     | N                |
| Purchase featured placement                     | N     | Y              | N         | N      | Y     | N                |
| View own buyer-funnel dashboard                 | N     | Y              | Y (own slice) | N | Y | N                |
| View global discovery analytics                 | Y     | N              | N         | N      | Y     | N                |
| Configure banned-claim list                     | N     | N              | N         | N      | Y     | N                |
| Trigger refund-rate suspension override         | N     | N              | N         | N      | Y     | N                |
| File a takedown report                          | N     | Y              | Y         | Y      | Y     | Y (rate-limited) |
| Export own discovery events (GDPR)              | N     | Y              | Y         | N      | Y     | N                |
| Delete own discovery events (GDPR)              | N     | Y              | Y         | N      | Y     | N                |
| Submit testimonial as client                    | N     | N              | N         | Y (consent gated) | Y | N |

OWNER permissions are platform-superset; ADMIN is operations role with takedown/moderation reach. COACH owns own card and sub-coach team. SUB_COACH cannot independently list outside parent unless parent grants `SUB_COACH_INDEPENDENT_LISTING` capability (default off; surfaces in Wave 2 capability matrix).

## File map

```
docs/discovery/
  README.md                              -- this file (~200 lines)
  public-directory-spec.md               -- card + filter taxonomy + URL structure (~1,000-1,200)
  recommendation-engine.md               -- ranking, vector match, freshness, A/B (~1,100-1,400)
  featured-placements-and-monetization.md -- paid slots, anti-spam, billing (~800-1,000)
  buyer-funnel-and-attribution.md        -- attribution model, event ledger, dashboards (~900-1,100)
  trust-and-safety.md                    -- verified achievements, banned claims, refund-rate (~700-900)
  api-and-mobile.md                      -- REST API, mobile parity, cache, rate limits (~600-800)
  PERP_HANDOFF.md                        -- session log (~150)
```

Each file is dense spec, not boilerplate. A senior engineer should be able to start implementation Monday morning.

## Dependency graph

```
Wave 1 (Admin console)        ─┐
Wave 2 (Coach hierarchy)      ─┤
Wave 3 (Admin data-feed)      ─┼──→  Wave 7 (Discovery)
Wave 6 (Apps)                 ─┤        │
Wave 8 (Trust signals)        ─┘        ├──→ growth-project-mobile (Wave 4 mirror)
                                        └──→ tgp-finance-app (featured-slot billing)
```

Hard dependencies:

- **Wave 2** (`docs/coach-hierarchy/`): `Coach`, `SubCoach`, `Org` entities. Capability `SUB_COACH_INDEPENDENT_LISTING`. Discovery reads parent/child relationship via existing edge.
- **Wave 6** (`docs/apps/`): `App` entity with `slug`, `pricing`, `category`. Discovery indexes `App` independently of `Coach` for `/discover/apps`.
- **Wave 8** (`docs/affiliate-and-rewards/`): trust signal sources — completion counts, content-rewarded engagement, affiliate provenance. Cards surface "verified completions" computed from Wave 8 ledger.
- **Wave 3** admin data-feed: scope-stack (`org/cohort/coach/client`) and capability hash cache keys reused for moderation queue cache invalidation.
- **Wave 5** finance: Stripe Connect already wired. Featured-slot billing reuses Connect platform-fee path; payouts not affected.

Soft dependencies:

- **Wave 4 mobile**: API contracts in `api-and-mobile.md` are mobile-first; mobile RN app consumes same endpoints.
- **growth-project-mobile** must mirror filter taxonomy in its native filter UI.

## Merge order

1. `docs/discovery/README.md` (this).
2. `public-directory-spec.md` (taxonomy + card schema; foundation).
3. `trust-and-safety.md` (gates everything else).
4. `recommendation-engine.md` (ranking).
5. `featured-placements-and-monetization.md` (depends on directory + trust).
6. `buyer-funnel-and-attribution.md` (depends on directory + recommendation).
7. `api-and-mobile.md` (binds the read surface).
8. `PERP_HANDOFF.md` (session log; last).

PR is a single squash-merge. Implementation PR sequence (Day 1 onward) follows the same order, one entity-set per PR.

## Scope-stack hash invariants (from Wave 3)

Discovery cache keys are derived from a tuple `(scope, filter_hash, capability_hash, page_cursor)` where:

- `scope` is `public|org:{id}|coach:{id}` (the visibility lens).
- `filter_hash` is a stable SHA-256 over the canonicalised filter parameter object.
- `capability_hash` is the Wave 3 capability hash of the requesting principal (or `anon` for public).
- `page_cursor` is the opaque cursor (see `public-directory-spec.md` pagination).

Cache invalidation is triggered by:

- coach profile mutation (clears coach-specific keys),
- featured-slot purchase or expiry (clears featured-band keys),
- moderation action (clears global + coach keys),
- 5-minute TTL hard ceiling regardless.

## Money rules (recap)

All money fields `Decimal(14,2)`, currency stored on row. Featured-slot purchase via Stripe Connect platform fee path. No money movement to coaches in this wave; only platform-collected fees for featured slots. Refund handling for featured-slot purchase: pro-rata for unused days, computed at suspension time. See `featured-placements-and-monetization.md` Section 6.

## AI rules (recap)

Default model `sonar-pro` (Perplexity) for any AI use in moderation summarisation. Vector embedding model is separate: see OWNER_DECISION 1. Hard monthly spend cap on embeddings: $500 platform-wide initial. MCP scopes for moderation: `moderation:read`, `moderation:write` — never `coach:*` or `client:*`. No tool action without explicit ADMIN consent.

## Performance budgets (summary)

| Surface                          | 100 coaches | 1k coaches | 10k coaches |
| -------------------------------- | ----------- | ---------- | ----------- |
| `GET /discover/coaches` p95      | 80ms        | 150ms      | 250ms       |
| `GET /discover/coaches` p50      | 30ms        | 60ms       | 120ms       |
| `GET /discover/coaches/:slug` p95 | 60ms       | 100ms      | 180ms       |
| `POST /discover/events` p95      | 40ms        | 50ms       | 80ms        |
| Recommendation rank p95          | 100ms       | 180ms      | 250ms       |
| SSR landing TTFB p95             | 200ms       | 300ms      | 400ms       |

Detailed budgets per file. Budgets enforce read-replica usage, Redis caching, and CDN edge caching for public surfaces.

## Senior-engineer onboarding checklist

1. Read this README end-to-end.
2. Read `public-directory-spec.md` Section 1 (card schema) and Section 5 (URL structure).
3. Read `trust-and-safety.md` Section 1 (verified-achievement) and Section 6 (banned-claim list).
4. Read `recommendation-engine.md` Section 2 (cold-start) and Section 5 (failure modes).
5. Skim `api-and-mobile.md` for endpoint surface.
6. Confirm OWNER decisions are resolved (or escalate).
7. Day 1 implementation order in `public-directory-spec.md` Section 11.

## Rollback plan

Discovery is a read-side projection with its own tables. Rollback strategy:

- Feature-flag `DISCOVERY_PUBLIC_ENABLED` (default off). Toggle off → public routes 404.
- Featured-slot billing has its own kill-switch `FEATURED_SLOT_BILLING_ENABLED`. Toggle off → block new purchases; existing slots run to expiry.
- Recommendation engine has shadow mode `DISCOVERY_RECO_SHADOW` (compute and log but do not serve). Default on for first 30 days post-launch.
- Discovery event ledger is append-only; no rollback risk.
- Profile `noindex` toggle is honored at SSR level; can globally `noindex` all profiles via env flag for legal emergencies.

## Test plan (summary)

- Unit: filter canonicalisation, cursor encoding, ranking score composition, banned-claim regex, geo radius math.
- Integration: end-to-end card render with verified achievements, featured-slot purchase flow, refund-rate suspension trigger, moderation queue.
- E2E: anonymous browse → click coach card → land on profile → submit application; coach views funnel dashboard.
- Load: 10k coaches, 1k QPS sustained on `GET /discover/coaches`, 100 QPS on event ingestion.
- Security: SSRF on profile image upload, IDOR on event export, rate-limit bypass on takedown report.
- Privacy: GDPR delete cascade on `DiscoveryEvent`, PII not leaked to PostHog, cookie-consent gate on personalised ranking.

Detailed test plans in each file's Test Plan section.

## Status

Draft. PR is the spec. No implementation. No migrations. `prisma/schema.prisma` untouched.
