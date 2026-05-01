# Recommendation Engine — Cold-Start, Vector Match, Freshness, Personalisation, A/B

Status: DRAFT spec. Docs only. Schema deltas illustrative.

This file owns the ranking algorithm for `sort=recommended` on `/discover/coaches` and `/discover/apps`. It defines: cold-start ranking, vector profile matching, view-to-purchase ranking, freshness decay, personalisation signals, failure modes, A/B testing framework, and performance budget.

## Table of contents

1. Ranking architecture overview
2. Cold-start ranking (no personalisation)
3. View-to-purchase ranking (warm)
4. Vector profile matching
5. Failure modes
6. A/B testing framework
7. Personalisation signals + consent
8. Freshness decay
9. Performance budget at scale
10. Anti-gaming + integrity
11. Test plan
12. Day-1 implementation order
13. Cross-repo

---

## 1. Ranking architecture overview

Ranking is a two-stage pipeline:

```
candidate_set ──► first_pass_score ──► top_K (K=200) ──► second_pass_score ──► top_N (N=48 page) ──► UI
```

- **Candidate set** is filter-eligible coaches matching the request's filter taxonomy (Section 2 of `public-directory-spec.md`).
- **First-pass score** is fast: lexical match + filter match + freshness + geo match. Computed in Postgres via materialised view `discovery_first_pass_v1`.
- **Top K = 200** candidates piped to second-pass.
- **Second-pass score** adds: vector match (if `q` present), personalisation (if consented), refund-rate gate, featured-slot boost, conversion-rate prior.
- **Top N = 48** is the largest page size; cursor-paginates beyond.

Featured-slot placement is layered AFTER ranking: gold-tier slots get up to 2 guaranteed positions in first 12, silver up to 1, bronze rotational. Sponsored disclosure on every featured card.

Ranking score:

```
score = w_text * text_match
      + w_vec  * vector_sim (if q)
      + w_geo  * geo_decay
      + w_arch * archetype_overlap
      + w_fresh* freshness_decay
      + w_conv * conversion_prior
      + w_pers * personalisation_lift     (consent-gated)
      - p_low  * low_quality_penalty
      - p_susp * suspension_penalty
```

Default weights (v1):
- `w_text = 0.20`
- `w_vec = 0.18` (zero if no `q`)
- `w_geo = 0.15` (zero if no geo filter)
- `w_arch = 0.12`
- `w_fresh = 0.10`
- `w_conv = 0.15`
- `w_pers = 0.10` (zero if no consent)
- `p_low = 0.30`
- `p_susp = 1.00` (effective filter)

Weights surface as platform constants (`RANKING_WEIGHTS_V1`); A/B testable. Sum of positive weights = 1.00 only if all signals active; otherwise renormalised.

---

## 2. Cold-start ranking

Definition: the request has no `q`, no personalisation signal (anonymous or no-consent client), and the candidate has < 30 days of platform data.

Algorithm:

```
score_cold = 0.40 * geo_decay
           + 0.25 * archetype_overlap
           + 0.20 * freshness_decay
           + 0.15 * profile_completeness_score
```

- `geo_decay` = `exp(-haversine_km / scale_km)` with `scale_km = 50`. If no geo filter, this term is 0 and renormalised.
- `archetype_overlap` = `|requested_archetypes intersect coach_archetypes| / |requested_archetypes union coach_archetypes|` (Jaccard).
- `freshness_decay` (Section 8).
- `profile_completeness_score` = number of completed fields (avatar, headline, niches, modality, geo, starting price, at least one verified achievement, at least one trust badge) / 8.

Cold-start ranking deliberately ignores conversion priors because new coaches have no signal. Cold-start surface gets a "New coach" badge for first 30 days.

### 2.1 Cold-start anti-gaming

- Coaches cannot artificially boost `profile_completeness_score` without filling each field with content that passes moderation.
- `freshness_decay` is computed from `profile_published_at`, not last edit; trivial-edit churn does not refresh.
- New-coach quota: at most 30% of first page slots may be < 30-day coaches. Above that, additional new coaches push to page 2.

### 2.2 Cold-start spam protection

