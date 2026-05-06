# PTM — Predictive Tracking Model (operator guide)

The PTM pipeline observes behavioral signals, scores each client's risk
of churn and likelihood of success, and surfaces both to OWNERs and
COACHes through the admin teaching surface (Phase 1C).

This document is the operator-facing reference. The module-level
README at `src/ptm/README.md` is the developer-facing reference; this
file focuses on what an OWNER reading the risk board needs to know.

## Pipeline at a glance

1. **Signal collection (Phase 1A).** Eight emit sites — check-ins,
   weight, workout, food/log, messaging, the JWT auth guard (`app_open`),
   and the finance-federation inbound endpoint (`finance_eod`,
   `finance_milestone`) — call
   `PtmService.emit(userId, signalType, value?, metadata?)` whenever a
   user-observable event happens. Writes are fire-and-forget.
2. **Heuristic scoring (Phase 1B).** A nightly cron at 04:00 UTC walks
   the eligible set (users with >= 1 signal in the last 30 days) and
   appends one fresh `PtmPrediction` row per user. Scoring is
   rule-based with hand-tuned weights.
3. **Weighted scoring (Phase 1D).** Once at least
   `PTM_WEIGHTED_ACTIVATION_OUTCOMES` (default 20) clients have been
   labelled with a `ClientOutcome`, the recompute orchestrator switches
   to the weighted engine. Heuristic remains the fallback.
4. **Admin teaching surface (Phase 1C).** OWNERs label outcomes on
   `POST /admin/clients/:id/outcome`; the risk board reads
   `GET /admin/ptm/risk-board`. The mobile app never reads these.

## Heuristic v1 factors

Each factor either fires or does not. When it fires, its `contribution`
is added to the running `riskScore` (positive = adds risk, negative =
protective). The final `riskScore` is clamped to `[0.0, 1.0]`.

### High-risk factors (each +0.15 to +0.25)

| Key | Window | Contribution | Condition |
|---|---|---|---|
| `checkin_miss_3plus` | 14 days | +0.20 | 3 or more `checkin_miss` signals in the window |
| `app_open_gap_7d` | 7 days | +0.25 | No `app_open` signal in the window |
| `coach_note_gap_10d` | 10 days | +0.15 | No `coach_note_received` signal in the window |
| `weight_skip_14d` | 14 days | +0.15 | No `weight_logged` signal in the window |
| `streak_dropped_recent` | 7 days | +0.20 | A `streak_dropped` signal exists in the window |

### Medium-risk factors (each +0.08 to +0.12)

| Key | Window | Contribution | Condition |
|---|---|---|---|
| `consistency_low_recent` | 30 days | +0.10 | A `consistency_low` signal exists in the window |
| `workout_skip_10d` | 10 days | +0.10 | No `workout_logged` signal in the window |
| `meal_skip_7d` | 7 days | +0.08 | No `meal_logged` signal in the window |
| `finance_eod_skip_5plus` | 7 days | +0.12 | `finance_eod` count < 0.3 of expected (i.e. 5+ misses) |

### Protective factors (each -0.10 to -0.15)

| Key | Window | Contribution | Condition |
|---|---|---|---|
| `checkin_streak_7plus` | 7 days | -0.15 | A `checkin_streak` signal with `value >= 7` exists |
| `finance_milestone_recent` | 14 days | -0.12 | A `finance_milestone` signal exists |
| `coach_note_recent` | 7 days | -0.10 | A `coach_note_received` signal exists |
| `weight_trend_aligned` | 14 days | -0.12 | Avg sign of the last 3 `weight_logged` deltas matches `UserProfile.goal_type` |
| `workout_recent` | 3 days | -0.10 | A `workout_logged` signal exists |

### `weight_trend_aligned` semantics

`weight_logged.value` is the delta vs the prior log (kg). Negative means
the client lost weight. Sign expectation by goal:

- `fat_loss`: average should be negative.
- `muscle_gain`, `performance`: average should be positive.
- `maintenance`: `|avg| < 0.5` (held steady).

The factor is skipped entirely if the `UserProfile` has no `goal_type`
or there are fewer than 2 `weight_logged` signals in the window.

## How to interpret `factors[]` in `PtmPrediction`

Every `PtmPrediction` row carries a `factors` JSON blob. The shape is
the `PtmFactor[]` from `src/ptm/ptm.types.ts`:

```ts
interface PtmFactor {
  key: string;          // stable id, e.g. "checkin_miss_3plus"
  label: string;        // human-friendly, e.g. "3+ missed check-ins in last 14 days"
  contribution: number; // signed contribution to riskScore, range [-0.25, +0.25]
  observed?: number;    // optional raw observation (e.g. count, days since)
}
```

