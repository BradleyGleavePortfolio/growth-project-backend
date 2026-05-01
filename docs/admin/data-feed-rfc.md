# Admin console — data-feed RFC for cohort drilldown architecture

> **Status:** docs-only RFC, draft, no runtime code. Companion to the
> Wave 1 admin console specs in this directory:
> [`control-room-spec.md`](./control-room-spec.md),
> [`deployment-and-rbac.md`](./deployment-and-rbac.md),
> [`pr-sequence.md`](./pr-sequence.md),
> [`screens-addendum.md`](./screens-addendum.md).
>
> **Cross-PR dependency.** This RFC layers on the Wave 1 reconciliation
> filed as PR #130 (`docs/admin-console-canonical`). It assumes the four
> Wave 1 files above land at `docs/admin/`. If PR #130 is closed in
> favour of a different reconciliation, every cross-reference here that
> cites a §11 letter or a §17 phase number is restated against the new
> canonical document; the architectural decisions in this RFC do not
> change.
>
> **Audience.** Backend engineers implementing the `TBD-admin-A..O`
> runtime slots in [`pr-sequence.md`](./pr-sequence.md), and the
> frontend team building `tgp-admin-web`. This document defines **how**
> the data flows; the canonical control-room spec defines **what**
> screens exist.
>
> **What this is not.** Not a screen spec. Not a UI design. Not a
> component library. Not a Prisma schema patch. Every named table and
> field below either already exists in the live schema (cited from the
> [audit-backend](#references)) or is a reservation already declared in
> [`pr-sequence.md`](./pr-sequence.md) §3 — this RFC introduces zero
> new schema names.

---

## §1. Goals and non-goals

### 1.1 Goals

1. Define a single, reusable **scope-bar pattern** that every screen in
   the admin console layers on top of: every screen carries a scope
   tuple of `(time-window × cohort × segment × person)` and every
   network call honours that tuple unchanged.
2. Specify how the existing `/api/admin/*` endpoints (cited in
   [`control-room-spec.md`](./control-room-spec.md) §11.0) compose into
   a coherent feed contract without a v2 cutover.
3. Define a **scope-stack** data model that turns zoom-out → zoom-in
   navigation into a stack of typed frames, URL-serialisable end-to-end,
   so every drilldown is shareable, bookmarkable, and reversible.
4. Specify **cohort taxonomy** (signup-cohort, archetype, tier, org,
   client-cohort) at the level of query-parameter shapes and the
   indexes they require.
5. Specify the **time-window contract** (granularity, default windows
   per screen, compare-to-previous semantics, retention timeframes).
6. Specify the **caching layer** (Redis TTLs per cohort type,
   cache-bust events, cache-stampede protection) so the control room
   stays sub-second at 1k coaches × 10k clients.
7. Specify the **streaming/realtime decision** screen-by-screen so the
   Overview KPIs and the recent-activity strip can update without
   collapsing into per-second polls.
8. Reconcile every existing admin endpoint to a feed-contract role
   (keep / wrap / extend) with no deprecations and no breaking changes.
9. Surface every architectural decision the user must validate as
   numbered open questions in §19, with our recommendation each.

### 1.2 Non-goals

1. **Not** a per-tenant scoping model. OWNER is platform-wide. Same
   posture as [`deployment-and-rbac.md`](./deployment-and-rbac.md) §3.
2. **Not** a new auth model, cookie strategy, or session shape.
3. **Not** a SQL schema rewrite. Where this RFC names a table or a
   field, it is either already in `prisma/schema.prisma` today or
   reserved by name in [`pr-sequence.md`](./pr-sequence.md) §3.
4. **Not** a frontend framework decision. The frontend lives in the
   future `tgp-admin-web` repo; the contract this RFC defines is wire-
   level, not framework-level.
5. **Not** a replacement for `/api/admin/reports` (the manifest-driven
   CSV/JSON downloader). Reports are the no-realtime, no-pagination,
   manifest path; the feed contract is the interactive path. They
   coexist.
6. **Not** a multi-region or sharded deployment plan. Single Postgres,
   single Redis, single Fly region — as today.

---

## §2. Mental model — the scope bar

### 2.1 The four-axis scope tuple

Every screen in the admin console is a function of one tuple:

```
Scope := {
  time:    TimeWindow,         // §4
  cohort:  CohortRef | null,   // §3
  segment: SegmentRef | null,  // §5
  person:  PersonRef | null    // §6
}
```

The four axes are **independent** but **monotonically narrowing**:
narrowing one axis never widens another. The Overview screen renders
with `cohort = null`, `segment = null`, `person = null` and a default
time window. Clicking a coach on the Coaches table pushes `person`.
Clicking the *Trainers* archetype chip on Finance pushes `cohort`.
Filtering Coaches by *L2 tier* pushes `segment`.

The **order of axes is significant** for URL serialisation (§6.4) but
**not** for query semantics: applying `time` then `cohort` produces the
same result set as `cohort` then `time`. This invariant is enforced
server-side.

### 2.2 The scope bar UI primitive

Every screen renders a horizontal scope bar above the dense data area:

```
┌────────────────────────────────────────────────────────────────────┐
│  [  Last 30 days  ▾ ]  [  All coaches  ▾ ]  [  All segments  ▾ ]   │
│  [  No person  ]                                  [ Compare ▾ ]    │
└────────────────────────────────────────────────────────────────────┘
```

The bar is **always visible**, **always editable**, and **always
echoed in the URL**. This is the `Scope` literal serialised — see §6.4.

The four chips map to the four scope axes. Each chip is a typed
combobox; the dropdown content is screen-specific (the Coaches screen's
`cohort` chip offers archetypes and tiers; the Finance screen's offers
plans and intervals). The same component renders the same chips on
every screen — the dropdown contents differ, the contract does not.

### 2.3 Why a scope, not a filter

A filter is a per-screen attribute on a per-screen list endpoint. A
scope is a cross-screen identity: the same `Scope` literal that drives
the Coaches table also drives the Finance MRR breakdown when an
operator clicks **"see finance for this cohort"**. The scope-stack
(§6) makes this explicit — the back-navigation contract is "pop the
top frame," not "navigate back in browser history and lose the
filters."

### 2.4 The `none` cases are not synthetic

When a chip is empty (`cohort = null`, etc.), the screen is rendering
the platform-wide aggregate. The aggregate is never synthesized from
per-cohort numbers; it is an authoritative query over the unscoped
universe. This is the same posture
[`control-room-spec.md`](./control-room-spec.md) §3.5 uses for the
health-strip pills — degraded states surface as an explicit `status`,
never as zero or a missing field. The same rule applies to scope: the
absence of a cohort is a first-class state, not a sentinel value the
feed has to detect.

---

## §3. Cohort taxonomy

A **cohort** is a named set of users (coaches and/or clients) defined
by a deterministic rule over the live schema. Cohort membership is
recomputed on read, not stored — there is no `Cohort` materialisation
table in v1. The cost of recomputation is bounded by the indexes called
out in §8.

The taxonomy below is the canonical set. New cohorts added later
extend the same enum-shaped contract; new cohort *types* require a new
enum value and a new server-side rule.

### 3.1 Signup-cohort

```
SignupCohort := { type: "signup", year: int, month: int }    // 1..12
```

Membership rule: `User.created_at` falls in `[year-month-01, next-month-01)`.

Used by the Finance retention matrix (gap §11.M) and the coach-cohort
delta (gap §11.B). This is the cohort that does *not* require a new
column — `User.created_at` is shipped.

### 3.2 Archetype-cohort

```
ArchetypeCohort := { type: "archetype", value: ArchetypeKey }
ArchetypeKey   := "trainer" | "gym" | "influencer" | "info_seller"
```

Membership rule: `CoachProfile.archetype = value`.

The four archetype keys come from the Wave 2 positioning work (the
"Whop AI for trainers, gyms, influencers, info-sellers/coaches"
framing recorded in
[`PERP_HANDOFF.md`](../../PERP_HANDOFF.md) Session 2026-05-01).
**Reserved-name-only** at the moment: `CoachProfile.archetype` is **not
yet** a column on the live schema. Adding it is a runtime task the
Wave 2 author owns; this RFC documents the contract so the runtime PR
can land without an admin-console schema discussion. Until that
column ships, the archetype chip on the Coaches and Finance screens
is hidden — same `not_yet_available` posture
[`control-room-spec.md`](./control-room-spec.md) §11 uses elsewhere.

### 3.3 Tier-cohort

```
TierCohort := { type: "tier", value: TierKey }
TierKey   := "L1" | "L2" | "L3"
```

Membership rule: derived from the entitlements view in
`docs/entitlements.md` — coaches with no L2/L3 grant are `L1`, coaches
with the `mastermind_l2` grant are `L2`, coaches with the
`mastermind_l3` grant are `L3`.

Implementation: this is a `CASE WHEN ... END` over `Entitlement` rows.
No new column. The query layer (§8.3) defines the projection once and
every cohort-aware endpoint reuses it.

### 3.4 Org-cohort

```
OrgCohort := { type: "org", head_coach_user_id: UUID }
```

Membership rule: `User.coach_id = head_coach_user_id`
**OR** `User.id IN (sub_coach_ids of head_coach_user_id)`.

The org-cohort is a **tree**, not a flat set. The head coach plus their
sub-coaches plus all clients-of-sub-coaches plus all clients-of-head-
coach form the org. Sub-coach hierarchy is a Wave 2 spec — see the
sub-coach-hierarchy doc the Wave 2 author owns. This RFC's
contribution is the wire shape:

```
GET /api/admin/feed/org/:head_coach_user_id/tree
→ {
    head: { user_id, display_name, ... },
    sub_coaches: [
      { user_id, display_name, client_count, mrr_cents, ... },
      ...
    ],
    direct_clients: [ { user_id, display_name, ... }, ... ],
    rollups: { total_clients, total_mrr_cents, total_arr_cents, ... }
}
```

Every cohort-aware endpoint that takes `cohort=org:<head_coach_user_id>`
expands this tree on the server. The frontend never walks the tree
itself.

### 3.5 Client-cohort

```
ClientCohort :=
  | { type: "client_program",       program_id: UUID }
  | { type: "client_milestone",     milestone_id: UUID }
  | { type: "client_at_risk",       since_days: int }
  | { type: "client_signup",        year: int, month: int }
```

The first three depend on Wave 2 (Programs, Milestones, At-Risk
detector). Same `not_yet_available` posture as §3.2 until those rails
ship. The fourth is symmetric with §3.1 over the client-only universe.

### 3.6 Cohort intersections

The scope tuple has **one** cohort axis, not two. Operators frequently
want to see "L2 trainers signed up in 2026-Q1." That is a **segment**
on top of a **cohort**, not two cohorts. The segment slicer (§5) is the
right tool — `cohort = signup:2026-01` (or 02, 03), `segment = { tier:
L2, archetype: trainer }`. Allowing two cohort axes would explode the
endpoint matrix without paying for itself; the segment dimension
already covers it.

### 3.7 Cohort identity in URLs

Cohorts serialise to a `cohort` query param using the typed shorthand:

| Cohort type | URL form |
|---|---|
| signup | `cohort=signup:2026-03` |
| archetype | `cohort=archetype:trainer` |
| tier | `cohort=tier:L2` |
| org | `cohort=org:<uuid>` |
| client_program | `cohort=program:<uuid>` |
| client_milestone | `cohort=milestone:<uuid>` |
| client_at_risk | `cohort=at_risk:30` |
| client_signup | `cohort=client_signup:2026-03` |

Every cohort-aware endpoint accepts the same shorthand. Servers parse
it once via a shared `parseCohortRef(s: string): CohortRef` helper —
§7.5 covers the error envelope when the shorthand is malformed.

---

## §4. Time-window contract

### 4.1 Granularities

```
Granularity := "hour" | "day" | "week" | "month" | "quarter"
```

Bucket boundaries are UTC. Operators in non-UTC timezones see a
locale-aware label (§12 of the canonical spec), but the underlying
bucket math is UTC. This avoids DST and timezone-rollover bugs at the
cost of a one-line label translation in the frontend.

### 4.2 Window shape

```
TimeWindow := {
  granularity: Granularity,
  since:       ISO8601,
  until:       ISO8601,
  compare_to:  "previous_period" | "previous_year" | "none"
}
```

`since` and `until` are **inclusive** at `since` and **exclusive** at
`until` — the standard half-open interval. `compare_to = "previous_
period"` shifts both endpoints by the window length and emits a second
result block under `compare`. `previous_year` shifts by 365 days
exactly (not "this date last year") to dodge leap-year and Feb-29 edge
cases. `none` skips the comparison block entirely.

### 4.3 Default windows per screen

| Screen | Default `granularity` | Default window | `compare_to` default |
|---|---|---|---|
| Overview | day | last 30 days | previous_period |
| Coaches | day | last 30 days | none |
| Clients | day | last 30 days | none |
| Person profile | day | last 90 days | none |
| Finance | month | last 12 months | previous_year |
| Product usage | day | last 30 days | previous_period |
| Audit | day | last 7 days | none |
| Reports | n/a (manifest-driven) | n/a | n/a |

These are anchored in the canonical control-room spec §3–§10. Where
this RFC and the canonical spec disagree on a default, the canonical
spec wins; this RFC is updated.

### 4.4 Custom range

The scope-bar time chip exposes presets (`Last 7 days`, `Last 30 days`,
`Last 90 days`, `Last 12 months`, `YTD`) plus a custom range picker
(`From → To`). Custom ranges set `compare_to = "none"` by default;
the operator can enable `previous_period` explicitly.

### 4.5 Compare-to-previous wire shape

The feed envelope (§7.2) carries a `current` block and an optional
`compare` block:

```
{
  scope: { time, cohort, segment, person },
  current:  { ... screen-specific payload ... },
  compare:  { ... same shape, against the comparison window ... } | null,
  meta:     { generated_at, cache_hit, request_id }
}
```

The frontend renders deltas and arrows by subtracting `compare` from
`current` field-by-field. The server **never** computes the delta; it
returns both blocks and lets the frontend render the diff. Reasoning:
deltas are render-layer concerns (formatting, sign, percent vs
absolute) and computing them server-side doubles the test surface.

### 4.6 Retention timeframes

Cohort retention (gap §11.M) uses a **months-out matrix**:

```
RetentionMatrix := {
  granularity: "month",
  cohorts: [
    {
      cohort: SignupCohort,
      months: [
        { offset: 0,  retained: int, churned: int },
        { offset: 1,  retained: int, churned: int },
        ...
        { offset: 12, retained: int, churned: int }
      ]
    },
    ...
  ]
}
```

`offset = 0` is the cohort's signup month; `retained` at offset N is
the count still on a non-cancelled `CoachSubscription` at the end of
month N. The retention endpoint is one of the few that does **not**
accept arbitrary `granularity` — month is the only meaningful unit for
cohort retention, and exposing `day` would invite operators to compute
nonsense.

---

## §5. Segment slicers

### 5.1 What a segment is

A **segment** is a faceted filter on top of a cohort. Segments narrow
the result set; cohorts define the result set's universe. Segment
identity is structural, not nominal — two segments with the same field/
value pairs are the same segment.

```
SegmentRef := {
  type: "compound",
  facets: {
    archetype?: ArchetypeKey,
    tier?:      TierKey,
    plan?:      string,        // CoachSubscription.plan_key
    status?:    "active" | "past_due" | "canceled" | "trialing",
    is_org?:    boolean,        // head coach with sub-coaches
    region?:    string          // CoachProfile.region — Wave 2 reservation
  }
}
```

Every facet is optional. An empty `facets` object is equivalent to
`segment = null`. The list of facets is closed; new facets require a
schema migration and a new key in this enum.

### 5.2 Faceted-filter UX

The scope-bar's segment chip opens a multi-facet dropdown:

```
┌────────────────────────────────────┐
│  Archetype  [ trainer × ]  ▾       │
│  Tier       [ L2 × ] [ L3 × ]  ▾   │
│  Plan       [ growth-monthly × ]   │
│  Status     [ active × ]  ▾        │
│  Is org     ◯ Yes  ● No  ◯ Either  │
│  Region     [ all ]  ▾              │
│                            [Apply] │
└────────────────────────────────────┘
```

Each facet is independently clearable. **Multi-select within a facet
is OR**; **across facets is AND**. So
`archetype=[trainer] AND tier=[L2,L3]` means *trainers on L2 or L3*,
not *trainers AND L2 AND L3*.

### 5.3 Query parameter convention

```
?segment.archetype=trainer
&segment.tier=L2,L3
&segment.plan=growth-monthly
&segment.status=active
```

Comma-separated values inside one facet; one query parameter per facet.
The server parses every `segment.*` param into the `SegmentRef.facets`
object and rejects unknown facet names with HTTP 400 (§7.5).

### 5.4 Server-side denormalisation rules

Segments narrow on the **server**, not the frontend. The frontend's job
is to produce the URL; the server's job is to translate the URL into
SQL. Two reasons:

1. The data set is too large to ship to the client and filter there
   (Coaches table at 1k rows × 30 indicators each = 30k cells already).
2. RBAC and audit-on-read happen server-side. Filtering on the client
   would mean serving rows the operator's capability does not authorise
   them to read, and we already know that does not end well.

Concretely: every server endpoint that accepts a `segment` query
parameter compiles the `facets` object into a Prisma `where` clause
once, applies it before pagination, and only then computes any roll-up
or aggregate.

---

## §6. Drilldown navigation — the scope stack

### 6.1 The scope-stack data model

The scope-stack is a typed list of frames. Each frame is a complete
`Scope` literal plus the screen identifier it was rendered against:

```
ScopeFrame := {
  screen: ScreenId,              // "overview" | "coaches" | "clients" | ...
  scope:  Scope,                 // §2.1
  pushed_at: ISO8601
}
ScopeStack := ScopeFrame[]
```

Frames are pushed when the operator drills in (clicks a cohort, opens
a person, etc.) and popped when the operator clicks the **back-in-
context** affordance. The browser back button is *not* the back-in-
context affordance — see §6.5.

### 6.2 Push semantics

Drilldowns push a **new frame**, never mutate the current frame. The
top-of-stack is always the screen the operator is currently viewing.
Pushing has the following invariant: the new frame's `Scope` axes
**dominate** the parent's — they are equal to or narrower than every
parent axis. Concretely:

```
push(parent: ScopeFrame, next: ScopeFrame) requires:
  next.scope.time      ⊆ parent.scope.time
  next.scope.cohort    ⊑ parent.scope.cohort     // null is the top
  next.scope.segment   ⊑ parent.scope.segment
  next.scope.person    ⊑ parent.scope.person
```

If the operator clicks a chip that *widens* an axis, the stack is
**rebased**: every frame between the current top and the rebase target
is dropped, and the new frame replaces them. This is identical to how
breadcrumb-style navigation collapses when you click a parent
breadcrumb.

### 6.3 Pop semantics

Pop returns to the previous frame's `Scope`, restoring its time
window, cohort, segment, person. Pop is **not** a browser-history
operation — it is a logical operation the front-end performs on its
own state.

### 6.4 URL-state contract

The scope stack serialises into the URL **fragment**, not the path or
the query string:

```
/admin/<screen>?<facets>#stack=<base64url-json-of-scope-stack>
```

- Path identifies the current screen.
- Query string carries the *current frame's* scope axes (so a server-
  side prefetch can hydrate the screen without parsing the fragment).
- Fragment carries the *full stack* so the back-in-context button has
  somewhere to pop to.

The fragment is a base64url-encoded JSON literal of the `ScopeStack`,
truncated to a maximum of **eight** frames (operator-tested ceiling —
beyond eight, operators forget where they came from). When the stack
exceeds eight frames, the bottom frame is dropped on push.

Why fragment, not query: the fragment is **not sent to the server**,
which is appropriate — the stack is operator-side state. The query
string carries what the server needs to compute the current view; the
fragment carries the operator's history. Same separation a multi-pane
text editor uses for "currently visible buffer" vs "buffer history."

### 6.5 Back-button semantics

- **Back-in-context button** (in the breadcrumb) — `pop()` on the
  scope stack. Stays on the same browser-history entry. **This is the
  primary navigation control.**
- **Browser back button** — `window.history.back()`. The frontend
  intercepts and treats it as `pop()` *if* the previous fragment is a
  prefix of the current fragment (i.e. the operator only zoomed in,
  never sideways-navigated). Otherwise it falls through to a normal
  history pop, which lands on a different `(screen, scope)` pair.
- **⌘← / Alt+←** — same as the back-in-context button.

### 6.6 Shareable URLs

The full URL (path + query + fragment) is sufficient to reconstruct the
operator's view. Two operators sharing the URL see identical data
modulo their RBAC capabilities (§13). The "copy share link" affordance
in the canonical spec §12 produces this URL verbatim.

### 6.7 Scope-stack persistence

The frontend persists the most recent stack to `localStorage` under
`tgp.admin.scope.stack.v1`. On cold reload it hydrates and restores
the operator's last view. This is **never** persisted server-side —
the stack is operator-private and expressing it in audit-on-read
metadata would breach the no-PII-in-logs invariant (§12).

A future server-side persistence (gap **§11.P-scope-stack** in §15
below) is the only way to support cross-device handoff. Out of scope
for v1.

---

## §7. Endpoint contract

### 7.1 Decision: per-screen endpoints, not a unified `/feed` family

We considered three shapes:

1. **Unified feed.** One `POST /api/admin/feed` endpoint that accepts
   an arbitrary `(screen, scope)` and returns whatever blob that view
   requires.
2. **Per-screen endpoints.** Existing `/api/admin/coaches`,
   `/api/admin/clients`, `/api/admin/finance/*`, etc. extended with a
   common scope parameter set.
3. **Hybrid.** Unified entrypoint for cross-screen aggregates;
   per-screen endpoints for the primary tables.

We choose **(2) per-screen endpoints**, with one extension: a small
`/api/admin/feed/scope/*` family for cross-screen primitives that have
no natural per-screen home (cohort tree, scope-stack persistence
adapters, etc.). Reasons:

- (1) is a generic GraphQL-shaped surface in a non-GraphQL repo.
  Existing endpoints already exist; rebuilding them under one router
  doubles the test matrix.
- (1) hides the per-endpoint cache key shape behind one router, which
  collapses cache invalidation into per-router invalidation. Cache
  granularity is a feature (§9), not a defect.
- (3) is what we'd build if we were starting from scratch.
- (2) is what survives a six-month review of "did we make the wrong
  call." Existing endpoints stay; new endpoints follow the same shape.

### 7.2 The feed envelope

Every endpoint that accepts a scope returns the **feed envelope**:

```
{
  "scope": {
    "time":    { "granularity": "...", "since": "...", "until": "...", "compare_to": "..." },
    "cohort":  { ... } | null,
    "segment": { "facets": { ... } } | null,
    "person":  { "user_id": "..." } | null
  },
  "current": { /* screen-specific payload */ },
  "compare": { /* same shape as current */ } | null,
  "pagination": {
    "next_cursor": "..." | null,
    "limit": 50
  } | null,
  "meta": {
    "generated_at": "ISO8601",
    "cache_hit":    true | false,
    "request_id":   "..."
  }
}
```

Every field is required (`null` for absent). The envelope's stability
is what makes the frontend's render contract small: it switches on
`current` and ignores the rest.

### 7.3 Existing endpoints stay

The seven shipped admin endpoints listed in
[`control-room-spec.md`](./control-room-spec.md) §11.0 keep their
current paths and current response shapes. New scope parameters are
**additive** — sending none reproduces today's behaviour byte-for-byte.
This is the no-deprecation rule. See §14 for the per-endpoint
reconciliation.

### 7.4 Cursor pattern

List endpoints use opaque cursors. The cursor is base64url-encoded JSON:

```
{ "k": "<sort_key>", "v": "<sort_value>", "id": "<tiebreak_id>" }
```

`<sort_key>` is the field the list is sorted on (`created_at` for the
audit log, `last_seen_at` for the Coaches table, etc.). `<sort_value>`
is the value to compare against. `<id>` breaks ties on duplicate sort
values. The server validates the cursor's shape against the requested
sort, returns HTTP 400 on mismatch (e.g. cursor was issued for
`created_at` but the request sorts by `name`).

Cursors are **stateless** — the server holds no cursor table. This
matches the `/api/admin/audit-log` cursor shape already in the live
codebase; we extend it across the rest of the feed.

### 7.5 Error envelope

Every error response is shaped like the existing admin error response:

```
{
  "error": {
    "code":    "string",         // e.g. "scope.cohort.malformed"
    "message": "string",         // operator-readable; never PII
    "request_id": "string",
    "details": { ... }
  }
}
```

Error codes are **dotted** and are stable identifiers the frontend
matches against to render the right inline message. The
`docs/admin/data-feed-glossary.md` companion document lists every
introduced code.

### 7.6 Idempotency

GET endpoints in the feed family are idempotent and cache-safe (§9).
POST endpoints (mutations) follow the existing admin convention:
unique `Idempotency-Key` header; the controller class is
`@Roles('owner')` gated; the `AuditService.write` call lands a row.

### 7.7 Versioning

The feed contract is **v1**. The version lives in the URL path under
`/api/admin/feed/v1/...` for the few new endpoints; the existing
endpoints retain their unversioned paths. A `v2` would be a parallel
`/api/admin/feed/v2/...` family — never an in-place breaking change.
This matches the platform's `/api/v1` convention for the coach BFF.

---

## §8. Query layer

### 8.1 N+1 audit

The Coaches table is the canonical N+1 surface. The naïve render is:

```
1. SELECT * FROM "User" WHERE role='coach' LIMIT 50
2. for each coach: SELECT count FROM "User" WHERE coach_id = ?
3. for each coach: SELECT MAX(created_at) FROM "CoachMessage" ...
4. for each coach: SELECT status FROM "CoachSubscription" ...
5. for each coach: SELECT count FROM "LoggedFoodEntry" ... in 7d
```

Five queries per coach × 50 coaches per page = 250 queries per render.
Per the canonical spec §13 budget, every screen renders in under 1.5
seconds at the seeded staging dataset. 250 queries is not within that
budget at production scale.

The fix is gap §11.E — `GET /api/admin/coaches/activity?since_days=` —
which returns all per-coach roll-ups in one payload keyed by
`coach_user_id`. The Coaches table issues two queries: one for the
roster page, one for the activity payload. Same pattern applies to
Clients (one query for the roster, one for entitlements + activity).

### 8.2 Indexes required

Every cohort axis has a defined index requirement. The list below is
the minimum set. **Adding** these indexes is a runtime task the
relevant `TBD-admin-*` slot owner files; this RFC declares the
requirement.

| Cohort | Required index | Already exists? | Gap slot |
|---|---|---|---|
| `signup` | `User(created_at, role)` | Likely (verify) | `TBD-admin-B` |
| `archetype` | `CoachProfile(archetype)` | No (column not yet in schema) | Wave 2 |
| `tier` | `Entitlement(coach_user_id, key)` | Yes | n/a |
| `org` | `User(coach_id)` | Yes | n/a |
| `client_program` | `Program(...)` (Wave 2) | No | Wave 2 |
| `client_milestone` | `Milestone(...)` (Wave 2) | No | Wave 2 |
| `client_at_risk` | `User(last_seen_at)` (gap §11.F) | No | `TBD-admin-F` |
| `client_signup` | `User(created_at, coach_id)` | Verify | `TBD-admin-K` |

Verifications are the runtime author's responsibility at slot-cut time.
The Wave 2 columns are reservations; they do not block this RFC.

### 8.3 Where materialised views are justified

For two queries the recompute cost outpaces the staleness tolerance:

1. **Cohort retention matrix (gap §11.M).** A 12×12 month matrix with
   `count(distinct user_id)` per cell is expensive at scale. Refresh
   every 6 hours; cache the result; surface `meta.generated_at` so
   operators see the freshness. Materialised view candidate: one row
   per `(signup_year_month, offset)` triple.
2. **MRR/ARR per plan, per coach (gap §11.A).** Per the
   [`pr-sequence.md`](./pr-sequence.md) `TBD-admin-A` row, MRR is
   `Σ CoachSubscription.amount × interval_normaliser` joined to the
   `Price` mirror (gap §11.D). At 1k coaches the join is fast, but
   the per-plan and per-coach breakdown across compare windows is a
   four-way fan-out. Materialised view: one row per `(plan, status,
   month)`.

Every other endpoint in the feed contract is real-time. A materialised
view requires a refresh job — one Fly cron entry per view — and
explicit invalidation events (§9). Without those, the view drifts
silently; **we do not ship materialised views without their refresh
job in the same PR.**

### 8.4 Composite filters

A scope tuple compiles to a composite Prisma `where`:

```
where: {
  AND: [
    cohortFilter(scope.cohort),
    segmentFilter(scope.segment),
    timeFilter(scope.time, /* field= */ "created_at"),
    personFilter(scope.person)
  ]
}
```

The four helpers each emit a partial `where` fragment; an empty scope
axis emits `{}` which is the no-op partial. The order of clauses does
not affect the result; Postgres reorders for cost.

### 8.5 Read-only replica considerations

The feed endpoints are read-heavy. If a replica becomes available
(out of scope for v1), the feed router routes reads to the replica and
mutations to the primary. The flag `ADMIN_FEED_USE_REPLICA` reserves
the env name; until the replica exists, every read goes to the primary.
This is consistent with the platform's existing single-Postgres
posture.

---

## §9. Caching layer

### 9.1 Caching tiers

Three tiers, in increasing staleness:

1. **In-process LRU.** Per-pod, 60s TTL, 64MB max. Catches the
   "operator clicks back, then forward" pattern within a single
   pod-bound session. Already in place for the metrics endpoint via
   the existing `cache-manager` module.
2. **Redis (shared).** Per-key, TTL varies by cohort type (§9.2),
   stamped with the cohort + scope hash. Survives across pods. Already
   running for `ThrottlerModule`; we reuse the connection pool.
3. **Materialised views.** Postgres-side, refreshed by cron (§8.3).

Default policy: every feed endpoint reads tier-1, falls through to
tier-2, falls through to the database. Every database read warms
tier-1 and tier-2.

### 9.2 TTLs by cohort type

| Cohort type | Redis TTL | Reasoning |
|---|---|---|
| `signup` | 5 min | Membership rule depends on `created_at` only; new signups are sparse and surface in the next refresh |
| `archetype` | 15 min | Archetype changes are rare; operator-initiated |
| `tier` | 5 min | Entitlement grants happen on subscription events; surface within one billing-event window |
| `org` | 1 min | Sub-coach moves are operator-initiated and the operator expects immediate feedback |
| `client_program` | 5 min | Programs change on coach-initiated events |
| `client_milestone` | 5 min | Same |
| `client_at_risk` | 1 min | Operators triaging at-risk clients need fresh data |
| `client_signup` | 5 min | Same as `signup` |
| `none` (platform-wide) | 30s | Overview and Finance summaries; fresh enough to feel live, slow enough to absorb load |

**One operator-action override.** When an OWNER takes a state-changing
action via the admin console (suspend, reassign, scrub, override), the
backend emits a Redis publish to a `tgp.admin.cache.bust` channel
naming the cohort scope. Every subscriber pod drops the matching keys.
The result: no cache lag visible to the OWNER who just took the
action, even with a 30-second platform-wide TTL.

### 9.3 Cache key shape

```
key := "tgp.admin.feed:v1:" + screen + ":" + sha256(canonical(scope) + "|" + capability_hash)
```

`canonical(scope)` is a lexical canonicalisation of the four scope
axes (sorted facet names, normalised time bounds, etc.) so two
different URLs that produce the same scope share a cache entry.

`capability_hash` mixes the operator's RBAC capabilities into the
cache key. Two operators with different capability sets see different
cache entries even at the same URL — they may legitimately receive
different rows (§13).

### 9.4 Cache-stampede protection

Two layers:

1. **Single-flight.** When a key is cold and N requests arrive
   simultaneously, only one fetches; the rest wait on the in-flight
   promise. The shared NestJS `cache-manager` module supports this
   with the `cache-manager-redis-yet` adapter we already use; we
   enable the `singleFlight` option per endpoint.
2. **Soft-expire.** When a key is within 10% of its TTL, the next
   reader recomputes asynchronously and serves the still-warm value.
   The reader's response is fast; the asynchronous recompute warms
   the cache for the next reader. This is the canonical "swr"
   pattern; the only choice we make is `swr=10%` of TTL.

### 9.5 Cache-bust events

Cache invalidation is **explicit**, not time-based, for state changes:

| Event | Buster |
|---|---|
| `User.role` changed | `tgp.admin.cache.bust` for `cohort=tier:*` |
| `CoachSubscription.status` changed | `cohort=tier:*` and `segment.status=*` |
| `Entitlement` granted/revoked | `cohort=tier:*` |
| `User.coach_id` changed | `cohort=org:*` for both old and new heads |
| `User.is_deleted` flipped | `segment.status=*` |
| `CoachProfile.archetype` changed | `cohort=archetype:*` |
| `Price` mirror updated | `screen=finance` |
| Operator action via admin console | screen-scoped bust per the action's surface |

The bust **drops the cache key**; subsequent reads recompute. The bust
is **idempotent** — re-emitting it is a no-op.

### 9.6 What is not cached

- Any payload containing freshly-mutated data within the last
  30 seconds (operator-action override above).
- Any payload below 8 KB at the database layer — not worth the cache
  round-trip.
- Cursor-paginated payloads beyond the first page — cache only the
  first page; subsequent pages are cheap because they hit the same
  index.
- Streaming endpoints (§10).

---

## §10. Streaming and real-time

### 10.1 Decision: SSE for the always-on screens, polling for the rest

| Screen | Live? | Mechanism | Reasoning |
|---|---|---|---|
| Overview | Yes | SSE | Operators leave it open; updates feel important |
| Recent activity strip | Yes | SSE | Same; rolls into Overview |
| Health-strip pills | Yes | SSE | Federation/health are exactly the cases SSE was built for |
| Coaches | No | Pull-to-refresh | Operators interact, not idle |
| Clients | No | Pull-to-refresh | Same |
| Person profile | No | Manual refresh | Drilldown surface; idle render |
| Finance | No | Manual refresh | Numbers don't move per second |
| Audit | No | Cursor-poll on tab focus | Tail-the-log behaviour |
| Reports | No | n/a | Manifest-driven downloader |

### 10.2 SSE wire shape

```
GET /api/admin/feed/stream?screen=<id>&scope=<base64>
→ event: tick
  data: { "type": "kpi.delta", "screen": "overview", "patch": [ ... ] }
→ event: tick
  data: { "type": "health.update", "pill": "supabase", "status": "ok" }
→ event: heartbeat
  data: { "ts": "ISO8601" }
```

Events:

- `tick` — a value changed; carries a JSON-Patch `patch` against the
  last full payload the client received from the matching GET.
- `heartbeat` — every 15s; allows the client to detect a dead
  connection and reconnect.
- `bye` — server is shutting down (deploy); reconnect after backoff.

The frontend issues a baseline GET first to populate the screen, then
opens an SSE stream for the same `(screen, scope)` and applies patches
in order. Disconnects trigger an exponential backoff (1s, 2s, 4s, 8s,
30s ceiling).

### 10.3 Why not WebSocket

We don't need bidirectional. The frontend never pushes to the server
on the stream — it issues normal HTTP for mutations. SSE has the
natural reconnect-with-`Last-Event-Id` semantic, runs over HTTP/2 which
we already terminate at Fly, and survives every proxy/CDN we deploy
through. WebSocket adds connection lifecycle complexity for no
operator-visible gain.

### 10.4 Why not WebHooks-into-the-browser via PostHog

PostHog handles product analytics, not operator notifications. Pushing
operator-grade alerts through it conflates two surfaces and breaks the
RBAC story (PostHog tokens are not OWNER tokens).

### 10.5 Server-side fan-out

The SSE endpoint subscribes to the same Redis pub/sub channel the
cache-bust system publishes on (§9.5). When a bust event fires, the
endpoint computes the new value for any listening client and emits a
`tick`. This is the path that gives the operator the "I just suspended
this user, the screen updated immediately" feel.

### 10.6 Backpressure

If a client is slow, the SSE endpoint queues up to 32 events and then
drops oldest. The client's reconnect-with-`Last-Event-Id` semantic
ensures it can fetch the missed events on reconnect. We never block
the producer pod on a slow consumer.

---

## §11. Telemetry

### 11.1 What we measure

Three concerns, three metric families:

1. **Operator productivity.** Time-to-answer for canonical questions
   (e.g. "what is MRR for L2 trainers"). Measured as median time from
   screen-open to first scope-stack push.
2. **Query volume.** Per-endpoint requests/minute, broken down by
   cohort type and segment cardinality.
3. **Cache health.** Hit rate per endpoint, single-flight wait time
   p95, soft-expire async-recompute count.

### 11.2 Where the metrics land

The platform already has Sentry for errors and PostHog for product
analytics. For operator metrics we add a fourth source:

- **Operator productivity** → PostHog as `admin_*` events. The OWNER
  is the user; the event payload carries `screen`, `scope_hash`,
  `frame_count`. Personal data is excluded.
- **Query volume** → Sentry breadcrumbs + a new `/api/admin/observe/
  request-volume` endpoint for the admin-of-admins panel (§11.4).
- **Cache health** → Redis INFO + a new `/api/admin/observe/cache-
  health` endpoint, same panel.

### 11.3 Audit-on-read for sensitive cohorts

For person profiles and any read that materialises full PII (name,
email, phone for support ops), the read emits an `AuditLog` row with
action `admin.profile.read` per the canonical spec §15. Cohort reads
do **not** audit-on-read — the unit of audit is one human, not one
cohort.

When the operator drills from a cohort into a person, the push of the
`person` frame on the stack triggers the audit row. The cohort frames
above it are not individually audited; the person-frame push is the
boundary.

### 11.4 The admins-of-admins panel

A small Settings sub-screen, OWNER-gated, hidden behind
`ADMIN_CONSOLE_V2_ENABLED`:

```
┌─ Admin observability ───────────────────────────────────────┐
│ Operator productivity                                       │
│   Median time-to-answer (7d): N/A until populated           │
│   Sessions per OWNER per day:                               │
│   Most-visited screens:                                     │
│                                                             │
│ Query volume                                                │
│   Requests/minute by endpoint:                              │
│   Slow queries (p95 > 1s):                                  │
│                                                             │
│ Cache health                                                │
│   Hit rate by endpoint:                                     │
│   Single-flight contention:                                 │
│   Async recompute count:                                    │
└─────────────────────────────────────────────────────────────┘
```

The panel reads the new `/api/admin/observe/*` endpoints. Until those
endpoints ship (gap **§11.P-observe** — see §15), the panel is a
hidden route.

---

## §12. Privacy

### 12.1 PII in feed responses

The default rule is **the minimum field set the screen renders**. The
Coaches table renders display name, email, plan, status, last seen,
client count, MRR — that's what the endpoint returns. The Coaches
table does **not** receive phone number, mailing address, profile
photo, or any health/nutrition data; opening a person profile does.

This matches the canonical spec's posture for `admin.profile.read` —
the audit boundary aligns with the data boundary.

### 12.2 Redaction rules

Three classes:

1. **Always redacted in feed responses.** Government IDs,
   authentication secrets, raw Stripe tokens, raw refresh tokens.
   These never leave the database in any feed response.
2. **Redacted unless the operator drills into the person.** Phone,
   address, profile photo URL.
3. **Surfaced everywhere.** Display name, email, plan name, status,
   tier, role, signup date.

The redaction is server-side, in a single `redactForAdminFeed()`
helper called by every feed endpoint. The helper is unit-tested
against a fixture matrix; new fields default to "redact" until
explicitly added to one of the three lists.

### 12.3 Audit-on-read

Per §11.3 and the canonical spec §15, the unit of audit is one human.
Reading a cohort does not audit; reading a person does. The audit row
shape:

```
{
  action:           "admin.profile.read",
  actor_user_id:    <OWNER>,
  target_user_id:   <person>,
  metadata: {
    via:            "admin_console",
    operator_action: <X-Operator-Action header>,
    scope_hash:     <sha256 of the parent scope>
  }
}
```

The `scope_hash` lets a forensic reviewer tell that this read came
from a cohort drilldown, without recording the cohort's contents.

### 12.4 Bulk export

Bulk export of a cohort (gap §11.O) is privileged. It emits one audit
row per **cohort** (not per person) with action
`admin.bulk_export` and `metadata.row_count`. The signed-URL CSV
inherits the same redaction rules as the feed.

### 12.5 Cross-screen scope leak

Scope-stack frames on the URL contain person IDs when the operator
has drilled into a person. Sharing such a URL leaks the person ID to
the receiving operator. This is intentional — the receiving operator
must have OWNER privileges to load the URL, and the audit row lands
when *they* render the page. The canonical spec §15 anticipated this.

---

## §13. RBAC and capability gates

### 13.1 Mapping capabilities to feed endpoints

The advisory capability matrix lives in
[`deployment-and-rbac.md`](./deployment-and-rbac.md) §3. We extend it
with feed-specific entries:

| Capability | Feed endpoint(s) | Existing/New |
|---|---|---|
| `view:overview` | `/admin/metrics`, `/admin/audit-log`, `/admin/finance/health`, new `/admin/feed/v1/overview` | Existing + new |
| `view:revenue` | `/admin/feed/v1/finance`, `/admin/finance/mrr` (`TBD-admin-A`), `/admin/finance/coach-cohorts` (`TBD-admin-B`) | New |
| `view:audit` | `/admin/audit-log`, `/admin/feed/v1/audit` | Existing + new |
| `view:health` | `/admin/integrations/status`, `/admin/finance/health`, future probes (`TBD-admin-C`) | Existing |
| `act:promote` | `POST /admin/users/:id/promote` | Existing |
| `act:bulk_export` | `POST /admin/search/export` (`TBD-admin-O`) | New |
| (new) `view:cohort` | every feed endpoint that accepts `cohort=...` | New — see §13.2 |
| (new) `view:org_tree` | `/admin/feed/v1/scope/org/:id/tree` | New — see §13.2 |
| (new) `view:observe` | `/admin/observe/*` (admins-of-admins) | New — gap §11.P-observe |

### 13.2 New advisory capabilities

Three new capabilities are reserved by name in this RFC:

- `view:cohort` — required to apply any cohort axis. Without it, the
  scope-bar's cohort chip is hidden. Defaults to true for OWNER.
- `view:org_tree` — required to expand an org-cohort into its tree.
  Without it, the org chip renders the head coach only and never
  walks the sub-coach branch. Defaults to true for OWNER.
- `view:observe` — required to read the admins-of-admins panel.
  Defaults to true for OWNER but reserved for the future
  `OWNER_READONLY` sub-role to be denied.

These extend, not replace, the matrix in
[`deployment-and-rbac.md`](./deployment-and-rbac.md) §3. When that doc
is updated, the new rows there should match the names above.

### 13.3 Server enforcement

The class-level `@Roles('owner')` guard is the only hard gate. The
capability matrix is advisory at the UI layer, but the server still
filters response payloads by capability:

- A request with `view:cohort = false` that includes a `cohort=...`
  parameter receives HTTP 403 with `error.code = "scope.cohort.
  forbidden"`.
- A request with `view:org_tree = false` against
  `/admin/feed/v1/scope/org/:id/tree` receives HTTP 403.

The frontend should not *send* requests for capabilities the operator
lacks (the chips are hidden). The 403 path exists to defend against
URL paste / bookmark replays.

### 13.4 Capability hash in cache keys

§9.3 mixes the operator's capability set into the cache key. This
prevents one operator's `view:cohort = false` cached payload (cohort
chip hidden, full data) from being served to another operator with
`view:cohort = true` — whose payload should include cohort breakdowns
the first never saw.