- Newly created coach listings are surfaced only after PENDING_REVIEW → ACTIVE transition (Section 9 of `public-directory-spec.md`).
- During first 7 days post-publication, coach is subject to "trial visibility" — capped at 20% of normal impression share. Lifts automatically if no moderation flags.

---

## 3. View-to-purchase ranking (warm)

Definition: coaches with >= 30 days of platform data and >= 1000 lifetime impressions.

Algorithm uses Bayesian-smoothed conversion priors:

```
conversion_prior = ( clicks + α ) / ( impressions + α + β )
where α = 5, β = 200    -- prior pulls toward 5/(5+200) ≈ 2.4% baseline CTR
```

Multi-step funnel:
- `impression → click` (CTR)
- `click → application_or_checkout` (apply rate)
- `application → checkout` (close rate; coach-side; only for coaches who provide visibility)

Composite:

```
conv_score = ctr_smoothed^0.4 * apply_smoothed^0.4 * close_smoothed^0.2
```

### 3.1 Bias mitigation

- Position bias: each impression is weighted by `1 / position_factor`, where `position_factor` = 1.0 for slot 1, 0.85 for slot 2, etc. Standard cascade model.
- Featured-slot impressions are NOT counted toward organic conversion priors (otherwise paid placement gets self-reinforcing boost).
- Bot impressions (UA + behavioural fingerprint) excluded.

### 3.2 Cold-to-warm transition

A coach is "warm" when `impressions >= 1000` and `days_since_published >= 30`. Until both, they remain in cold-start ranking. Transition is gradual: blend factor `min(1.0, (impressions / 1000) * (days / 30))` weights warm score against cold score.

---

## 4. Vector profile matching

OWNER_DECISION 1: hybrid model recommended. `text-embedding-3-large` (3072-d) for cold profiles; local `bge-large-en-v1.5` (1024-d) for warm path query embeddings. Stored as `pgvector` `vector(1024)` after dimensionality projection.

Rationale: OpenAI cost predictable on stable corpus; local model amortises query cost at scale.

### 4.1 Coach embedding

- Source text concatenation: `headline + " " + nicheTags.join(" ") + " " + archetypeTags.join(" ") + " " + about_long_form (capped 2000 chars)`.
- Recomputed on profile mutation that touches above fields.
- Stored on `CoachListingEmbedding(coachId, embedding vector(1024), modelTag, computedAt)`.
- Job queue (`embeddings.recompute`) with 30s SLA. Stale embedding flag if > 7 days old; re-encoded by background job.

### 4.2 Query embedding

- For free-text `q`, embed query once per request.
- Cache by `sha256(q || modelTag)` for 1 hour in Redis (queries repeat at high rate).
- Model: `bge-large-en-v1.5` for hot path (sub-50ms), `text-embedding-3-large` for new model evaluation in shadow.

### 4.3 Vector similarity

- Cosine similarity via pgvector `<=>` operator (note: pgvector returns distance; convert to similarity).
- Index: `ivfflat (embedding vector_cosine_ops) WITH (lists=100)` for 10k coaches; tune for 100k+.
- Top-50 vector neighbours filtered against `candidate_set` (filter taxonomy must still pass).

### 4.4 Hybrid scoring

`vec_match_score` combines vector similarity with lexical BM25:

```
vec_match_score = 0.6 * cos_sim_normalized + 0.4 * bm25_normalized
```

Both terms `min-max` normalised within candidate set per request (so absolute similarity drift does not destabilise rankings).

### 4.5 Fallback if embedding unavailable

If a coach's embedding is missing or stale > 30 days, `vec_match_score` defaults to `0.5 * bm25_normalized` (lexical only). Logged.

### 4.6 Embedding cost cap

Hard monthly cap $500 USD platform-wide for OpenAI embeddings. Spending tracked in `EmbeddingSpendLedger`. At 90% of cap, fall back to local-only. At 100%, kill switch on OpenAI calls; alert ADMIN.

---

## 5. Failure modes

### 5.1 Cold-start spam (new-coach flood)