Reading rules:

- **Only firing factors are included.** An empty `factors[]` means no
  rule matched — typically a brand-new client with no recent signals.
- **Sign of `contribution`** tells you whether the factor pushed risk
  up (positive) or down (negative, protective).
- **`observed`** is a hint for the operator. For "no X in last N days"
  factors it carries the days since the last signal of that type
  (or absent if the user never had one). For "count of X" factors it
  carries the count.
- **`riskScore` is the clamped sum**, not the raw sum. If you tally the
  visible contributions and they exceed 1.0, the displayed score is
  capped at 1.0.
- **`successScore` is independent.** A high `successScore` next to a
  high `riskScore` is not a contradiction: a deeply engaged client can
  also be on the brink of burnout. The brief calls this out explicitly.

## Operator runbook

- **Disable the engine.** Set `PTM_SCORING_ENABLED='false'` in Fly
  secrets. The next nightly cron tick logs
  `PTM scoring disabled by env flag` and returns without writing.
- **Tune the cron.** Override `PTM_SCORING_CRON`. Stays in UTC. Pick a
  low-traffic window; the default `0 4 * * *` is one hour after the
  GDPR scrub at `0 3 * * *`.
- **Throttle the batch.** Lower `PTM_RECOMPUTE_BATCH_LIMIT` if the
  recompute is straining the connection pool. The default 5000 is
  conservative for a small roster; raise once you've watched a few
  ticks complete cleanly.
- **Force a recompute.** Call `PtmRecomputeService.recomputeOne(userId)`
  from the admin labelling flow (1C). Each call APPENDs a fresh row.

## Append-only history

Every recompute writes a new `PtmPrediction` row. The risk board reads
the latest with `ORDER BY computed_at DESC LIMIT 1`. The full history is
available via `PtmService.listPredictionHistory(userId, limit)` for the
admin "score drift" drawer (1C).

## Admin teaching surface (Phase 1C)

The OWNER teaching path lives in `src/admin/ptm/`. Coach and student
tokens are rejected by the class-level `RolesGuard` with a clean 403;
the mobile app never hits this surface. Coaches do not teach the model
in 1C — that is intentionally a future-phase decision once the
weighted v2 engine has graduated.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/clients/:id/outcome` | Label a client outcome and trigger immediate recompute. |
| `GET` | `/admin/clients/:id/ptm` | Per-client teaching detail: latest score, history, current outcome (no notes), recent signal aggregates. |
| `GET` | `/admin/ptm/risk-board?bucket=&cursor=&limit=` | Most-recent prediction per student, sorted by `risk_score` DESC. |
| `GET` | `/admin/ptm/outcome-history?outcome_type=&before=&limit=` | Labelled-outcome training set, newest-first. |

### Audit trail

Every outcome label appends an `AuditLog` row with action
`ptm.outcome_labelled`. Metadata carries:

```json
{
  "outcome_type": "churned",
  "prior_outcome_type": "milestone_hit",
  "notes_present": true
}
```

`prior_outcome_type` is the value of the `ClientOutcome.outcome_type`
column before the upsert (or `null` for a first-time label). This is
the canonical history of who taught the model what — re-labels are
recoverable from the audit log even though `ClientOutcome` itself is
upsert-by-`user_id` and only retains the latest label.

`notes_present` records whether the labeller attached free-form notes,
without ever including the note body in the audit row. Notes are
persisted to `ClientOutcome.notes` for the labeller's own reference but
are NEVER returned over the API.

### Example: labelling a churn

```bash
# Label a churn (assumes you already have an OWNER bearer token in $TOKEN)
curl -sS -X POST "https://api.thegrowthproject.app/api/admin/clients/$CLIENT_ID/outcome" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"outcome_type":"churned","notes":"cancelled mid-phase, cited time"}' | jq

# Inspect the audit trail
curl -sS "https://api.thegrowthproject.app/api/admin/audit-log?action=ptm.outcome_labelled&target_user_id=$CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq

# Pull the freshly recomputed prediction + recent signals
curl -sS "https://api.thegrowthproject.app/api/admin/clients/$CLIENT_ID/ptm" \
  -H "Authorization: Bearer $TOKEN" | jq

# Operator view: who's on the red list right now?
curl -sS "https://api.thegrowthproject.app/api/admin/ptm/risk-board?bucket=red&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Doctrine recap

- Notes never returned; the `select` clauses in `admin-ptm.service.ts`
  omit the column on every read path.
