# Admin console — data-feed glossary

> Companion to [`./data-feed-rfc.md`](./data-feed-rfc.md). Terminology
> the RFC introduces, in alphabetical order, with the §-anchor of the
> first definition. Reach for this when an unfamiliar term appears in a
> PR description or a runtime author asks "what does *X* mean."
>
> Docs only. No runtime artefact.

---

## Archetype

A coarse classification of how a coach uses the platform: `trainer`,
`gym`, `influencer`, `info_seller`. Single-valued per coach in v1.
Lives on `CoachProfile.archetype` once the Wave 2 author adds the
column. **Reservation** — the column does not yet exist; the data-feed
RFC's archetype work is gated on the Wave 2 schema landing.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §3.2.

## Capability hash

A short hash mixed into every Redis cache key to ensure two operators
with different RBAC capability sets do not share cache entries.
Without this, an operator with `view:cohort = false` could be served a
cached payload populated for an operator with `view:cohort = true` —
the second payload contains cohort breakdowns the first should never
have seen. The hash is a SHA-256 of the sorted list of capabilities
the operator's token bears, truncated to the first 8 hex characters.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §9.3, §13.4.

## Cohort

A named set of users (coaches and/or clients) defined by a
deterministic rule over the live schema. Cohort membership is
recomputed on read; there is no `Cohort` materialisation table in v1.
Cohort types are a closed enum in this RFC: `signup`, `archetype`,
`tier`, `org`, `client_program`, `client_milestone`, `client_at_risk`,
`client_signup`. New types require a schema-aware change.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §3.

## Cohort intersection