- **Detection**: rate of new ACTIVE listings per hour exceeds baseline by > 3 sigma.
- **Recovery**: enable stricter PENDING_REVIEW gate (manual review required for all new coaches) until rate normalises.
- **Audit**: every spam-flag event logged.

### 5.2 Click-bait headline gaming

- **Detection**: high CTR (top 1%) with very low apply rate (< 0.5%) → click-bait suspect.
- **Recovery**: suppress card from `recommended` sort for 7 days; ADMIN review queue. Coach notified.
- **Audit**: every suppression event auditable; coach can appeal.

### 5.3 Embedding poisoning via injected prompts

- **Detection**: profile text containing prompt-injection patterns (`ignore previous instructions`, role-play markers) flagged at moderation.
- **Recovery**: blocked at profile-mutation step. Not specific to embeddings, but doubly important here.
- **Audit**: pattern-match hits flagged; not blocked silently.

### 5.4 Snapshot inconsistency across paginated requests

- **Detection**: cursor includes `snapshotId`; stale snapshot triggers rebase response field.
- **Recovery**: client re-renders results; subtle "Updated" toast.
- **Audit**: rebase rate metric.

### 5.5 Featured-slot circumvention

- **Detection**: any coach attempting to boost via repeated profile churn, multiple-account creation, sock-puppet impressions.
- **Recovery**: the "no hidden boost APIs" rule means there is no client-controlled boost parameter; impressions must originate from real client sessions. Bot detection runs on every event.
- **Audit**: anomaly score per coach; > threshold → ADMIN.

### 5.6 Vector index drift / corruption

- **Detection**: nightly job samples 0.1% of coaches and re-computes embedding; cosine drift > 0.05 → flag.
- **Recovery**: re-encode flagged coaches; rebuild ivfflat index if drift rate > 1%.
- **Audit**: drift metric; alert at SLO breach.

### 5.7 Personalisation leakage to non-consented user

- **Detection**: every personalisation feature gated on `cookie_consent.personalisation = true`. Unit tests and runtime asserts.
- **Recovery**: refuse personalisation; serve cold-start; log incident.
- **Audit**: any personalisation bypass attempt is a P0.

### 5.8 Refund-rate suspension race

- **Detection**: a coach in suspension may still serve cached cards for up to TTL.
- **Recovery**: cache-tag invalidation on suspension fires immediately; edge cache cleared in < 30s.
- **Audit**: suspension-to-clear-cache latency tracked; SLO 30s.

### 5.9 Geo-decay scaling regression

- **Detection**: scale-km hardcoded constant; A/B regression detected by holdback group conversion.
- **Recovery**: rollback ranking weights via flag.
- **Audit**: weights changes audited.

### 5.10 Featured-slot collision (multiple gold for same query)

- **Detection**: at most 2 gold slots per page enforced. Excess featured-slot purchases at the same archetype/niche tier are queued to next-page rotation.
- **Recovery**: queue order is FIFO based on purchase time; surplus paid-but-not-shown gold time triggers pro-rata refund.
- **Audit**: featured-slot fulfillment rate metric.

---

## 6. A/B testing framework

### 6.1 Mechanics

- Bucketing key: `sha256(visitor_id || experiment_id) % 100`.
- Visitor ID: stable 30-day cookie or auth user ID.
- Experiments declared in `RankingExperiment` table with `id`, `name`, `weights_treatment`, `weights_control`, `traffic_split`, `start_date`, `end_date`, `status (DRAFT|RUNNING|ENDED|ROLLED_BACK)`.
- Holdback bucket: 5% always control, never enrolled in any experiment, for global ranking-quality monitoring.

### 6.2 Metrics

Primary: `apply_rate_per_impression` (or `checkout_rate_per_impression`).

Guardrails:
- `coach_diversity_score` (Gini coefficient over impressions): treatment must not concentrate impressions on top 5% of coaches more than control by > 2%.
- `new_coach_share`: must not drop below 15% of impressions.
- `refund_rate_post_checkout`: must not increase.

### 6.3 Decision rule

Bayesian; declare winner when posterior probability treatment > control > 0.95 over guardrails maintained for 14 days, OR posterior probability < 0.05 for early stop.

### 6.4 Crawler exclusion