- Risk-board list omits the `factors` JSON blob — only `factors_count`
  is exposed there. The full blob is only readable via the per-client
  detail endpoint.
- The factors `key`s (e.g. `checkin_miss_3plus`) are the contract the
  admin "why is this client red?" drawer renders against. Engine
  internals (the `WEIGHTS` table, the activation threshold) are not
  exposed via the API.

## Phase 1D — weighted engine

The weighted engine is a frequency-analysis model that learns from the
OWNER's outcome labels. No external ML dependency, no API call — it is
a few hundred lines of TypeScript that re-trains on cache miss or when
the recompute orchestrator calls `refresh()`.

### Activation

The orchestrator picks an engine per recompute call:

| Condition | Engine | `prediction_basis` written |
|---|---|---|
| Total labelled outcomes < `PTM_WEIGHTED_ACTIVATION_OUTCOMES` (default 20) | Heuristic | `heuristic_v1` |
| Total >= threshold but SUCCESS or FAILURE cohort has 0 rows | Heuristic | `heuristic_v1` |
| Total >= threshold and both cohorts populated | Weighted | `weighted_v2` |

### SUCCESS / FAILURE cohorts

| Cohort | Outcome labels |
|---|---|
| SUCCESS | `completed_90day`, `upgraded`, `referred`, `milestone_hit`, `renewed` |
| FAILURE | `churned`, `dropped_off` |

These are intentionally narrow. New `PtmOutcomeType` values require a
Prisma migration AND a follow-up here so the trainer does not silently
ignore a label.

### Training set

The trainer reads `ClientOutcome.signal_snapshot` — a JSON blob the
Phase 1C label endpoint captures at label time. Each snapshot is the
client's last-30-day count per signal type, frozen at the moment the
OWNER taught the system what happened.

This is deliberate: a client's raw `ClientSignal` rows can be
GDPR-scrubbed, but the snapshot lives on the outcome row. A
sample-size-1 GDPR-scrubbed client still contributes to training as
long as the snapshot was captured.

Snapshots that are null (rows labelled before Phase 1C shipped) are
skipped. `getCurrentWeights()` and the
`/admin/reports/ptm-signal-weights` report both surface
`skipped_no_snapshot` so an operator can see how much of the teaching
set is older-than-1C.

### The weight formula

For each signal type:

```
weight = (avg_in_FAILURE - avg_in_SUCCESS)
       / max(avg_in_FAILURE + avg_in_SUCCESS, 0.1)
```

The `0.1` floor on the denominator guards against signals that simply
do not appear in any snapshot — without it the formula would divide by
zero.

Range is roughly `[-1, +1]`:

- `+1` — appears only in churns / drop-offs.
- `0` — appears equally in both cohorts (no signal).
- `-1` — appears only in completions / upgrades.

### Worked example

Imagine 25 labelled outcomes:

- 15 SUCCESS rows (`completed_90day`), each with snapshot
  `{ checkin_miss: 0, message_received: 12 }`.
- 10 FAILURE rows (`churned`), each with snapshot
  `{ checkin_miss: 8, message_received: 1 }`.

The trainer computes:

| Signal | `success_avg` | `failure_avg` | numerator | denominator | weight |
|---|---|---|---|---|---|
| `checkin_miss` | 0 | 8 | 8 | max(8 + 0, 0.1) = 8 | **+1.00** |
| `message_received` | 12 | 1 | -11 | max(1 + 12, 0.1) = 13 | **-0.85** |

A user whose last-30-day counts are
`{checkin_miss: 8, message_received: 1}` scores:

```
contribution_checkin_miss = +1.00 * (8 / 8)  = +1.00
contribution_message_recv = -0.85 * (1 / 12) ≈ -0.07
rawRisk      = clamp(+1.00 - 0.07, -1, +1) = +0.93
riskScore    = (0.93 + 1) / 2              = 0.965
successScore = 1 - 0.965                   = 0.035
```

`factors[]` surfaces the top-5 signals by absolute contribution, so the
operator sees a `+1.00` row for `checkin_miss` front-and-center.

### How to interpret a `weighted_v2` prediction vs `heuristic_v1`

| Engine | Reasoning | When to trust it more |
|---|---|---|
| `heuristic_v1` | Hand-tuned weights from the brief. No prior data needed. Risk and success are independent axes (a client can be both high-risk and high-success). | First weeks of a coach's deployment, before they have labelled 20 outcomes. |
| `weighted_v2` | Frequency analysis of the actual SUCCESS / FAILURE cohorts. Risk and success are linked (`successScore = 1 - riskScore`) because the weight encodes both signs. | Once the coach has labelled at least 20 outcomes with non-trivial cohort balance. |

