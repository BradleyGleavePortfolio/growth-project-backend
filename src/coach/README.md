# coach

Coach-facing endpoints for the mobile coach view: dashboard, client
list, archive/unarchive, per-client timeline / summary, guidelines, and
the rule-based alert feed. The companion BFF for the web coach console
lives under `src/v1/` (see [v1 BFF README](../v1/README.md)).

## Purpose

- Give a coach a single round-trip view of their roster and per-client
  history (90-day timeline, today's macros, weight trend).
- Enforce coach → student tenancy on every read and write so a coach
  can only act on clients linked to them via `User.coach_id`.
- Let an OWNER widen the scope to the platform-wide view without
  changing the controller surface.
- Generate the rule-based alert feed (consecutive weight increases,
  missed workouts) the dashboard renders.

## Key files

| File | What it owns |
|---|---|
| `coach.controller.ts` | `/coach/*` HTTP surface; class-level `@UseGuards(JwtAuthGuard, CoachGuard)` |
| `coach.service.ts` | Roster filtering, timeline aggregation, alert rules, guidelines persistence |
| `coach.module.ts` | Wires the controller and service; imports `AuthModule` |

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/coach/dashboard` | Today's logging count, total kcal, logging rate over the roster |
| `GET` | `/coach/clients?status=active\|archived\|all` | Roster with profile blob |
| `POST` | `/coach/clients/:id/archive` | Soft-archive (sets `archived_at`) |
| `POST` | `/coach/clients/:id/unarchive` | Clears `archived_at` |
| `GET` | `/coach/clients/:id/timeline?days=N` | Up to 90 days of meals, workouts, weights, check-ins, merged into a sorted event stream |
| `GET` | `/coach/clients/:id/summary?date=YYYY-MM-DD` | One-day macro tally + 30-day weight + last 10 workouts |
| `GET` | `/coach/my-guidelines` | Most recent guideline row authored *for* the caller (legacy passthrough) |
| `GET` | `/coach/guidelines/:client_id` | Guideline coach has set on a client |
| `POST` | `/coach/guidelines/:client_id` | Upsert guideline (max once per pair via composite key) |
| `GET` | `/coach/alerts` | Rule-based alert feed |

## Tenancy rules

Every roster scope flows through `byCoach(callerId, callerRole)`:

- `callerRole === 'owner'` → empty Prisma filter; the OWNER reads
  every roster.
- otherwise → `{ coach_id: callerId }`.

Per-client lookups (`archiveClient`, `getClientTimeline`,
`getClientSummary`) re-run the same filter via `findFirst` so a coach
asking about a foreign client gets `Client not found` rather than a
cross-tenant read. `archiveClient` and `unarchiveClient` re-throw as
`NotFoundException` from the controller for a stable 404 shape.

`postGuidelines` upserts on the composite `(coach_id, client_id)` key
(`CoachGuideline_coach_client_key`) so a coach has exactly one
guideline row per client. `getGuidelines` accepts either
`(coachId, clientId)` or `(clientId)` to support the mobile
"coach-set guidelines for me" surface.

## Alerts

`getAlerts` runs two rules per client:

- `weight_increasing` — last 3+ weight logs are strictly increasing.
- `missed_workouts` — no `WorkoutSession` in the last 5 days.

Both queries are batched (`groupBy`, `findMany` with `_count`) so the
endpoint is one round-trip per rule, not one per client.

## Security and tenancy rules

- `JwtAuthGuard` + `CoachGuard` are class-level. `CoachGuard` is
  widened in Phase 1B so OWNER passes through every route.
- `coach_id` filtering is the only scope enforcement on reads; there
  is no separate ACL.
- Archived clients (`archived_at IS NOT NULL`) drop out of the default
  roster but remain readable through `/coach/clients?status=archived`.
- The mobile-side `archiveClient` analytics event fires only after the
  database mutation succeeds.

## Environment variables

This module uses the platform-wide secrets only. No coach-specific env
vars; everything is database-driven.

## Failure modes

- Foreign client id → `Client not found` 404 from the controller.
- An OWNER hitting these routes always succeeds and reads platform-wide
  rosters; if that becomes unwanted, narrow `byCoach` to require
  explicit `coach_id` even for OWNER.
- Empty roster → all aggregate routes short-circuit to zeros; no
  per-client query runs.

## Tests

| File | Covers |
|---|---|
| `test/coach.service.spec.ts` | Tenancy, archive/unarchive, alert rule output |
| `test/coach-timeline.spec.ts` | 90-day timeline composition + ordering |
| `test/v1-coach.service.spec.ts` | The BFF analogue under `src/v1/` |

## Operational notes

- The mobile app pages the alert feed off this controller; if the
  alert rules change, the dashboard counter changes silently. Bump
  the controller path or add a feature flag if a new rule must
  roll out behind a switch.
- The companion `src/v1/` BFF mounts under `/v1/coach/me` and is the
  surface the web coach console talks to. It pulls in
  `SubscriptionGuard` from `BillingModule` so writes are gated on
  subscription state — this controller intentionally does not.