A/B traffic split disabled for crawler User-Agents (Section 7.2 of `public-directory-spec.md`). Crawlers always see control.

### 6.5 Experiments registry

Tracked in `RankingExperiment` table. Each experiment writes `experiment_assignments` row per visitor on first impression. GDPR delete cascade on visitor.

---

## 7. Personalisation signals + consent

### 7.1 Signals (warm, consented only)

- `recent_browse_archetypes` (last 30 days, capped 5).
- `completed_program_archetypes` (lifetime).
- `geo_inferred_country` (from IP, with consent).
- `device_class` (mobile/desktop) — coarse, not personalised.
- `time_of_day_bucket` — not personalised; used for global model only.

### 7.2 Consent gating

Every personalisation signal is gated on cookie consent. The cookie banner must include a `Personalisation` toggle (separate from `Analytics`). If `Personalisation = false`, ranking falls back to cold-start regardless of available history.

### 7.3 PII boundary

Personalisation features are computed server-side from event ledger (`buyer-funnel-and-attribution.md` Section 6). The features are NEVER sent to PostHog, and are NEVER joined to client identity outside the request lifecycle. Feature vector is ephemeral per request.

### 7.4 Personalisation lift formula

```
personalisation_lift = sigmoid(
    0.4 * archetype_history_match
  + 0.3 * niche_history_match
  + 0.2 * geo_familiarity
  + 0.1 * recency_factor
)
```

`sigmoid` outputs 0..1. Multiplied by `w_pers` weight.

### 7.5 Right to opt out + delete

- Toggle in user settings: `Disable personalised discovery`.
- GDPR delete on user account also deletes feature-source events.
- Personalisation feature cache (5-minute Redis) invalidated on opt-out.

---

## 8. Freshness decay

Definition: `freshness_decay = 0.5 ^ (days_since_profile_meaningful_update / 14)`.

- Half-life 14 days.
- "Meaningful update" = change to: headline, niches, archetype, starting price, verified-achievement chip set. NOT minor copy edits.
- Capped at 0.05 minimum (very stale profiles never zero).
- Boosted for coaches with newly approved verified achievement (1.0 reset on new chip).

### 8.1 Anti-gaming

- "Meaningful update" detection requires actual content change (diff > 30 chars OR field-set change).
- Cooldown: max 1 freshness reset per 7 days per coach.
- Profile churn detection: > 3 meaningful updates / 30 days flagged for ADMIN.

---

## 9. Performance budget at scale

### 9.1 Endpoint budget

| Surface                     | 100 coaches p95 | 1k p95 | 10k p95 | 100k p95 (forward-look) |
| --------------------------- | --------------- | ------ | ------- | ----------------------- |
| First-pass MV scan          | 20ms            | 40ms   | 80ms    | 200ms                   |
| Second-pass scoring (K=200) | 30ms            | 50ms   | 80ms    | 150ms                   |
| Vector top-50               | 25ms            | 40ms   | 70ms    | 150ms                   |
| Total ranking p95           | 80ms            | 130ms  | 230ms   | 500ms                   |
| Including SSR overhead      | 150ms           | 220ms  | 350ms   | 700ms                   |

### 9.2 Query plan

- First-pass MV: `discovery_first_pass_v1` partitioned by `archetype` for 10k+; nightly refresh + on-demand for hot tier.
- Second-pass: in-memory scoring on top-K candidates (K=200) — Node process, no DB roundtrip per candidate.
- Vector: pgvector `ivfflat` index, `lists` tuned per scale (100 for 10k, 400 for 100k).
- Conversion priors: pre-aggregated nightly, hot updates via stream.

### 9.3 Cache

- L1 in-process LRU for `RANKING_WEIGHTS_V1`, `NICHE_TAXONOMY_V1`, `ARCHETYPE_V1`. Process lifetime.
- L2 Redis for `(filter_hash, capability_hash, page_cursor)` 60s TTL.
- L3 edge CDN for SSR HTML 30-60s.
- Invalidation on coach mutation via cache-tag (`coach-card-{id}`, `coach-list`).

### 9.4 Cost cap (compute)