When the basis flips from `heuristic_v1` to `weighted_v2`, expect the
score to move — sometimes substantially — because the engines weight
signals differently. The score-history drawer shows the
`prediction_basis` per row so the operator can see exactly when the
flip happened.

A weighted_v2 weight that diverges sharply from the heuristic intuition
is not a bug — it means the OWNER's actual outcome history disagreed
with the brief. The first action is to read `success_avg` and
`failure_avg` for that signal in the
`/admin/reports/ptm-signal-weights` report and confirm the cohort sizes
look representative; a thin slice (say, two rows) is the most common
cause.

### Caching and refresh

Trained weights are cached in-memory for one hour. Two consecutive
score calls within the hour share a single training pass. The
recompute orchestrator calls `PtmWeightedService.refresh()` after the
1C label endpoint triggers a `recomputeOne` so a fresh outcome takes
effect immediately; the 1-hour TTL guarantees correctness even if a
caller forgets to call refresh.

### Operator commands

```bash
# Inspect the current trained weights as JSON.
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/ptm-signal-weights" | jq .

# Same data as CSV — drop into a spreadsheet.
curl -fsS \
  -H "Authorization: Bearer $OWNER_JWT" \
  "https://api.thegrowthproject.app/api/admin/reports/ptm-signal-weights?format=csv" \
  -o ptm-signal-weights-$(date -u +%Y%m%d).csv
```

When the engine is below threshold the JSON response carries
`basis: 'heuristic_v1'`, an empty `data` array, and a `reason` field
(`below_activation_threshold` or `empty_cohort`). The CSV form is a
header line with no rows in that case — the file is still valid CSV.

### Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Report carries `reason: 'below_activation_threshold'` | Fewer than `PTM_WEIGHTED_ACTIVATION_OUTCOMES` labelled outcomes | Label more outcomes via the 1C label endpoint, or lower the threshold via env if you accept the reduced confidence. |
| Report carries `reason: 'empty_cohort'` | All labelled outcomes are SUCCESS-only or FAILURE-only | Wait for the missing cohort to accumulate, or relabel an outcome. |
| `skipped_no_snapshot > 0` | Some outcomes were labelled before Phase 1C shipped | Expected for older labels — the trainer cannot reconstruct a frozen snapshot, so those rows are silently skipped. The remaining rows still produce valid weights. |
| A weight's sign surprises the operator | Cohort imbalance or a thin cohort | Read `success_avg` / `failure_avg` / `training_count` on that row. A `training_count` under ~5 should be treated as noise. |

## Mobile surface (Phase 1E)

The mobile app (`growth-project-mobile`, branch `feat/ptm-risk-board`) adds
the first PTM-aware screens. Files:

- `src/screens/coach/RiskBoardScreen.tsx` — list of clients sorted by
  `risk_score DESC`. Server-side filter (`?bucket=`), cursor pagination,
  pull-to-refresh.
- `src/screens/coach/ClientRiskDetailScreen.tsx` — single-client detail:
  big traffic-light, sorted factor "why" list, last-14 history, "Send
  check-in nudge" action (POSTs through the existing
  `POST /coach/clients/:id/nudges` wire).
- `src/services/ptmApi.ts` — typed wrapper for the four
  `/admin/ptm/*` endpoints.
- `src/components/RiskDot.tsx`, `src/components/FactorRow.tsx` — small
  visual primitives reused across screens.
- Admin Home widget on `CoachHomeScreen` — three small cards showing
  red / amber / green counts across the user's accessible clients.

### Role gating (temporary)

The mobile screen is OWNER-only in Phase 1E because the underlying
`/admin/ptm/*` endpoints are admin-guarded. Coaches see a placeholder
("Coach risk board coming with the next backend release") rather than
fake data. A coach-scoped `GET /coach/clients/risk-board` endpoint is
planned for the next backend release; once it lands, the mobile screen
will branch on role and use the new endpoint for the coach path.

Students must never see PTM scores. The mobile screens defend against
this with an explicit `role==='coach'|'owner'` check on top of the
navigator-level role split.

### What is rendered, and what is not

Rendered: `risk_score`, `factors[].label`, `factors[].observed`, the sign
of `factors[].contribution` (positive → red bar, negative → green bar),
optional `outcome_label`.

NOT rendered: the engine basis (`heuristic_v1` / `weighted_v2` /
`model_v3`), the factor `key`s, the WEIGHTS table, or any internal
heuristic threshold. The same doctrine applies on the admin web surface.
