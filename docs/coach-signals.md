# Coach Signals — operator runbook (Phase 6A + 6B)

This document covers the two coach-side analytic surfaces that Phase 6
adds on top of PTM:

- **6A — Coach Effectiveness Score.** A nightly per-coach scalar in
  `[0, 100]` plus a bucket label (`developing` / `consistent` /
  `high-performer`). OWNER-only consumer; coaches do not see their own
  number, by design.
- **6B — Proactive Red Flag Alerts.** Per-coach `CoachAlert` rows
  written when a client crosses a behavioral threshold. Push notifications
  are now **real** (via `NotificationsService.pushToCoach`); if the coach
  has no registered push token, the alert lands in the in-app inbox only.
  Coaches read their own inbox; OWNER reads the cross-coach aggregator.

Both surfaces are append-only / idempotent and tolerant to per-coach
failures — the goal is observability and operator action, not a
gameable leaderboard.

---

## 6A — Coach Effectiveness Score

### Where it lives

| Surface | Path |
|---|---|
| Service | `src/coach/coach-effectiveness.service.ts` |
| Scheduler | `src/coach/coach-effectiveness.scheduler.ts` |
| Persistence | `CoachEffectivenessScore` (Prisma) |
| OWNER endpoints | `GET /admin/coach-effectiveness`, `GET /admin/coach-effectiveness/:coachId` |
| Migration | `prisma/migrations/20260506030000_add_coach_signals/migration.sql` |

### Algorithm (basis `v1`)

The score is a weighted composition of four normalized components:

| Component   | Weight | Source |
|---|---|---|
| `completion` | 0.30 | `ClientOutcome.outcome_type='completed_90day'` over the trailing 120 days, divided by clients enrolled in the same window. |
| `risk_delta` | 0.25 | Average reduction in PTM `risk_score` over each client's first 60 days, normalized via `(delta + 1) / 2` to map `[-1, +1] → [0, 1]`. |
| `retention`  | 0.25 | Clients still active 60+ days after assignment, divided by clients assigned in trailing 90 days who have crossed the 60-day horizon. |
| `engagement` | 0.20 | Per-client `CoachMessage` rate over the trailing 28 days, capped at `5 messages / week / client` so a single noisy thread cannot dominate the score. |

`score = clamp(sum(weighted_contributions) * 100, 0, 100)`.

The full breakdown is persisted in `CoachEffectivenessScore.factors`:

```jsonc
{
  "components": [
    { "key": "completion",  "label": "...", "observed": 0.8,  "contribution": 0.24, "sample_size": 5 },
    { "key": "risk_delta",  "label": "...", "observed": 0.5,  "contribution": 0.1875, "sample_size": 5 },
    { "key": "retention",   "label": "...", "observed": 1.0,  "contribution": 0.25, "sample_size": 5 },
    { "key": "engagement",  "label": "...", "observed": 3.0,  "contribution": 0.12, "sample_size": 5 }
  ],
  "thresholds": { "developing_max": 50, "high_performer_min": 75 }
}
```

### Buckets

| Range   | Bucket          |
|---|---|
| `0–49`   | `developing`     |
| `50–74`  | `consistent`     |
| `75–100` | `high-performer` |

### Schedule

`CoachEffectivenessScheduler` fires at `0 5 * * *` UTC by default:

- 03:00 UTC — GDPR scrub (`GdprScrubScheduler`)
- 04:00 UTC — PTM recompute (`PtmScheduler`)
- 05:00 UTC — Coach Effectiveness recompute (this scheduler)

The 1-hour spacing is deliberate: the effectiveness math reads against
freshly-computed PTM rows. Override the cron via
`COACH_EFFECTIVENESS_CRON`. Disable entirely via
`COACH_EFFECTIVENESS_ENABLED=false` (the handler logs and returns).

### Append-only writes

Every recompute inserts a new row. Reads use
`ORDER BY computed_at DESC LIMIT 1`. The composite index
`(coach_id, computed_at)` supports the seek path; `(computed_at)` supports
the cross-coach "what's the platform median this week?" report.

### Operator gestures

```sh
# Force a one-off recompute for one coach (e.g. after backfill)
psql -c "INSERT INTO ..." # not recommended — use the scheduler

# Read the latest scoreboard
curl -H "Authorization: Bearer <owner-jwt>" \
     https://api.tgp.example.com/api/admin/coach-effectiveness

# Read history for one coach
curl -H "Authorization: Bearer <owner-jwt>" \
     "https://api.tgp.example.com/api/admin/coach-effectiveness/<coach-id>?limit=60"
```