- Sustained 1k QPS at 10k-coach scale ~ 24 vCPU rank workers.
- Vector index in-memory ~ 4 GB for 100k coaches at 1024-d.
- Embedding compute (OpenAI) capped at $500/mo (Section 4.6).

---

## 10. Anti-gaming + integrity

### 10.1 Bot impression filtering

- IP velocity > 10 impressions / second from one origin → throttled.
- UA classifier: known good crawlers excluded from organic priors but not from impressions counted toward sitemap.
- Behavioural fingerprint (mouse-move, dwell, scroll variance) for desktop; touch-event variance for mobile.

### 10.2 Self-impression detection

- Coach viewing own card does not count toward priors.
- Linked accounts (same household, identified via Stripe customer linkage) do not count.

### 10.3 Sock-puppet detection

- ML classifier on creation-pattern + impression-cluster behaviour. Out of v1; placeholder hook in event ledger to allow retroactive scoring.

### 10.4 Featured-slot abuse

- Same coach cannot purchase > 4 weeks of consecutive Gold on the same archetype. Cooldown 2 weeks. Anti-monopoly.
- Multi-account purchase detection via Stripe customer linkage.

### 10.5 Conversion-prior gaming

- Apply rate gaming detected by application-to-checkout-funnel ratio. If applications spike but checkouts do not, apply rate alone is suppressed in ranking.
- Cancel-after-checkout (refund-rate) auto-suspends featured (Section 5 of `trust-and-safety.md`).

---

## 11. Test plan

### 11.1 Unit

- `score()` formula correctness across signal availability matrix.
- Bayesian smoothing edge cases: 0 impressions, 1 impression, 1000 impressions.
- Sigmoid input bounds.
- Freshness decay continuity.
- Geo-decay boundary at scale-km.

### 11.2 Integration

- New coach (cold) ranks with cold-only signals.
- Warm coach blends to view-to-purchase smoothly.
- Featured-slot precedence + sponsored disclosure.
- Personalisation off → identical to cold-start when no geo/q.

### 11.3 E2E

- Anonymous visit → no personalisation → cold-start ranks served.
- Authenticated visitor with consent + history → personalisation lift visible.
- Crawler bot → control bucket, no A/B split.

### 11.4 Load

- 1k QPS sustained at 10k coaches; p95 < 250ms.
- Vector index warmup; cold-cache p99 < 500ms.

### 11.5 Quality

- Offline replay: 30-day historical impression log replayed against new ranking; compare apply_rate_per_impression. Must not regress.
- Coach diversity (Gini) must not concentrate.

### 11.6 Privacy

- Personalisation off → request payload to ranker contains no user history. Verified via test that asserts request shape.

---

## 12. Day-1 implementation order

1. `RANKING_WEIGHTS_V1` constant + `score()` function (pure).
2. `discovery_first_pass_v1` materialised view + cron refresh.
3. Filter-eligible candidate set query.
4. Ranking pipeline orchestrator (first-pass → top-K → second-pass).
5. `CoachListingEmbedding` + pgvector index. (Local model only initially; OpenAI fallback added day 2.)
6. Featured-slot precedence layer.
7. Cursor pagination integration.
8. A/B framework + `RankingExperiment` table.
9. Personalisation feature pipeline (consent-gated).
10. Bot filtering + integrity counters.

---

## 13. Cross-repo

- `growth-project-mobile`: consumes `/v1/discover/coaches` directly. Ranking logic lives backend-side; mobile renders results. No client-side ranking.
- `tgp-finance-app`: not affected by ranking; only by featured-slot billing.

---

## 14. Schema deltas (illustrative)

