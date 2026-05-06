# ptm

Predictive Tracking Model (PTM). Append-only behavioral signal collection,
plus a heuristic + weighted scoring engine and an OWNER teaching surface
in later phases. PTM scores are advisory only — the mobile client never
sees `risk_score` or factor breakdowns.

## Purpose

- Persist every observed behavioral signal in `ClientSignal` so a later
  scoring pass can reconstruct any historical window.
- Expose a single fire-and-forget `PtmService.emit` that callers in the
  five emitting modules (check-ins, weight, workout, food, messaging)
  drop into existing handler success paths.
- Hold the shared types — signal-type strings, outcome-type strings,
  prediction-basis strings, factor and result shapes, and window
  constants — that the heuristic engine (Phase 1B), the admin teaching
  surface (Phase 1C), and the weighted engine (Phase 1D) layer on top of.

## Key files

| File | What it owns |
|---|---|
| `ptm.module.ts` | `@Global()` Nest module exporting `PtmService`. The five emitting modules inject `PtmService` directly without listing this module among their imports. |
| `ptm.service.ts` | Fire-and-forget `recordSignal` / `emit` + score reads (`getLatestPrediction`, `listPredictionHistory`). Catches and logs every DB failure so a PTM table outage cannot bubble back into a user-facing 5xx. |
| `ptm.types.ts` | Shared type table: `PtmSignalTypeT`, `PtmOutcomeTypeT`, `PtmPredictionBasisT`, `PtmScoreResult`, `PtmFactor`, `PTM_WINDOWS`, `PTM_SCORE_BUCKETS`, `bucketize`. Single source of truth — keep aligned with the Postgres `PtmSignalType` / `PtmOutcomeType` / `PtmPredictionBasis` enums in `prisma/schema.prisma`. |

## Endpoints

None in Phase 1A. The OWNER teaching endpoints
(`POST /admin/clients/:id/outcome`, `GET /admin/ptm/risk-board`, etc.)
arrive in Phase 1C. Phase 1B adds the nightly recompute scheduler (no
HTTP surface). Phase 1D activates the weighted v2 engine when at least
20 outcomes have been labelled.

## Signal hooks

Phase 1A wires `PtmService.emit` into the success paths of five
existing modules. Each entry is fire-and-forget — the call returns
synchronously and any failure is logged inside `recordSignal`.

| `signal_type` | Emitting module | Trigger | `value` | `metadata` |
|---|---|---|---|---|
| `checkin_streak` | `check-ins` | `CheckInsService.upsertForClient` after the upsert succeeds | consecutive-day streak ending today | none |
| `checkin_miss` | `check-ins` | same path, when the latest prior check-in is `>= 3` calendar days behind today | gap in days | none |
| `weight_logged` | `weight` | `WeightService.logWeight` after the create | delta vs prior log in lbs (0 on first log) | `{ weight_lbs, prior_weight_lbs }` |
| `workout_logged` | `workout` | `WorkoutService.createWorkout` after the session is persisted | total volume = sum of `weight_per_set[i] * reps_per_set[i]` across every set, rounded | `{ exercise_count, duration_min }` |
| `meal_logged` | `log` (food) | `LogService.logFood` after the create | calories logged (`food_item.calories * quantity_multiplier`, rounded) | `{ meal_type }` |
| `message_sent` | `messaging` | `MessagingService.sendAsClient` after the create | `body.length` | none |
| `message_received` | `messaging` | `MessagingService.sendAsCoach` after the create — `userId` is the **client**, never the coach | `body.length` | none |
| `coach_note_received` | `messaging` | same path, alongside `message_received` | `1` | none |

Other signal types declared in `ptm.types.ts`
(`weight_skipped`, `workout_skipped`, `meal_skipped`, `finance_eod`,
`finance_milestone`, `app_open`, `consistency_low`, `streak_dropped`)
are reserved for later phases and currently have no emitter.

## Design notes