---

## §14. Existing endpoint reconciliation

Every endpoint shipped under `/api/admin/*` today maps to one of three
postures: **keep** (no change), **wrap** (extend with scope params,
unchanged response when scope is absent), **deprecate** (none in v1).

| Endpoint | Posture | Scope axes added | Notes |
|---|---|---|---|
| `GET /admin/metrics` | wrap | time | Already accepts implicit "now" window; extend to accept explicit `time.*` params. Compatible. |
| `GET /admin/audit-log` | wrap | time, segment.action, person.target_user_id | Accepts most of these informally today; formalise. |
| `GET /admin/coaches` | wrap | time, cohort, segment | The feed-envelope wrapper is the v1 path; raw shape preserved. |
| `GET /admin/coaches/:id/overview` | keep | n/a | Person-frame endpoint; scope is `person`. |
| `GET /admin/users` | wrap | time, segment | Universal user list; segments narrow by role/status. |
| `GET /admin/search` | wrap | (none — search is its own thing) | Search remains scope-free; results carry person IDs that drilldown into scoped views. |
| `GET /admin/clients/:id/unified` | keep | n/a | Person-frame endpoint. |
| `GET /admin/finance/health` | keep | n/a | Health-strip source; SSE-pushed (§10). |
| `GET /admin/integrations/status` | keep | n/a | Same. |
| `GET /admin/product/usage` | wrap | time, cohort, segment | Product usage by cohort is the explicit goal here. |
| `GET /admin/reports` | keep | n/a | Manifest stays scope-free; per-report endpoints are `keep`. |
| `GET /admin/reports/<id>` | keep | n/a | One-shot CSV/JSON exporter; scope is encoded in the URL the operator hits. |
| `GET /admin/federation/*` | keep | n/a | Federation has its own contract; the admin console only ever **renders** federation responses. |