```prisma
model CoachListingEmbedding {
  id          String   @id @default(cuid())
  coachId     String   @unique
  coach       Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  embedding   Unsupported("vector(1024)")?
  modelTag    String   // "bge-large-en-v1.5" | "text-embedding-3-large"
  computedAt  DateTime @default(now())
  sourceHash  String   // sha256 of source text
  @@index([modelTag, computedAt])
}

model EmbeddingSpendLedger {
  id           String   @id @default(cuid())
  vendor       String   // "openai"
  modelTag     String
  tokens       Int
  costUsd      Decimal  @db.Decimal(14, 4)
  occurredAt   DateTime @default(now())
  @@index([vendor, occurredAt])
}

model RankingExperiment {
  id            String   @id @default(cuid())
  name          String   @unique
  description   String
  weightsTreatment Json
  weightsControl   Json
  trafficSplit  Decimal  @db.Decimal(5, 4)  // 0..1
  startedAt     DateTime?
  endedAt       DateTime?
  status        ExperimentStatus @default(DRAFT)
  createdAt     DateTime @default(now())
  createdById   String
  decisionLog   Json?
}

enum ExperimentStatus {
  DRAFT
  RUNNING
  ENDED
  ROLLED_BACK
}

model RankingExperimentAssignment {
  id            String   @id @default(cuid())
  experimentId  String
  visitorId     String
  bucket        String   // "control" | "treatment_a" | ...
  assignedAt    DateTime @default(now())
  // GDPR delete on visitor cascade
  @@unique([experimentId, visitorId])
  @@index([visitorId])
}

view discovery_first_pass_v1 {
  // materialised; refreshed every 5 min
  // (Prisma view block illustrative; implementation is SQL CREATE MATERIALIZED VIEW)
}
```

---

## 15. Audit log

Every ranking config change (`RankingExperiment` mutations, `RANKING_WEIGHTS_V1` deploys) audited with actor, before/after weights, traffic split, justification.

Every personalisation-bypass attempt (e.g. consent toggled mid-session) audited.

---

## 16. Rollback plan

- `DISCOVERY_RECO_SHADOW = true` (default for first 30 days post-launch). Rank computed and logged but not served; baseline cold-start served instead.
- Once shadow validation passes, flip to `DISCOVERY_RECO_LIVE`. Holdback 5% always remains on cold-start.
- Per-experiment rollback via `RankingExperiment.status = ROLLED_BACK`.
- Hard kill: weights reset to `{w_text: 0, w_vec: 0, w_geo: 0, w_arch: 0, w_fresh: 1, w_conv: 0, w_pers: 0}` (effectively recency sort).

---

## 17. Senior-engineer onboarding

1. Read Section 1 (architecture).
2. Read Section 2 (cold-start) and Section 3 (warm).
3. Skim Section 4 (vector match) — note OWNER_DECISION 1.
4. Read Section 5 (failure modes) end-to-end.
5. Skim Section 7 (personalisation + consent boundary) — non-negotiable.
6. Confirm A/B framework is wired to PostHog for guardrails (no PII).

---

## 18. Detailed signal definitions

### 18.1 `text_match` (lexical)

- Source: `displayName`, `headline`, `nicheTags` (joined), `archetypeTags` (joined), `aboutLongForm` (capped 2000 chars).
- Backend: PostgreSQL full-text search via `tsvector` with weights (`A` for displayName, `B` for headline, `C` for niche/archetype, `D` for long-form).
- Score: `ts_rank_cd` normalised min-max within candidate set.
- Stop-word handling: language-aware via `pg_catalog.english`, `pg_catalog.spanish`, `pg_catalog.french`. Coach profile has `preferred_language` field; tsvector built per language.
- Stemming: PostgreSQL default stemmer. Custom stemming exceptions for fitness terms (`hypertrophy`, `hyrox`, `bjj`).
- Phrase boost: exact phrase match in headline gets 1.5x multiplier.

### 18.2 `vector_sim`

- Computed only when `q` (free-text query) is provided.
- See Section 4 above. Cosine similarity normalised min-max within candidate set.
- Skip-when-no-q: `w_vec` weight zeroed and renormalised.

### 18.3 `geo_decay`

- Formula: `exp(-haversine_km / scale_km)`, `scale_km = 50` default.
- Anchor: requested `lat,lng` from query, OR coach's H3 cell centroid for browse without lat/lng.
- For online-only coaches: `geo_decay = 1.0` if request has no geo filter; `0.5` if request has geo filter (online coaches still discoverable but less prominent).
- For hybrid coaches: same as online if filter is online-allowed; same as in-person otherwise.

### 18.4 `archetype_overlap`