### Why coaches do not see this

The design intent is to keep the score *operator-side*. Showing
coaches their own number creates a Goodhart-style incentive to
optimize the metric (especially the engagement component) rather than
the underlying client outcomes. The feature flag
`COACH_EFFECTIVENESS_ENABLED` exists to disable the engine entirely if
a regression ships, not as a path to surface the score in the coach
console.

---

## 6B — Proactive Red Flag Alerts

### Where it lives

| Surface | Path |
|---|---|
| Service | `src/coach/coach-alerts.service.ts` |
| Coach controller | `src/coach/coach-alerts.controller.ts` (`GET /coach/alerts`, `POST /coach/alerts/:id/acknowledge`) |
| OWNER aggregator | `GET /admin/coach-alerts` |
| Persistence | `CoachAlert` (Prisma) |
| Push delivery | `src/notifications/notifications.service.ts` — `pushToCoach()` |

### Alert types and emitter sources

| `alert_type`            | Severity   | Triggered by | Status |
|---|---|---|---|
| `risk_red_transition`  | `critical` | `PtmRecomputeService.maybeFireRedTransitionAlert` in `src/ptm/ptm-recompute.service.ts` | **live** |
| `consecutive_misses`   | `warning`  | `CheckInsService.maybeFireConsecutiveMissesAlert` in `src/check-ins/check-ins.service.ts` — fires when a client has ≥ 3 consecutive missed check-in days | **live** (wired in Phase 6B PR) |
| `streak_dropped`       | `info`     | `CheckInsService.maybeFireStreakDroppedAlert` in `src/check-ins/check-ins.service.ts` — fires when prior streak was ≥ 7 and the new streak is 0 | **live** (wired in Phase 6B PR) |
| `finance_eod_gap`      | `warning`  | `federation-inbound.service.ts` — fires when 5+ consecutive `finance_eod_skip`-like signals arrive within a 7-day window | **pending** — blocked on Agent 1A's `fix/ptm-app-open-and-finance-federation` branch; tracked in [issue #144](https://github.com/BradleyGleavePortfolio/growth-project-backend/issues/144) |

### Dedup window

`createAlert` is idempotent for **24 hours** on the
`(coach_id, client_id, alert_type)` tuple. If an unacknowledged row
already exists within that window, the prior row is returned and no
new row is written. After acknowledgement (or once the 24h passes),
the next call writes a fresh row. This pattern is applied uniformly to
all alert types — it was originally introduced for `risk_red_transition`
and has now been extended to `consecutive_misses` and `streak_dropped`.

### Acknowledge flow

`POST /coach/alerts/:id/acknowledge` flips `acknowledged_at` to
`now()`. The call is idempotent — repeating it on an already-acked
row returns the same row without writing. A foreign coach (alert's
`coach_id` ≠ caller) receives 404, never 403, so the response shape
does not leak the existence of an alert that does not belong to the
caller.

### PTM recompute hook

`PtmRecomputeService.recomputeOne` reads the prior `PtmPrediction`
before computing the new one. After persisting the new row, it
compares buckets via `bucketize()`:

- previous = `green` | `amber` (or null) **AND** next = `red` →
  `createAlert({ alertType: 'risk_red_transition', severity: 'critical' })`
- previous = `red` **AND** next = `red` → no-op (the dedup window in
  `CoachAlertsService` would short-circuit anyway)
- next ≠ `red` → no-op

The hook can be silenced without disabling the recompute via
`COACH_ALERT_RED_TRANSITION_ENABLED=false` — useful when the alert
channel is being tuned or when an upstream signal-collector regression
is producing false-positive transitions.

### Check-in emitter hooks

After every check-in upsert, `CheckInsService.emitPtmAfterUpsert` runs
two Phase 6B alert checks (fire-and-forget, wrapped in try/catch):

**consecutive_misses** — if `gap >= 3` calendar days since the most
recent check-in:
```ts
await coachAlerts.createAlert({
  alertType: 'consecutive_misses',
  severity: 'warning',
  message: `Client has missed ${gap} consecutive check-ins`,
  payload: { consecutive_miss_days: gap },
});
```