What looks like "two cohorts" applied to the same screen ("L2 trainers
signed up in 2026-Q1") is in this RFC a **cohort plus a segment**, not
two cohorts. The scope tuple has one cohort axis. Intersections are
handled by the segment slicer.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §3.6.

## Compare-to-previous

A second result block in the feed envelope, returned alongside the
current window's payload, computed against the prior window of equal
length (or the same window one calendar year earlier). The frontend
renders deltas; the server never computes the diff.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §4.5.

## Cursor

An opaque base64url-encoded JSON literal carrying the sort key, sort
value, and tiebreak ID for cursor-paginated list endpoints. Stateless
on the server. Validated against the requested sort key so a cursor
issued under one sort cannot be replayed under another.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §7.4.

## Drilldown

The act of pushing a new frame onto the scope stack. The new frame's
scope axes are equal to or narrower than every parent axis (the
"monotonically narrowing" invariant). Drilldowns are reversible by
popping the stack.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §6.2.

## Facet

One field of a segment slicer (archetype, tier, plan, status, is-org,
region). Facets are independently clearable. Multi-select within a
facet is OR; across facets is AND.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §5.

## Feed envelope

The wire shape every scope-aware GET endpoint returns:
`{ scope, current, compare, pagination, meta }`. Stable across screens
so the frontend's render contract is small.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §7.2.

## Frame

A single `(screen, scope, pushed_at)` triple in the scope stack.
Frames are created on drilldown, dropped on pop or rebase. The current
frame is the top of the stack.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §6.1.

## Granularity

Bucket size for time-series payloads: `hour`, `day`, `week`, `month`,
`quarter`. UTC bucket boundaries; locale-aware labels in the
frontend. Retention matrix is fixed at month granularity.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §4.1, §4.6.

## Materialised view

A Postgres-side pre-computed view, refreshed by cron, used for
expensive aggregations (cohort retention matrix, MRR breakdown by
plan/coach/month). Carries a visible `meta.generated_at` so operators
see freshness. Two materialised views are reserved in v1 (§8.3); only
the retention view is recommended for v1 ship (Q4).

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §8.3, Q4.

## Org-cohort

The tree of users rooted at a head coach: head + sub-coaches + their
clients + the head's direct clients. Expanded server-side via a single
endpoint (`§11.P-org-tree`); frontend never walks the tree itself.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §3.4, §15.3.

## Person-frame

A scope frame whose `person` axis is set (a `user_id`). Pushing a
person-frame triggers an `admin.profile.read` audit row; cohort frames
do not audit. The audit boundary aligns with the person-frame
boundary.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §11.3, §12.3.

## Rebase

The act of replacing one or more top-of-stack frames when an operator
clicks a chip that *widens* an axis (vs narrows it on a normal push).
Rebase preserves the monotonically-narrowing invariant.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §6.2.

## Scope

The four-axis tuple every screen renders against:
`(time × cohort × segment × person)`. Each axis is independent. Empty
axes are first-class states (e.g. `cohort = null` means platform-wide).

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §2.1.

## Scope bar

The scope-axis chip strip rendered above every screen's data area.
Always visible, always editable, always echoed into the URL. Same
component on every screen; only the dropdown contents per chip differ.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §2.2.

## Scope hash

A canonicalised SHA-256 of the four scope axes, used in cache keys
(§9.3) and audit metadata (§12.3) so operators with the same scope
share cache entries and forensic reviewers can correlate audit rows
back to a cohort-shaped read without recording the cohort's contents.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §9.3, §12.3.

## Scope stack

A typed list of scope frames, capped at eight, serialised to the URL
fragment. Powers the back-in-context navigation contract. Lives in
`localStorage` for cross-reload restore; never persisted server-side
in v1.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §6.

## Segment

A faceted filter on top of a cohort. Segments narrow; cohorts define
the universe. Identity is structural — two segments with the same
facet/value pairs are the same segment.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §5.

## Single-flight

A cache primitive: when N requests for the same cold key arrive
simultaneously, only one issues the underlying fetch; the rest wait
on the in-flight promise. Prevents cache stampede on cold start.
Provided by the `cache-manager` module already in use; we enable
`singleFlight` per feed endpoint.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §9.4.

## Soft-expire

A cache primitive: when a key is within 10% of its TTL, the next
reader recomputes asynchronously and is served the still-warm value.
The asynchronous recompute warms the cache for the next reader.
Canonical "stale-while-revalidate" pattern.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §9.4.

## SSE — server-sent events

The realtime mechanism for the Overview screen, the recent-activity
strip, and the health-strip pills. One-way HTTP/2 stream from server
to client. Client reconnects with `Last-Event-Id` on disconnect.
Picked over WebSocket because we never need to push from the client
on the stream.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §10.

## TBD-admin-P-*

Placeholder slot names for the new gap-closing endpoints introduced
by this RFC, namespaced `P` so they sit alongside the canonical
spec's `A..O`. Real PR numbers are cut at branch-cut time per the
operator-handoff contract in
[`./pr-sequence.md`](./pr-sequence.md) §3.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §15.

## Tier

The three SaaS coaching tiers: `L1` (default), `L2` (mastermind),
`L3` (top mastermind). Derived from `Entitlement` rows; no new
column. The tier cohort is computed via a `CASE WHEN ... END` over
the entitlement set.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §3.3.

## Time window

A `(granularity, since, until, compare_to)` tuple. Half-open at
`since`, exclusive at `until`. UTC throughout. The compare-to
direction is one of `previous_period`, `previous_year`, `none`.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §4.2.

## Wrap (endpoint posture)

One of three reconciliation postures for existing endpoints (the
others being `keep` and `deprecate`). A wrapped endpoint accepts new
scope query parameters and returns the new feed envelope when they
are present; absent the new parameters it reproduces today's
behaviour byte-for-byte.

See: [`./data-feed-rfc.md`](./data-feed-rfc.md) §14.

---

## Cross-references

- [`./data-feed-rfc.md`](./data-feed-rfc.md) — the RFC this glossary
  serves.
- [`./control-room-spec.md`](./control-room-spec.md) — the canonical
  screen spec. Terminology there is the canonical source where it
  overlaps; this glossary is additive, not contradictory.
- [`./deployment-and-rbac.md`](./deployment-and-rbac.md) — capability
  vocabulary (`view:*`, `act:*`).
- [`./pr-sequence.md`](./pr-sequence.md) — the `TBD-admin-A..O` slot
  table the §11.P-* rows in §15 of the RFC extend.