- Jaccard `|A ∩ B| / |A ∪ B|` over archetype set.
- Bonus 0.1 added if any niche-level overlap as well (same archetype + same niche signals tighter match).

### 18.5 `freshness_decay`

- `0.5 ^ (days_since_meaningful_update / 14)`, floor 0.05.
- "Meaningful update" defined in Section 8.

### 18.6 `conversion_prior`

- Bayesian-smoothed apply rate per impression. See Section 3 above.
- Computed nightly per coach; hot updates via stream.
- Decayed at 90 days with half-life 30 days (older signals weighted less).

### 18.7 `personalisation_lift`

- Sigmoid composition over signals. See Section 7.4.
- Range 0..1.
- Multiplied by `w_pers`.

### 18.8 `low_quality_penalty`

- Triggers:
  - profile_completeness_score < 0.4 (less than 40% fields filled).
  - banned_claim_hit in last 30 days.
  - average testimonial age > 365 days AND no recent testimonials.
- Each trigger adds 0.10 to penalty, capped at 0.30.

### 18.9 `suspension_penalty`

- Hard 1.0; coach effectively excluded from `recommended` ranking.
- Implemented as filter, not score subtraction (cleaner).

---

## 19. Worked example

Request: `GET /v1/discover/coaches?archetype=strength&niche=powerlifting&q=natural+powerlifting&lat=30.27&lng=-97.74&radius=50&unit=mi`

Candidate set: coaches with `archetype=strength` AND `niche=powerlifting` AND `h3_cell` within 50mi of (30.27, -97.74) AND `state=ACTIVE` AND `publicListingEnabled=true`.

Suppose candidate set is 87 coaches. K=200 → all kept.

Second-pass for each candidate:

```
text_match    = ts_rank against "natural powerlifting" → 0.62 (normalised)
vector_sim    = cosine sim against query embedding   → 0.71
geo_decay     = exp(-12 / 50)                         = 0.787 (12mi away)
archetype_overlap = |{strength} ∩ {strength}| / 1     = 1.0
freshness_decay = 0.5 ^ (3 / 14)                      = 0.860 (updated 3 days ago)
conversion_prior = (35 + 5) / (1500 + 5 + 200)        = 0.0234
                    normalised within set              = 0.55
personalisation_lift = 0 (no consent)
low_quality_penalty = 0
suspension_penalty  = 0

w renormalised (no personalisation): w_text=0.222, w_vec=0.200, w_geo=0.167,
                                     w_arch=0.133, w_fresh=0.111, w_conv=0.167

score = 0.222*0.62 + 0.200*0.71 + 0.167*0.787 + 0.133*1.0
      + 0.111*0.860 + 0.167*0.55
      = 0.1376 + 0.142 + 0.1314 + 0.133 + 0.0955 + 0.0918
      = 0.7313
```

Sorted descending; featured slots injected post-sort. Response paginated with cursor.

---

## 20. Materialised view DDL (illustrative)

```sql
CREATE MATERIALIZED VIEW discovery_first_pass_v1 AS
SELECT
  cl.coach_id,
  cl.slug,
  cl.archetype_tags,
  cl.niche_tags,
  cl.modality,
  cl.h3_cell,
  cl.country_code,
  cl.starting_price_amount,
  cl.starting_price_currency,
  cl.starting_price_cadence,
  cl.published_at,
  cl.last_active_at,
  GREATEST(cl.updated_at, ach.last_chip_added_at, ts.last_testimonial_at) AS last_meaningful_update_at,
  COALESCE(cs.conversion_prior_smoothed, 0.024) AS conversion_prior,
  COALESCE(rr.refund_rate_trailing_90d, 0) AS refund_rate,
  COALESCE(pc.completeness_score, 0) AS completeness_score,
  to_tsvector('english', coalesce(cl.display_name,'') || ' ' || coalesce(cl.headline,'') || ' ' || array_to_string(cl.niche_tags,' ') || ' ' || array_to_string(cl.archetype_tags,' ') || ' ' || coalesce(cl.about_long_form,'')) AS tsv
FROM coach_listing cl
LEFT JOIN coach_stats cs ON cs.coach_id = cl.coach_id
LEFT JOIN refund_rate_snapshot rr ON rr.coach_id = cl.coach_id
LEFT JOIN profile_completeness_cache pc ON pc.coach_id = cl.coach_id
LEFT JOIN LATERAL (
  SELECT MAX(occurred_at) AS last_chip_added_at FROM verified_achievement WHERE coach_id = cl.coach_id AND state = 'ACTIVE'
) ach ON true
LEFT JOIN LATERAL (
  SELECT MAX(created_at) AS last_testimonial_at FROM testimonial WHERE coach_id = cl.coach_id AND consent_valid = true
) ts ON true
WHERE cl.state = 'ACTIVE' AND cl.public_listing_enabled = true;

CREATE INDEX ON discovery_first_pass_v1 USING gist (tsv);
CREATE INDEX ON discovery_first_pass_v1 (h3_cell);
CREATE INDEX ON discovery_first_pass_v1 (archetype_tags);
CREATE INDEX ON discovery_first_pass_v1 USING gin (niche_tags);
```

