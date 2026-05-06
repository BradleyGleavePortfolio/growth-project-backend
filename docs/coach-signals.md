# Coach Signals — operator runbook (Phase 6A + 6B)

This document covers the two coach-side analytic surfaces that Phase 6
adds on top of PTM:

- **6A — Coach Effectiveness Score.** A nightly per-coach scalar in
  `[0, 100]` plus a bucket label (`developing` / `consistent` /
  `high-performer`). OWNER-only consumer; coaches do not see their own
  number, by design.
- **6B — Proactive Red Flag Alerts.** Per-coach `CoachAlert` rows
  written when a client crosses a behavioral threshold (currently:
  PTM bucket flips to `red`). Coaches read their own inbox; OWNER
  reads the cross-coach aggregator.

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
| Emitter | `PtmRecomputeService.maybeFireRedTransitionAlert` (in `src/ptm/ptm-recompute.service.ts`) |

### Alert types

| `alert_type`            | Severity   | Triggered by | Status |
|---|---|---|---|
| `risk_red_transition`  | `critical` | PTM recompute when bucket goes `green|amber → red` | **live** |
| `consecutive_misses`   | `warning`  | ≥ 5 consecutive `checkin_miss` signals | reserved (slot in enum; emitter not yet wired) |
| `streak_dropped`       | `info`     | `streak_dropped` signal observed | reserved |
| `finance_eod_gap`      | `warning`  | ≥ 14 days without a `finance_eod` signal | reserved |

### Dedup window

`createAlert` is idempotent for 24h on the
`(coach_id, client_id, alert_type)` tuple. If an unacknowledged row
already exists within that window, the prior row is returned and no
new row is written. After acknowledgement (or once the 24h passes),
the next call writes a fresh row. This stops a flapping signal from
producing a notification storm.

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

The hook is fire-and-forget at the call site:

```ts
try {
  await this.coachAlerts.createAlert({...});
} catch (err) {
  this.logger.error(...);
}
```

A failure in alert creation never propagates back into the recompute
(which is itself best-effort and tolerates per-user failures).

The hook can be silenced without disabling the recompute via
`COACH_ALERT_RED_TRANSITION_ENABLED=false` — useful when the alert
channel is being tuned or when an upstream signal-collector regression
is producing false-positive transitions.

### Push delivery (current state)

`CoachAlertsService.tryPush` is a logging stub:

```
[CoachAlertsService] would push to coach=<id> type=<alert_type> sev=<severity>: <message>
```

Real per-coach push delivery lands when `NotificationsModule` grows a
transport for it. Until then alerts are still stored and rendered in
the in-app inbox; the operator sees delivery intent in logs. No new
external dep is added.

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

`payload` carries engine context (e.g. `prior_bucket`, `next_bucket`,
`risk_score`, `prediction_id` for `risk_red_transition`). It is small,
opaque to the database, and never PII. The admin "why" drawer renders
it verbatim.

---

## Failure modes and runbook

| Symptom | Likely cause | Action |
|---|---|---|
| No new effectiveness rows for any coach | Cron disabled (`COACH_EFFECTIVENESS_ENABLED=false`) or `ScheduleModule` not wired | Check env, then `grep '[Coach effectiveness cron tick' app.log` |
| One coach has stale score, others fresh | Per-coach error in `CoachEffectivenessService.score` | Look for `Coach effectiveness recompute failed (coach=<id>)` in logs |
| Coaches receiving duplicate red-transition alerts | Dedup window bypassed (likely a bug) or alert was acknowledged then re-flapped within 24h | Check `acknowledged_at` of prior row; if null, file a bug |
| No alerts despite known red-bucket clients | `COACH_ALERT_RED_TRANSITION_ENABLED=false`, OR PTM recompute did not run, OR hook DI not wired | Check env, `PtmScheduler` logs, and `PtmModule` provider list (must include `COACH_ALERTS_SERVICE`) |
| Alert created but nothing in app/push | `tryPush` is a stub; the in-app inbox endpoint should still return the row | Verify `GET /coach/alerts` returns the row; push lands when NotificationsModule grows the transport |