**No deprecations.** Every existing path stays. The wraps are
additive; absence of scope params reproduces today's behaviour.

The `TBD-admin-A..O` slots in [`pr-sequence.md`](./pr-sequence.md) §3
are **new** endpoints, not wraps. They follow the feed envelope
shape from §7.2 from day one.

---

## §15. New endpoints required (gap inventory beyond §11.A–O)

The Wave 1 gap inventory in
[`control-room-spec.md`](./control-room-spec.md) §11.A–O is defined
against the *screen* contract. The data-feed contract introduces five
additional gaps the screens depend on. We name them §11.P-* to keep
the namespace continuous with the canonical spec; the canonical-spec
author should adopt the names verbatim or rename in a single update.

### 15.1 §11.P-cohort — cohort slicer endpoint

```
GET /api/admin/feed/v1/scope/cohorts?type=<cohort_type>
→ {
    cohorts: [
      { cohort: SignupCohort, member_count: int, first_member_at: ISO8601 },
      ...
    ],
    meta: { generated_at, cache_hit, request_id }
}
```

Lists every concrete cohort of a type, with population counts. The
scope-bar's cohort chip dropdown reads this endpoint; without it,
operators have to guess valid cohort values to type into the URL.

Slot: `TBD-admin-P-cohort`. Phase: 2 (alongside Coaches/Clients tables).