Refresh strategy: REFRESH MATERIALIZED VIEW CONCURRENTLY every 5 minutes via cron; on-demand refresh for hot coach updates.

---

## 21. Embedding storage DDL

```sql
CREATE TABLE coach_listing_embedding (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id        TEXT UNIQUE NOT NULL REFERENCES coach(id) ON DELETE CASCADE,
  embedding       vector(1024),
  model_tag       TEXT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_hash     TEXT NOT NULL
);

CREATE INDEX ON coach_listing_embedding USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON coach_listing_embedding (model_tag, computed_at);
```

For 100k+ coaches, increase `lists` to 400, optionally migrate to HNSW.

---

## 22. A/B experiment lifecycle

1. ADMIN creates `RankingExperiment` in DRAFT.
2. ADMIN configures weights_treatment, weights_control, traffic_split (default 50/50).
3. ADMIN starts experiment → `status = RUNNING`, `startedAt = now()`.
4. Visitors bucketed on first impression in experiment scope.
5. Daily metrics computed: primary + guardrails.
6. Bayesian decision rule applied at 14d minimum.
7. ADMIN ends → `status = ENDED` with decision recorded.
8. Rollback path: ADMIN forces `status = ROLLED_BACK`; treatment removed.

Experiments overlap rules:
- Max 3 simultaneous experiments on `recommended` sort.
- Visitors bucketed across experiments via independent hash domains.
- Guardrail failure in any experiment auto-pauses (sends alert, ADMIN must approve continue/end).

---

## 23. Personalisation feature pipeline

```
Event ledger (DiscoveryEvent)  ──► nightly aggregation ──► CoachInteractionFeatures
                               └─► hot stream (5min)   ──► PersonalisationCache (Redis 5min)

Request with consent ─► PersonalisationCache ─► feature vector ─► personalisation_lift ─► score
                  └─► no cache hit ─► default vector (cold-start equivalent)
```

Feature vector contents (consent-gated):
- top_archetypes (last 30d, max 5)
- top_niches (last 30d, max 10)
- recent_geo (country only)
- session_recency_score
- engaged_coach_ids (last 30d, max 20) — for diversity penalty (avoid showing same coach repeatedly)

Diversity penalty:
- If a coach is in `engaged_coach_ids`, ranking score multiplied by 0.85 (slight demotion to encourage discovery).
- If a coach is in `applied_coach_ids` (already applied), demoted by 0.5.

---

## 24. Cost projections

| Component                   | 100 coaches | 1k coaches | 10k coaches |
| --------------------------- | ----------- | ---------- | ----------- |
| First-pass MV refresh       | 1s          | 5s         | 30s         |
| Vector index size           | 0.4 MB      | 4 MB       | 40 MB       |
| Embedding compute (cold-start) | $1/mo    | $10/mo     | $100/mo     |
| Embedding compute (hot path) | $0/mo      | $0/mo      | $0/mo (local) |
| Redis memory                | 100 MB      | 500 MB     | 2 GB        |
| Rank workers (vCPU)         | 2           | 8          | 24          |

Total monthly compute: < $3000 at 10k coach scale (excluding mainline DB).

---

End `recommendation-engine.md`.