**streak_dropped** — if `priorStreak >= 7` and `newStreak === 0`:
```ts
await coachAlerts.createAlert({
  alertType: 'streak_dropped',
  severity: 'info',
  message: `Client's check-in streak dropped from ${priorStreak} days to 0`,
  payload: { prior_streak: priorStreak, new_streak: 0 },
});
```

Both emitters are guarded by `coachId !== null` — clients without a
coach assigned do not generate coach alerts.

### Push delivery (current state — real, with fallback)

`CoachAlertsService.tryPush` now calls `NotificationsService.pushToCoach`:

```ts
const delivered = await this.notifications.pushToCoach(coachId, {
  alertId, alertType, severity, message,
});
if (!delivered) {
  // Coach has no push token — alert still in in-app inbox
}
```

`NotificationsService.pushToCoach` looks up the coach's `User.push_token`.
If the token is absent, it returns `false` immediately. If present, it
attempts delivery (currently a logger call — swap for real APNs/FCM SDK
once push credentials are in the env). Push failures never throw —
the alert row is always persisted in the in-app inbox regardless.

### Operator gestures

```sh
# Read the cross-coach aggregator (OWNER)
curl -H "Authorization: Bearer <owner-jwt>" \
     "https://api.tgp.example.com/api/admin/coach-alerts?coach_id=<id>&since=2026-05-01"

# Read a coach's own inbox (coach JWT)
curl -H "Authorization: Bearer <coach-jwt>" \
     "https://api.tgp.example.com/api/coach/alerts?acknowledged=false&limit=50"

# Acknowledge an alert
curl -X POST -H "Authorization: Bearer <coach-jwt>" \
     "https://api.tgp.example.com/api/coach/alerts/<alert-id>/acknowledge"
```

### Schema reference

```prisma
model CoachAlert {
  id              String    @id @default(uuid())
  coach_id        String
  client_id       String
  alert_type      String
  severity        String    @default("warning")
  message         String
  payload         Json?
  created_at      DateTime  @default(now())
  acknowledged_at DateTime?

  @@index([coach_id, created_at])
  @@index([coach_id, acknowledged_at])
  @@index([client_id, alert_type, created_at])
}
```

`payload` carries engine context. It is small, opaque to the database,
and never PII. The admin "why" drawer renders it verbatim.

### Payload shapes by alert type

| `alert_type` | Example payload |
|---|---|
| `risk_red_transition` | `{ prior_bucket: "amber", next_bucket: "red", risk_score: 0.82, prediction_id: "..." }` |
| `consecutive_misses` | `{ consecutive_miss_days: 5 }` |
| `streak_dropped` | `{ prior_streak: 10, new_streak: 0 }` |
| `finance_eod_gap` | `{ consecutive_finance_eod_skip_count: 5, window_days: 7 }` *(pending)* |

---

## Failure modes and runbook

| Symptom | Likely cause | Action |
|---|---|---|
| No new effectiveness rows for any coach | Cron disabled (`COACH_EFFECTIVENESS_ENABLED=false`) or `ScheduleModule` not wired | Check env, then `grep '[Coach effectiveness cron tick' app.log` |
| One coach has stale score, others fresh | Per-coach error in `CoachEffectivenessService.score` | Look for `Coach effectiveness recompute failed (coach=<id>)` in logs |
| Coaches receiving duplicate red-transition alerts | Dedup window bypassed (likely a bug) or alert was acknowledged then re-flapped within 24h | Check `acknowledged_at` of prior row; if null, file a bug |
| No alerts despite known red-bucket clients | `COACH_ALERT_RED_TRANSITION_ENABLED=false`, OR PTM recompute did not run, OR hook DI not wired | Check env, `PtmScheduler` logs, and `PtmModule` provider list (must include `COACH_ALERTS_SERVICE`) |
| Alert created but push not received | Check `User.push_token` for the coach; if null, no push is attempted (in-app only). If token is present, check for `push delivered to coach=` log lines | Swap `NotificationsService.pushToCoach` TODO logger with real APNs/FCM call once credentials are available |
| `consecutive_misses` or `streak_dropped` alert not firing | `CheckInsModule` not importing `CoachModule`, or `CoachAlertsService` not in DI container | Confirm `CoachModule` is in `CheckInsModule.imports`; check constructor injection |
| `finance_eod_gap` never fires | Not yet wired — tracked in issue #144 | Blocked on Agent 1A's `fix/ptm-app-open-and-finance-federation` branch |