### 15.2 §11.P-archetype — archetype segment endpoint

```
GET /api/admin/feed/v1/scope/archetypes
→ {
    archetypes: [
      { key: "trainer",     member_count: int, mrr_cents: int },
      { key: "gym",         ... },
      { key: "influencer",  ... },
      { key: "info_seller", ... }
    ]
}
```

Same shape as §15.1 but for archetypes. Reads `CoachProfile.archetype`
once shipped (Wave 2 reservation; this RFC's archetype work hard-
depends on it). Until then the endpoint returns
`{ archetypes: [], meta: { not_yet_available: "wave_2_archetype_column" } }`.

Slot: `TBD-admin-P-archetype`. Phase: 4 (alongside Finance, by which
time Wave 2 is expected to have shipped the column).

### 15.3 §11.P-org-tree — sub-coach roster aggregation endpoint

```
GET /api/admin/feed/v1/scope/org/:head_coach_user_id/tree
→ {
    head: { user_id, ... },
    sub_coaches: [ { user_id, ..., client_count, mrr_cents }, ... ],
    direct_clients: [ { user_id, ... }, ... ],
    rollups: { total_clients: int, total_mrr_cents: int, total_arr_cents: int }
}
```

Single endpoint that walks the org tree once and rolls up everything
the org-cohort breakdown needs. Replaces the N+1 pattern of
"GET /admin/coaches/:id/overview" per sub-coach.