- **Append-only.** `ClientSignal` and `PtmPrediction` are write-only
  tables — there is no `update` or `delete` API. Corrections are a
  fresh row. The heuristic engine in 1B relies on this to reconstruct
  any historical window; the admin "score history" drawer in 1C reads
  `PtmPrediction` ordered by `computed_at desc`.
- **Fire-and-forget signal writes.** `PtmService.emit` returns `void`
  synchronously; the underlying `recordSignal` catches every error and
  logs at `error` level with the `user_id` and `signal_type`. A PTM
  outage MUST NEVER 5xx the upstream handler.
- **No PII in `metadata`.** Counts and category labels only — no
  message bodies, emails, names, or notes. Call sites pass small JSON
  objects like `{ meal_type: 'breakfast' }` or `{ exercise_count: 4 }`.
- **Advisory scores, OWNER/COACH only.** `risk_score`, `success_score`,
  and `factors` never appear in mobile responses. Phase 1C exposes them
  on `/admin/...` endpoints behind the OWNER guard.
- **`@Global()` module.** Emitters do not need to import `PtmModule`.
  This matches the audit module's pattern and keeps the dependency
  graph free of cycles when a future module starts emitting.

## Weighted engine (1D)

`PtmWeightedService` (`ptm-weighted.service.ts`) is the frequency-analysis
weighted v2 engine. It activates once both of the following hold:

1. The number of labelled `ClientOutcome` rows is at least
   `PTM_WEIGHTED_ACTIVATION_OUTCOMES` (default 20).
2. Both the SUCCESS and FAILURE cohorts have at least one row.

Below either bar `isActive()` returns `false` and the recompute
orchestrator falls back to the heuristic engine (`heuristic_v1`).

### Cohort definitions

| Cohort | Outcome labels |
|---|---|
| SUCCESS | `completed_90day`, `upgraded`, `referred`, `milestone_hit`, `renewed` |
| FAILURE | `churned`, `dropped_off` |

### Algorithm

1. Pull every `ClientOutcome` row's `signal_snapshot` JSON. The snapshot
   is captured by Phase 1C at label time and is the canonical training
   set — it survives a GDPR scrub of the underlying raw signals.
2. Bin each row into SUCCESS or FAILURE. Rows whose label is not in
   either cohort, or whose `signal_snapshot` is null (pre-1C labels),
   are skipped; both counts are surfaced via `getCurrentWeights()`.
3. For each `(cohort, signal_type)` pair, compute the average count
   over that cohort's snapshots.
4. Per-signal weight:

   ```
   weight = (avg_in_FAILURE - avg_in_SUCCESS)
          / max(avg_in_FAILURE + avg_in_SUCCESS, 0.1)
   ```

   Roughly `[-1, +1]`. Positive = failure-correlated (risk),
   negative = success-correlated (protective).

5. Score: pull the user's last-30-day signal counts grouped by
   `signal_type`. For each signal multiply the weight by
   `min(observed / training_max, 1)` and sum. Clamp the sum to
   `[-1, +1]`, then `riskScore = (sum + 1) / 2` and
   `successScore = 1 - riskScore`. **Note**: v2 LINKS risk and
   success because the cohort weight already encodes both signs;
   v1 keeps them independent.
6. `factors[]`: top-5 contributing signals by `|contribution|`. Label
   shape: `Weighted: {signal_type} observed {observed} (cohort weight {weight.toFixed(2)})`.

### Caching

Trained weights are cached in-memory for one hour. The trainer re-runs
on cache miss or when `refresh()` is called. The recompute orchestrator
calls `refresh()` after a `labelOutcome` triggers `recomputeOne`; the
1-hour TTL guarantees correctness even if the orchestrator does not.

### Interpretation

- `weight ~ +1` → strong risk signal (concentrated in churn / drop-off).
- `weight ~ -1` → strong protective signal (concentrated in completion / upgrade).
- `weight ~ 0` → no signal — cohort averages are similar, or the signal
  rarely appeared in the training set.

`getCurrentWeights()` returns `success_avg`, `failure_avg`, and
`training_count` per signal so an operator can sanity-check a
surprising weight against the underlying cohort averages without
re-running the trainer.
