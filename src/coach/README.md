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
- Archive and unarchive are immutably audited as
  `coach.client_archived` / `coach.client_unarchived` with
  `tenant_coach_id` set to the *client's* coach (not the actor) so an
  OWNER acting cross-tenant still produces a tenant-scoped row.
  Re-archiving an already-archived client is a no-op and writes no
  audit row, to keep double-tap noise out of the log.

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

## Coach Effectiveness Score (Phase 6A)

`CoachEffectivenessService` computes a per-coach scalar in `[0, 100]`
nightly. The service is OWNER-only at the consumer layer — coaches do
not see their own score (avoids gaming).

### Algorithm (basis `v1`)

| Component   | Weight | What it measures |
|---|---|---|
| `completion` | 0.30 | `completed_90day` outcomes / clients enrolled in trailing 120 days |
| `risk_delta` | 0.25 | Average reduction in PTM `risk_score` over each client's first 60 days (clamped to `[-1, 1]`, normalized to `[0, 1]`) |
| `retention`  | 0.25 | Clients still active 60+ days after assignment / clients assigned in trailing 90 days who have crossed the 60-day horizon |
| `engagement` | 0.20 | Capped per-client messages-per-week over the trailing 28 days. Cap (default 5 msg/wk per client) prevents a single noisy thread from gaming the score. |

`score = (sum of weighted contributions) * 100`, clamped to `[0, 100]`.
Each component is also recorded in the `factors` JSON blob so the
admin "why" drawer can render the breakdown without re-running the
math.

### Buckets

| Range   | Bucket          |
|---|---|
| `0–49`   | `developing`     |
| `50–74`  | `consistent`     |
| `75–100` | `high-performer` |

### Schedule

`CoachEffectivenessScheduler` fires at `0 5 * * *` UTC by default (one
hour after the PTM recompute at `0 4 * * *`). Override with
`COACH_EFFECTIVENESS_CRON`. Disable with `COACH_EFFECTIVENESS_ENABLED=false`.
The cron walks every active coach, calls `score(coachId)`, and logs a
report. Per-coach failures are caught and counted; one bad coach does
not abort the run.

`CoachEffectivenessScore` is APPEND-ONLY. Each tick inserts a fresh
row; the latest read uses `ORDER BY computed_at DESC LIMIT 1`. The
admin console reads via `GET /admin/coach-effectiveness` (sorted) and
`GET /admin/coach-effectiveness/:coachId` (latest + history).

## Red Flag Alerts (Phase 6B)

`CoachAlertsService` writes proactive `CoachAlert` rows when a client
crosses a behavioral threshold. The current emitter is the PTM
recompute hook (green/amber → red transition); future emitters
(consecutive miss detector, finance-EOD gap, streak-drop) will land
under the same `alert_type` enum.

### Alert types

| `alert_type`            | Severity   | Triggered by |
|---|---|---|
| `risk_red_transition`  | `critical` | PTM recompute when a client's bucket flips to `red` from `green` or `amber` |
| `consecutive_misses`   | `warning`  | (reserved) ≥ 5 consecutive `checkin_miss` signals |
| `streak_dropped`       | `info`     | (reserved) `streak_dropped` signal observed |
| `finance_eod_gap`      | `warning`  | (reserved) ≥ 14 days without a `finance_eod` signal |

### Dedup window

`createAlert` short-circuits when an unacknowledged row with the same
`(coach_id, client_id, alert_type)` exists within the last 24h. A
flapping signal can therefore not produce a notification storm; the
prior row is returned instead. After acknowledgement (or the 24h
window passes), the next call writes a fresh row.

### Acknowledge flow

`POST /coach/alerts/:id/acknowledge` flips `acknowledged_at` to `now()`.
The call is idempotent — a repeated ack returns the existing row
without writing. A foreign coach (alert.coach_id ≠ caller) gets a
404, never a 403, to avoid leaking alert existence.

### Push delivery (stub)

`tryPush` currently logs `would push to coach=… type=… sev=…: <message>`.
Real per-coach push delivery lands when `NotificationsModule` grows
the transport; until then, alerts are still stored and visible via the
in-app inbox. No external dep is added until that hook is ready.

### Env flags

| Variable | Default | What it does |
|---|---|---|
| `COACH_EFFECTIVENESS_ENABLED`        | `true`        | Set to `false` to skip the nightly recompute. |
| `COACH_EFFECTIVENESS_CRON`           | `0 5 * * *`   | Override the cron expression. |
| `COACH_ALERT_RED_TRANSITION_ENABLED` | `true`        | Set to `false` to silence the PTM red-transition emitter without disabling the recompute. |
| `COACH_ALERT_BATCH_LIMIT`            | `50` (cap 200) | Per-request cap on `/coach/alerts` and `/admin/coach-alerts`. |

### Endpoints

| Method | Path | Who | Behavior |
|---|---|---|---|
| `GET`  | `/coach/alerts`                       | coach (or OWNER bypass) | Paginated own-coach inbox. `?acknowledged=true|false&limit=&before=`. |
| `POST` | `/coach/alerts/:id/acknowledge`       | coach                   | Idempotent ack. |
| `GET`  | `/admin/coach-effectiveness`          | OWNER                    | Latest score per coach, sorted score DESC. |
| `GET`  | `/admin/coach-effectiveness/:coachId` | OWNER                    | `{ latest, history }` for one coach. |
| `GET`  | `/admin/coach-alerts`                 | OWNER                    | Cross-coach aggregator. `?coach_id=&since=&limit=`. |