Slot: `TBD-admin-P-org-tree`. Phase: 5 (alongside support flags +
suspend/reassign, where org operations cluster).

### 15.4 §11.P-window — time-window aggregator endpoint

```
GET /api/admin/feed/v1/scope/window?screen=<id>&granularity=<g>&since=&until=&compare_to=
→ {
    series: [
      { ts: ISO8601, value: number, ... },
      ...
    ],
    compare: { series: [ ... ] } | null,
    meta: { generated_at, cache_hit, request_id }
}
```

Returns the time series for any screen-supported metric. Used by the
trend-line panels on Overview, Finance, and Product usage. Avoids
having each screen reimplement bucket math.

Slot: `TBD-admin-P-window`. Phase: 4.

### 15.5 §11.P-observe — admins-of-admins observability endpoints

```
GET /api/admin/observe/request-volume
GET /api/admin/observe/cache-health
GET /api/admin/observe/operator-productivity
```

Three endpoints feeding the §11.4 admins-of-admins panel. Each returns
small flat objects; no scope axes apply.

Slot: `TBD-admin-P-observe`. Phase: 7 (Hardening). Lowest priority —
useful but not blocking.

### 15.6 New gap inventory rollup

| Slot | Gap | Phase | New endpoint(s) | New tables | Description |
|---|---|---|---|---|---|
| `TBD-admin-P-cohort` | §11.P-cohort | 2 | `GET /admin/feed/v1/scope/cohorts` | none | Cohort slicer for the scope-bar dropdown |
| `TBD-admin-P-archetype` | §11.P-archetype | 4 | `GET /admin/feed/v1/scope/archetypes` | depends on `CoachProfile.archetype` (Wave 2) | Archetype segment listing |
| `TBD-admin-P-org-tree` | §11.P-org-tree | 5 | `GET /admin/feed/v1/scope/org/:id/tree` | depends on sub-coach hierarchy (Wave 2) | Org tree expansion endpoint |
| `TBD-admin-P-window` | §11.P-window | 4 | `GET /admin/feed/v1/scope/window` | none | Time-series aggregator |
| `TBD-admin-P-observe` | §11.P-observe | 7 | `/admin/observe/*` × 3 | none | Admins-of-admins observability |

