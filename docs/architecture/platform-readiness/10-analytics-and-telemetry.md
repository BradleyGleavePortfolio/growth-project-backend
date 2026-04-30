# 10 — Analytics & telemetry

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Two kinds of data flow today:

- **PostHog** — server-side product events, taxonomy in
  `src/analytics/events.ts` (per `docs/metrics.md`). No-ops
  without `POSTHOG_KEY`. Used for product engagement.
- **OWNER metrics** — `/api/admin/metrics` returns a counter
  envelope (per `docs/metrics.md`). Operator-facing.

Together these support the existing OWNER reports surface
(`src/admin/reports/`).

The next wave needs more from telemetry:

- **Revenue dashboards** want a per-coach + aggregate view of
  MRR, churn, and dunning. Today's PostHog and OWNER metrics
  don't get there alone — the source of truth is the Stripe
  mirror, joined with usage.
- **AI Program Builder** wants per-coach cost and usage
  visibility — both for the OWNER (cost-cap enforcement, lane
  #08) and the coach (their own consumption).
- **Team Mode** wants per-staff attribution on existing events
  (so a team can answer "who closed this client").
- **Mobile-shape telemetry** is needed to honor the lane #02
  Phase-A → Phase-C deprecation rule.
- **Public profiles** want page-view counts.
- **Templates marketplace** wants conversion funnels (template
  view → purchase).

Without an explicit analytics brief, every feature picks its own
event names, identity scheme, and consumer — and the OWNER
reports surface ends up hand-wired to each.

**Cross-feature impact:** every active feature ships some
telemetry.

## WHEN

Settle this brief **before** revenue dashboards leave design and
**before** the first Builder draft event is sent. Mobile-shape
telemetry is needed before the first Phase-C API removal — set
this brief up so that timeline is met.

## WHERE

- `src/analytics/` — PostHog server-side module +
  `events.ts`.
- `src/admin/reports/` — OWNER reports.
- `src/admin/federation/` — cross-product status (already
  feeds OWNER counters).
- `docs/metrics.md` — analytics doc; extend.
- `docs/admin-reports.md` — reports doc; extend.

## WHO

- **Owner:** backend lead.
- **Reviewers:** founder (for product event taxonomy + revenue
  dashboard shape).
- **On the hook in production:** OWNER. PostHog quota is the
  operational concern; the OWNER monitors monthly volume.

## WHAT

### What already exists

- PostHog server-side module + typed event taxonomy in
  `src/analytics/events.ts`.
- OWNER metrics endpoint with counter envelope.
- OWNER reports (CSV+JSON) with privacy contract documented in
  `docs/admin-reports.md` (e.g., no per-record activity in
  clients CSV).
- Cross-product federation envelope.

### What is missing

1. **Identity-stitch policy.** Today every event carries a
   `user_id`. With Team Mode a per-staff event also needs
   `team_id`. With AI Program Builder a draft event needs
   `coach_id` plus `prompt_template_id`. Documented as a
   small required-fields table per event class.
2. **Event taxonomy shape.** Proposed three categories,
   matching lane #06's metric taxonomy:
   - **Lifecycle** events: signup, first invite, first message
     sent, first check-in, first AI draft. One per first-of.
   - **Engagement** events: per surface, per session.
   - **Commercial** events: subscription start, MRR change,
     churn, refund, builder draft cost.
3. **Mobile-shape telemetry.** Each mobile request that reads
   a versioned shape sends back an `X-Tgp-Mobile-Build` header.
   The backend logs, per endpoint, which builds are still on
   the old shape. Used by lane #02's Phase-C decision.
4. **Server-side metrics surface.** OWNER metrics endpoint
   gains a sub-shape per feature:
   - `metrics.billing` — coach counts by status, MRR aggregate,
     dunning aggregate.
   - `metrics.builder` — drafts/coach/month, cost/coach/month,
     fallback-rate (deterministic vs real provider).
   - `metrics.team` — teams, members, active-team-share.
   - `metrics.engagement` — DAU/WAU/MAU per surface.
5. **Revenue dashboards read-model.** A documented SQL view
   (or a Prisma-side aggregate) that joins
   `CoachSubscription` × `Invoice` × `PaymentFailure` × the
   per-coach engagement counters into one envelope. This is
   the source of truth for the dashboards. The view itself is
   future runtime work; the brief reserves the shape.
6. **Per-coach visibility.** Today coaches don't see their own
   numbers. Future: a coach-facing "your dashboard" surface
   reads from the same envelope as the OWNER per-coach drill-in,
   filtered to that coach. Out-of-scope for the runtime PR
   that descends from this brief, but the read-model is shaped
   to allow it.
7. **PII posture.** PostHog events MUST NOT include client PII
   (names, emails, body text). Today this is convention; this
   brief makes it a contract enforced by the typed event
   taxonomy. Lane #03 (security) is the place this lives in
   the threat model.

### Required-fields table (proposed)

| Event class | Required | Optional |
|---|---|---|
| Lifecycle | `user_id`, `event`, `at` | `coach_id`, `team_id` |
| Engagement | `user_id`, `surface`, `event`, `at` | `coach_id`, `team_id`, `mobile_build` |
| Commercial | `user_id`, `coach_id`, `event`, `amount_cents`, `currency`, `at` | `team_id`, `prompt_template_id`, `cost_usd` |

The TypeScript event taxonomy in `src/analytics/events.ts`
asserts these shapes at compile time.

## HOW

### Operator handoff

- The OWNER metrics endpoint returns the multi-section
  envelope above. `docs/metrics.md` is extended with the
  shape.
- The revenue dashboard read-model is a SQL view (or Prisma
  aggregate) defined once and consumed by the OWNER drill-in
  route. Adding a new dimension means editing the view, not
  adding a new endpoint.
- PostHog quota is monitored monthly; OWNER alerts when 80% of
  the quota is consumed (lane #06).

### Mobile-shape telemetry

`X-Tgp-Mobile-Build: <build-version>` header on every mobile
request. The auth interceptor records it (no body content; just
the build string + the route + the response status). Logged
only — no persistence. The build-vs-route distribution is
exported via a daily aggregation that lands in the OWNER
metrics envelope.

The build header is opt-in: mobile sets it; web does not. No
backend behavior depends on the header (never a routing
decision).

## Risks

- **PostHog quota exhaustion.** Mitigation: typed taxonomy
  forbids per-token Builder events; aggregation is a counter,
  not a row. Quota monitored.
- **PII in events.** Mitigation: typed event interfaces forbid
  PII fields by construction; tests assert.
- **OWNER metrics envelope grows unboundedly.** Mitigation:
  one section per feature; new sections are reviewed at brief
  level.
- **Revenue dashboard correctness drift.** Mitigation: the SQL
  view is the single source of truth; tests fix the
  expected values for a fixture set of coaches.

## Dependencies

- Lane #02 (API versioning) — mobile-shape telemetry feeds
  Phase-C decisions.
- Lane #03 (security) — PII contract for events lives in
  lane #03's threat model.
- Lane #05 (billing) — revenue dashboards read from billing
  mirrors.
- Lane #06 (observability) — metric taxonomy (RED/USE/Product)
  cross-references the event-taxonomy here.
- Lane #08 (AI governance) — Builder cost/coach/month is the
  canonical AI commercial metric.

## Acceptance criteria

1. ✅ `docs/metrics.md` is extended with the required-fields
   table and the OWNER metrics envelope sub-shape.
2. ✅ `src/analytics/events.ts` is extended with the typed
   shapes for the three categories (runtime PR; not this docs
   PR).
3. ✅ Mobile-shape telemetry is documented (header name,
   what's logged, what isn't).
4. ✅ The revenue dashboard read-model shape is documented
   (the SQL view definition is reserved for a future runtime
   PR).
5. ✅ PII posture for events is documented, cross-referenced
   from lane #03.

## Test strategy

- **Unit:** typed event interfaces have unit tests asserting
  PII fields are absent.
- **Integration:** OWNER metrics endpoint has a test asserting
  the multi-section envelope shape (initially with empty
  sections; sections fill in as features ship).
- **Manual:** OWNER spot-checks revenue dashboard numbers
  against Stripe directly during the first month after
  launch.

## Rollout & kill-switch

- New event classes ship behind their feature flag (lane #01).
  Flipping the flag suppresses the events.
- PostHog kill switch: `POSTHOG_KEY=""` (module no-ops).
- Mobile-build header: opt-in by client; backend never depends
  on it.
- Revenue dashboard kill switch: the read-model is OWNER-only
  initially; making it coach-facing requires its own runtime
  PR with its own flag.
