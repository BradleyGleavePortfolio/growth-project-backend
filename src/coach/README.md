# coach

Coach-facing endpoints for the mobile coach view: dashboard, client
list, archive/unarchive, per-client timeline / summary, guidelines, the
rule-based alert feed, and the Phase 1E PTM risk board scoped to this
coach's own roster.

## Purpose

- Give a coach a single round-trip view of their roster and per-client
  history (90-day timeline, today's macros, weight trend).
- Enforce coach → student tenancy on every read and write so a coach
  can only act on clients linked to them via `User.coach_id`.
- Let an OWNER widen the scope to the platform-wide view without
  changing the controller surface.
- Generate the rule-based alert feed (consecutive weight increases,
  missed workouts) the dashboard renders.
- Expose the coach-scoped PTM risk board so the mobile risk board screen
  can show each coach their own clients sorted by churn risk — without
  surfacing the raw model score (Phase 1E doctrine).

## Key files

| File | What it owns |
|---|---|
| `coach.controller.ts` | `/coach/*` HTTP surface; class-level `@UseGuards(JwtAuthGuard, CoachGuard)` |
| `coach.service.ts` | Roster filtering, timeline aggregation, alert rules, guidelines persistence |
| `coach.module.ts` | Wires the controller and service; imports `AuthModule`, `NotificationsModule`, and `AdminModule` (via `forwardRef`) |

## Endpoints

| Method | Path | Role gate | Request params | Response shape |
|---|---|---|---|---|
| `GET` | `/coach/dashboard` | coach / owner | — | Dashboard summary |
| `GET` | `/coach/clients?status=active\|archived\|all` | coach / owner | `status` | Roster with profile blob |
| `POST` | `/coach/clients/:id/archive` | coach / owner | `:id` | `{ ok: true }` |
| `POST` | `/coach/clients/:id/unarchive` | coach / owner | `:id` | `{ ok: true }` |
| `GET` | `/coach/clients/risk-board` | **coach / owner** | `?bucket=green\|amber\|red&cursor=ISO&limit=N` | `{ data: CoachRiskBoardRow[], next_cursor: string\|null, generated_at: string }` |
| `GET` | `/coach/clients/:id/timeline?days=N` | coach / owner | `:id`, `days` | 90-day event stream |
| `GET` | `/coach/clients/:id/summary?date=YYYY-MM-DD` | coach / owner | `:id`, `date` | One-day macro tally + 30-day weight |
| `GET` | `/coach/my-guidelines` | coach / owner | — | Most-recent guideline row |
| `GET` | `/coach/guidelines/:client_id` | coach / owner | `:client_id` | Guideline coach has set on a client |
| `POST` | `/coach/guidelines/:client_id` | coach / owner | `:client_id`, body | Upsert guideline |
| `GET` | `/coach/alerts` | coach / owner | `?acknowledged=true\|false&limit=&before=` | Alert inbox |

### `/coach/clients/risk-board` — detail

**Route ordering note:** This static route (`/coach/clients/risk-board`)
is declared before the parameterised `:id` routes so NestJS resolves it
correctly and does not treat `risk-board` as a client id.

**Response row shape** (`CoachRiskBoardRow`):

```ts
{
  user_id:       string;
  name:          string;
  email:         string;
  risk_score:    null;          // always null — Phase 1E doctrine
  success_score: null;          // always null — Phase 1E doctrine
  bucket:        'green' | 'amber' | 'red';
  computed_at:   Date;
  factors_count: number;
  last_signal_at: string | null;
  outcome_label:  string | null;
}
```

`risk_score` and `success_score` are always `null` on this path. The
server computes the bucket from the raw score internally and only exposes
the bucket label. The mobile coach screen renders via `RiskDot` using the
bucket; the numeric percentage column is hidden for non-owner roles.

**Pagination:** cursor-based on `computed_at`. Pass the `next_cursor`
value from the previous page as `?cursor=` on the next request.

## Models touched

| Model | Fields read | Fields written |
|---|---|---|
| `User` | `id`, `coach_id`, `role`, `name`, `email`, `deleted_at` | none |
| `PtmPrediction` | `user_id`, `risk_score`, `success_score`, `computed_at`, `factors` | none |
| `ClientSignal` | `user_id`, `recorded_at` (latest only) | none |
| `ClientOutcome` | `outcome_type` | none |
| `WeightLog` | `user_id`, `logged_at`, `weight_kg` | none |
| `WorkoutSession` | `user_id`, `created_at` | none |
| `CoachGuideline` | `coach_id`, `client_id`, `guidelines` | upserted by `postGuidelines` |
| `CoachAlert` | `coach_id`, `client_id`, `alert_type`, `acknowledged_at` | see [Red Flag Alerts](#red-flag-alerts-phase-6b) |

## Role-gating doctrine

`JwtAuthGuard` + `CoachGuard` are class-level on `CoachController`.

```
CoachGuard.canActivate:
  user.role === 'coach'  → allowed
  user.role === 'owner'  → allowed (platform-wide bypass)
  anything else          → ForbiddenException (403)
```

This means a `student` token hitting any `/coach/*` route receives a 403
before any handler logic runs. The error body is the NestJS default
`{ statusCode: 403, message: 'Forbidden resource' }` — no internal reason
or data shape is disclosed.

For the risk board specifically, the `coachId` passed to
`AdminPtmService.getRiskBoardForCoach` is always `req.user.id` — it is
never sourced from query params or the request body. A coach cannot
read another coach's roster by changing a URL parameter.

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

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PTM_RISK_BOARD_PAGE_SIZE` | `50` | Override the default page size for risk board endpoints (both `/admin/ptm/risk-board` and `/coach/clients/risk-board`). Max: 100. |
| `COACH_EFFECTIVENESS_ENABLED` | `true` | Set to `false` to skip the nightly effectiveness recompute. |
| `COACH_EFFECTIVENESS_CRON` | `0 5 * * *` | Override the cron expression. |
| `COACH_ALERT_RED_TRANSITION_ENABLED` | `true` | Set to `false` to silence the PTM red-transition emitter. |
| `COACH_ALERT_BATCH_LIMIT` | `50` (cap 200) | Per-request cap on `/coach/alerts`. |
| `COACH_ONBOARDING_AUTO_START` | `true` | Disable auto-start of the wizard on coach promotion. |

## Tests

| File | Covers |
|---|---|
| `test/coach-ptm-risk-board.spec.ts` | Role guard (coach ✓, owner ✓, student 403, unauth 403); happy path (rows are redacted, risk_score/success_score null); empty roster; cross-coach isolation; bucket filter forwarded; cursor pagination |
| `test/coach.service.spec.ts` | Tenancy, archive/unarchive, alert rule output |
| `test/coach-timeline.spec.ts` | 90-day timeline composition + ordering |
| `test/v1-coach.service.spec.ts` | The BFF analogue under `src/v1/` |
| `test/coach-alerts-push-delivery.spec.ts` | Push delivery via `NotificationsService.pushToCoach`; fallback when no token; dedup suppression |
| `test/coach-alerts-emitters.spec.ts` | `consecutive_misses` + `streak_dropped` emitter behaviour; dedup; payload shapes |

## Failure modes

- Foreign client id → `Client not found` 404 from the controller.
- An OWNER hitting these routes always succeeds and reads platform-wide
  rosters; if that becomes unwanted, narrow `byCoach` to require
  explicit `coach_id` even for OWNER.
- Empty roster → all aggregate routes short-circuit to zeros; no
  per-client query runs. Risk board returns `{ data: [] }`.
- No PTM predictions for a client → that client does not appear in the
  risk board (no prediction row means no bucket).

## Security and tenancy rules

- `JwtAuthGuard` + `CoachGuard` are class-level. `CoachGuard` is
  widened so OWNER passes through every route.
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

### Schedule

`CoachEffectivenessScheduler` fires at `0 5 * * *` UTC by default.
Override with `COACH_EFFECTIVENESS_CRON`. Disable with
`COACH_EFFECTIVENESS_ENABLED=false`.

## Red Flag Alerts (Phase 6B)

`CoachAlertsService` writes proactive `CoachAlert` rows when a client
crosses a behavioral threshold.

### Alert types

| `alert_type`            | Severity   | Triggered by |
|---|---|---|
| `risk_red_transition`  | `critical` | `PtmRecomputeService` — bucket flips `green/amber → red` |
| `consecutive_misses`   | `warning`  | `CheckInsService` — client has ≥ 3 consecutive missed check-in days |
| `streak_dropped`       | `info`     | `CheckInsService` — prior streak ≥ 7, new streak = 0 |

### Endpoints

| Method | Path | Who | Behavior |
|---|---|---|---|
| `GET`  | `/coach/alerts`                       | coach / owner | Paginated own-coach inbox |
| `POST` | `/coach/alerts/:id/acknowledge`       | coach         | Idempotent ack |

## Coach Onboarding Wizard (Phase 6D)

A 6-step guided flow that runs once per coach the first time they log
in after promotion.

| Method | Path | Who | Behavior |
|---|---|---|---|
| `GET`  | `/coach/onboarding`         | coach | Current wizard progress |
| `POST` | `/coach/onboarding/start`   | coach | Idempotent start |
| `POST` | `/coach/onboarding/steps/:n`| coach | Advance to step `n` |
| `POST` | `/coach/onboarding/complete`| coach | Terminal call |

## Module dependency note (Phase 1E)

`CoachModule` imports `AdminModule` via `forwardRef()` to resolve
`AdminPtmService`. `AdminModule` already imports `CoachModule` (for
`CoachOnboardingService` and `CoachAlertsService`). The `forwardRef`
on both sides breaks the circular reference without changing the runtime
graph.

## Follow-ups / known limits

- **Owner via coach endpoint**: An owner calling `GET /coach/clients/risk-board`
  sees only clients with `coach_id = owner_id` (i.e. directly assigned to
  them). If the owner wants the full platform view they use
  `GET /admin/ptm/risk-board`. This is intentional — the two surfaces
  have different scopes and different redaction rules.
- **Deleted clients**: `deleted_at IS NOT NULL` users are filtered from the
  risk board roster. Hard-deleted users' PTM predictions may linger until
  the next prediction recompute cleans orphans.