These rows extend the table in
[`pr-sequence.md`](./pr-sequence.md) §3. The canonical-spec author
should append them in the next docs sub-PR after this RFC merges.

---

## §16. Test plan

### 16.1 Cohort math integration tests

For every cohort type in §3, a deterministic fixture set + an integration
test:

1. Seed N users with controlled `created_at`, archetype, tier.
2. Issue a request scoped to each cohort.
3. Assert the response's `member_count` matches the seed truth.
4. Assert intersections with segments narrow correctly (e.g.
   `cohort=archetype:trainer&segment.tier=L2,L3` returns the AND).

### 16.2 Scope-stack URL round-trip tests

1. Push a sequence of N frames (N = 1..8) into the scope stack.
2. Serialise to URL.
3. Parse URL.
4. Assert the resulting stack is byte-identical.
5. Assert frame count > 8 drops the bottom frame (§6.4).

### 16.3 RBAC sweep

For every feed endpoint × every capability:

1. Build a token with the capability absent.
2. Hit the endpoint with a scope that exercises the capability.
3. Assert HTTP 403 + `error.code` matches the spec.

This is mechanical and runs in CI nightly. The existing
`test/throttler.module.spec.ts` walks every controller; a new
`test/admin-feed-rbac.spec.ts` walks every feed route × every
capability and asserts the gate.

### 16.4 Cache invalidation tests

For every cache-bust event in §9.5:

1. Warm the cache by reading the affected endpoint.
2. Trigger the underlying mutation (or directly publish to Redis).
3. Assert the next read returns fresh data and `meta.cache_hit = false`.

### 16.5 Large-dataset performance tests

Seed staging at the canonical spec's "1k coaches × 10k clients" target.
Issue the canonical operator-day workflow:

1. Open Overview.
2. Drill into Coaches.
3. Apply cohort = archetype:trainer.
4. Apply segment = tier:L2.
5. Open the first coach's profile.
6. Drill into one of their clients.

Assert end-to-end p95 < 1.5 seconds per the canonical spec §13. Any
endpoint that breaches the budget gets a query-plan dump in CI.

### 16.6 SSE reconnection tests

1. Connect SSE.
2. Receive baseline.
3. Kill the underlying HTTP connection.
4. Observe the client's reconnect with `Last-Event-Id`.
5. Assert no events are lost across the reconnect (events emitted
   during the disconnect arrive on reconnect).

### 16.7 Materialised view freshness tests

For each materialised view (§8.3):

1. Insert a row into the underlying table.
2. Read the materialised endpoint.
3. Assert `meta.generated_at` is older than the insert (proves the
   view is stale until the next refresh).
4. Manually trigger refresh.
5. Assert `meta.generated_at` is now newer than the insert.

### 16.8 Privacy redaction tests

For every entry in `redactForAdminFeed()`:

1. Add a fixture user with the field populated.
2. Hit a feed endpoint.
3. Assert the field is absent from the response.
4. Hit the person-profile endpoint for the same user.
5. Assert the field is present (or correctly redacted per class).

### 16.9 Audit-on-read tests

1. Hit a person-profile endpoint as OWNER.
2. Assert an `AuditLog` row with `action = admin.profile.read`,
   correct `actor_user_id`, `target_user_id`, `metadata.scope_hash`.

---

## §17. Rollout

### 17.1 Phasing relative to canonical spec §17

This RFC's runtime work folds into the canonical spec's 7-week rollout
without inserting a new phase. Per-screen mapping:

| Phase | Canonical spec slots | This RFC's slots | Notes |
|---|---|---|---|
| 0 (now) | docs only | this RFC | No runtime |
| 1 (week 1) | Overview + universal search | (none new) | Existing endpoints carry the load |
| 2 (week 2) | `TBD-admin-E,F,J` (Coaches + Clients) | `TBD-admin-P-cohort` | Cohort slicer ships alongside the Coaches table so the scope-bar's chip is populated from day one |
| 3 (week 3) | `TBD-admin-D,K` (Person profile + Price mirror) | (none new) | Person profile uses existing scope-bar; no new feed slot |
| 4 (week 4) | `TBD-admin-A,B` (Finance) | `TBD-admin-P-archetype`, `TBD-admin-P-window` | Archetype + window aggregator land with Finance |
| 5 (week 5) | `TBD-admin-G,H,I,N` | `TBD-admin-P-org-tree` | Org tree lands when sub-coach hierarchy + suspend/reassign cluster |
| 6 (week 6) | `TBD-admin-C,L,M,O` | (none new) | Health probes, dunning, retention, bulk export |
| 7 (week 7) | (hardening) | `TBD-admin-P-observe` | Admins-of-admins panel as a hardening deliverable |

### 17.2 Phase 0 question

Should the data-feed RFC land *before* Phase 1 or *during* Phase 1? We
recommend **before**: this RFC and a docs-only sub-PR adding the
§11.P-* rows to [`pr-sequence.md`](./pr-sequence.md) §3 land in
Phase 0, alongside the Wave 1 reconciliation PR #130. No runtime work
descends from this RFC until Phase 2.

### 17.3 Feature-flag posture

The data-feed contract is gated on `ADMIN_CONSOLE_V2_ENABLED` like the
rest of the admin console (canonical spec §17). No second flag.
Within the flag, individual screens light up phase by phase; the
feed envelope is stable from Phase 1 even when individual fields are
`not_yet_available`.

### 17.4 Backfill considerations

- `User.last_seen_at` (gap §11.F) requires a one-time backfill from
  the most recent auth-bearing request per user. The runtime author
  for `TBD-admin-F` owns the backfill; this RFC merely points at the
  requirement.
- The materialised retention view (§8.3, gap §11.M) requires no
  backfill on first deploy — the view starts empty and populates on
  first refresh. Operators see `not_yet_available` for the first six
  hours.

### 17.5 Read-replica deferment

The feed contract is replica-friendly (§8.5). Adopting a replica is
**out of scope for v1**. Revisit when end-to-end p95 breaches budget
on the primary alone.

---

## §18. Risks

### 18.1 Cohort cardinality explosion

The org-cohort tree expands per head coach. At 1k head coaches × 50
sub-coaches each, the org-tree endpoint serves up to 50,000 sub-coach
records on a single render. Mitigation: cursor pagination on
`sub_coaches[]` once `len(sub_coaches) > 200` for any one head — fold
into the existing cursor pattern. Not in v1; named risk.

### 18.2 Cache stampede on bulk operator action

When an OWNER takes a bulk action (e.g. mass-suspend a coach + their
clients), the cache-bust event invalidates a large set of keys. If a
heavy screen renders simultaneously, single-flight protects one fetch
but cannot protect against the operator's own next click. Mitigation:
the in-process LRU's 60s TTL holds the operator's own session warm
even across the bust. Acceptable for v1.

### 18.3 SSE behind a long-running proxy

Some corporate networks terminate idle HTTP/2 streams at 30–60s. The
15s heartbeat (§10.2) keeps the stream live; operators behind a
3-second termination window will reconnect every cycle. Mitigation:
the 1s/2s/4s/8s/30s backoff. Operators on broken networks see the
data as "live with occasional flickers" rather than "stale." Named
risk; not blocked.

### 18.4 Materialised view drift

A materialised view that fails to refresh silently serves stale data.
Mitigation: every materialised view's payload carries a
`meta.generated_at` and the frontend renders it visibly when older
than 2× the expected refresh interval. The frontend never hides
staleness.

### 18.5 Capability creep

Three new capabilities (§13.2). Each adds a column to the eventual
`/api/admin/operators` response. If the matrix grows past ~20 entries
the dropdown UI degrades. Mitigation: hold the matrix at the named
set; resist adding capabilities for one-off screens. Named risk.

### 18.6 URL fragment too long

The scope stack at 8 frames × 1 KB per frame produces an 8 KB
fragment. Some browsers truncate URLs around 2 KB. Mitigation: limit
each frame's `Scope` literal to the field set defined here (no free-
text; person ID instead of person object). At 256 bytes per frame, 8
frames fits in 2 KB.

### 18.7 RBAC drift

The advisory matrix in
[`deployment-and-rbac.md`](./deployment-and-rbac.md) §3 must stay in
sync with §13 here. Mitigation: a single source — when this RFC
introduces capability names (§13.2), the canonical doc adopts them
verbatim. Diverging names are a docs sub-PR.

---

## §19. Open questions

These are decisions the user (Bradley) needs to make before the
runtime PRs descend from this RFC. We list every question, the
options we considered, and our recommendation.

### Q1. Per-screen vs unified feed endpoints

**Question.** Do we keep existing per-screen endpoints and extend them
with scope params (§7.1 option 2), or build a unified `/feed`
entrypoint (option 1)?

**Options.** (1) unified, (2) per-screen, (3) hybrid.

**Recommendation.** **(2) per-screen** as written in §7.1.

**Why we want sign-off.** Reversing this choice later means rebuilding
every endpoint. If the user has a strong preference for a GraphQL-
shaped unified entry, it has to be expressed before Phase 2 ships.

### Q2. Cohort definition: enum vs free-form

**Question.** Cohorts are a closed enum (§3) or an operator-authored
saved-search?

**Options.** (a) closed enum as written, (b) saved-searches stored
in a new `Cohort` table, (c) both — enum for the well-known cohorts,
saved-searches for ad-hoc.

**Recommendation.** **(a) closed enum** for v1. Saved-searches are a
v2 concern; their absence is recoverable with copy-the-URL. Adding
saved-searches later does not break this contract.

### Q3. SSE vs polling for the Overview

**Question.** Is SSE for the Overview screen worth the operational
complexity?

**Options.** (a) SSE as written, (b) 30s polling, (c) WebSocket.

**Recommendation.** **(a) SSE.** Operators leave Overview open all
day; the perceived liveness pays for the SSE plumbing. WebSocket adds
complexity for no operator-visible gain. 30s polling produces an
animated dashboard for screens that do not change every 30 seconds.

### Q4. Materialised views in v1

**Question.** Do we ship the two materialised views in §8.3 in v1, or
defer to v2 once we observe real load?

**Options.** (a) ship both with their refresh jobs, (b) defer both,
(c) ship only the retention view.

**Recommendation.** **(c) ship only the retention view.** The MRR
view is fast enough at 1k coaches even without materialisation; defer
it. The retention view is the one that won't meet budget without
materialisation.

### Q5. Archetype taxonomy column placement

**Question.** Where does `archetype` live? `CoachProfile.archetype`
(per §3.2 reservation) or a new `CoachArchetype` join table?

**Options.** (a) column on `CoachProfile`, (b) join table.

**Recommendation.** **(a) column.** Archetype is single-valued today;
multi-archetype coaches are a hypothetical we don't pay for now. If
multi-archetype emerges we add a join table and keep the column for
the canonical archetype.

**Decision owner.** Wave 2 author. This RFC defers entirely; the
endpoint contract works under either shape.

### Q6. Scope-stack server-side persistence

**Question.** Persist the operator's scope stack server-side for
cross-device handoff?

**Options.** (a) localStorage only as written, (b) server-side
persistence.

**Recommendation.** **(a) localStorage only** in v1. Server-side
persistence introduces a new audit surface (per-operator-per-day
stacks) and an attack surface (manipulated stack on a stolen device).
v2 reconsider.

### Q7. Capability matrix server enforcement timing

**Question.** When does the advisory matrix become server-enforced?

**Options.** (a) at the Phase-7 hardening slot, (b) when
`/api/admin/operators` ships in Phase 2, (c) only when the
sub-OWNER triad lands (Phase 2+ of the canonical spec's Phase 7
extension).

**Recommendation.** **(b) when `/api/admin/operators` ships.**
Earlier the better; the longer it remains advisory, the more drift
between docs and reality.

### Q8. Compare-to-previous default

**Question.** Which screens default to `compare_to = "previous_
period"`?

**Options.** (a) Overview only, (b) Overview + Finance, (c) every
screen with a time axis.

**Recommendation.** **(b) Overview + Finance.** Comparing every list
screen produces visual noise for a list that shouldn't be charted.
The defaults in §4.3 reflect this.

### Q9. Cache TTLs

**Question.** Are the cache TTLs in §9.2 right?

**Options.** (a) tighter (everything 30s), (b) looser (everything
5min), (c) per-cohort as written.

**Recommendation.** **(c) per-cohort as written.** Tighter punishes
the database for no operator-visible gain; looser drifts under
operator action. The operator-action override (§9.2 final paragraph)
is the unlock — it lets us hold the cohort TTLs while keeping
operator-perceived freshness.

### Q10. URL fragment vs query string for scope stack

**Question.** Carry the scope stack in the URL fragment (§6.4) or
the query string?

**Options.** (a) fragment as written, (b) query string, (c) split as
written: query for current frame, fragment for stack.

**Recommendation.** **(c) split as written.** Server gets what it
needs in the query; operator history rides the fragment. This is the
pattern in §6.4.

### Q11. Versioning the feed contract

**Question.** Path-versioned (`/api/admin/feed/v1/...`) or
header-versioned (`X-API-Version: 1`)?

**Options.** (a) path, (b) header, (c) none — stable forever.

**Recommendation.** **(a) path.** Matches the existing `/api/v1/`
coach-BFF convention. Headers get lost in browser dev-tools at the
moment when an engineer most needs to see them.

### Q12. SSE delivery guarantees

**Question.** Do we promise at-least-once delivery on SSE, or
best-effort?

**Options.** (a) best-effort with reconnect-and-resync, (b) at-least-
once with `Last-Event-Id` server-side persistence.

**Recommendation.** **(a) best-effort.** The frontend re-fetches the
baseline on reconnect; the cost of (b) is a Redis stream we don't yet
need. Revisit when an operator complains.

### Q13. Time-zone handling

**Question.** UTC server-side, locale display only? Or per-operator
timezone end-to-end?

**Options.** (a) UTC server, locale display, (b) per-operator timezone
all the way down, (c) opt-in per-operator timezone.

**Recommendation.** **(a) UTC server, locale display.** Per §4.1.
DST and timezone-rollover bugs are not a place we want to live.

### Q14. Bulk-export rate limit

**Question.** What rate limit for `POST /admin/search/export` (gap
§11.O)?

**Options.** (a) one per minute per OWNER, (b) one per hour per OWNER,
(c) no limit.

**Recommendation.** **(b) one per hour per OWNER.** Bulk export is
heavy; operators rarely need more than one per hour. Throttle into
the existing throttler module, not into a new mechanism.

### Q15. Admins-of-admins panel timing

**Question.** Does the admins-of-admins panel ship in v1 or as a
hardening deliverable?

**Options.** (a) ship with Overview in Phase 1, (b) hardening in Phase
7 as written, (c) defer to v2.

**Recommendation.** **(b) hardening in Phase 7** as written in §17.1.
The data the panel surfaces is operator-side telemetry; it's useful
once operators are using the console, not before.

---

## §20. Decisions made (summary)

The non-deferred decisions in this RFC, restated for grep-ability:

1. **Per-screen endpoints** with the feed-envelope shape. No unified
   `/feed` router. (§7.1)
2. **Closed enum cohort taxonomy.** No saved-searches in v1. (§3, Q2)
3. **Scope-stack lives in the URL fragment + localStorage.** No
   server-side persistence in v1. (§6, Q6)
4. **SSE for Overview/health/recent-activity. Polling/manual for
   tables.** No WebSocket. (§10)
5. **Materialised views: retention only in v1.** MRR matrix deferred.
   (§8.3, Q4)
6. **UTC server, locale display.** No per-operator timezone storage.
   (§4.1, Q13)
7. **Path-versioned feed (`/api/admin/feed/v1/`).** No header
   versioning. (§7.7, Q11)
8. **Per-cohort cache TTLs with operator-action override.** No global
   TTL. (§9.2, Q9)
9. **Capability hash mixed into cache keys.** No cross-operator cache
   reuse for cohort-scoped reads. (§9.3, §13.4)
10. **Audit-on-read at the person-frame boundary.** Cohort reads do
    not audit-on-read. (§11.3, §12.3)
11. **No deprecations of existing endpoints.** Wraps are additive;
    absence of scope params reproduces today's behaviour. (§14)

---

## References

- [`./control-room-spec.md`](./control-room-spec.md) — canonical
  control-room spec; §3–§10 screens, §11 gap inventory, §17 rollout
  phases. Available at this path once PR #130 merges.
- [`./deployment-and-rbac.md`](./deployment-and-rbac.md) — capability
  matrix this RFC extends in §13.
- [`./pr-sequence.md`](./pr-sequence.md) — `TBD-admin-A..O` slot
  table this RFC extends with `TBD-admin-P-*` rows in §15.
- [`./screens-addendum.md`](./screens-addendum.md) — additional screen
  set; consumer-only screens for marketplace, payouts, support.
- [`../../PERP_HANDOFF.md`](../../PERP_HANDOFF.md) — handoff log;
  Wave 3 entry alongside Wave 1.
- `prisma/schema.prisma` — single source of truth for the data model
  this RFC reads against. Specifically: `User`, `CoachProfile`,
  `CoachSubscription`, `Entitlement`, `AuditLog`, `Invoice`,
  `PaymentFailure`, `CoachMessage`, `LoggedFoodEntry`, `WorkoutLog`.

---

**This is a docs-only RFC.** No runtime code, schema, env, CI, or
migration changes in the PR that introduces this file. Every named
table or field above is either present in the live schema today or
reserved by name in [`pr-sequence.md`](./pr-sequence.md). The
contracts above are graded against future runtime PRs — they are not
enforced by anything in this repo today.
