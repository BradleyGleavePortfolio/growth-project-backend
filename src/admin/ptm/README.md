# admin/ptm

OWNER-only Predictive Tracking Model teaching surface for the admin
console. Phase 1C of the PTM rollout. Layered on top of the Phase 1A
foundation (`src/ptm/ptm.service.ts`, `prisma/schema.prisma` ClientSignal
/ ClientOutcome / PtmPrediction models) and the Phase 1B heuristic engine
(`src/ptm/ptm-heuristic.service.ts`, `ptm-recompute.service.ts`).

## Purpose

- **Active teaching path.** An OWNER labels a real-world outcome
  (`churned`, `renewed`, `upgraded`, ...) on a known student and the
  PTM service immediately snapshots the last 30 days of signal counts
  into `ClientOutcome.signal_snapshot`. The weighted v2 engine (Phase
  1D) trains against that frozen snapshot so older signals being
  GDPR-scrubbed cannot retroactively rewrite the training set.
- **"Who's about to churn?" view.** A risk-board endpoint returns each
  student's most-recent prediction sorted by `risk_score` DESC,
  bucketed via the shared `bucketize()` thresholds, cursor-paginated
  on `computed_at`. The factors blob is intentionally omitted from
  the list so the operator never accidentally exfiltrates the model's
  internal reasoning into a CSV export — the per-client detail
  endpoint is the only path that exposes it.
- **Human-readable training set.** The outcome-history endpoint dumps
  every labelled `ClientOutcome` with the user/labeller anchors so an
  operator can audit the teaching corpus without a database session.
- **Audited every time.** Every label writes an `AuditLog` row under
  the `ptm.outcome_labelled` action with the prior outcome (if any)
  in metadata so re-labels are recoverable.

## Key files

| File | What it owns |
|---|---|
| `admin-ptm.controller.ts` | `/admin/clients/:id/outcome`, `/admin/clients/:id/ptm`, `/admin/ptm/risk-board`, `/admin/ptm/outcome-history`. Class-level `@UseGuards(JwtAuthGuard, RolesGuard) @Roles('owner')`. |
| `admin-ptm.service.ts` | Outcome upsert + signal snapshot, latest-prediction-per-user aggregation, recent-signal aggregates, public outcome shape (no `notes`). |
| `admin-ptm.dto.ts` | `LabelOutcomeDto`, `RiskBoardQueryDto`, `OutcomeHistoryQueryDto` — class-validator rules pinned to the `PtmOutcomeType` enum. |

## Endpoints

All routes are mounted under `/api/admin/*` and guarded by
`@UseGuards(JwtAuthGuard, RolesGuard) @Roles('owner')`. Coach/student
tokens get a clean 403; unauthenticated requests get 401.

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/admin/clients/:id/outcome` | Validate `:id` is a real student (404 otherwise). Snapshot last-30-day signal counts grouped by signal_type into `ClientOutcome.signal_snapshot`. Upsert by `user_id` capturing prior `outcome_type` for the audit row. Write `AuditLog` action `ptm.outcome_labelled`. Trigger `PtmRecomputeService.recomputeOne(id)`. Return `{ outcome: ClientOutcome (no notes), prediction: latest PtmPrediction }`. |
| `GET` | `/admin/clients/:id/ptm` | Returns `{ client: { id, email, role, name }, latest_prediction, score_history (last 30 desc), outcome (no notes), recent_signals: [{ signal_type, count, last_at }] }`. |
| `GET` | `/admin/ptm/risk-board?bucket=&cursor=&limit=` | Each student's most-recent prediction joined with `user` (id, email, role, name). Sorted by `risk_score` DESC, then `computed_at` DESC. `bucket` filter applied server-side. `cursor` is the last row's `computed_at` (rows with `computed_at < cursor` returned next). `limit` defaults to `PTM_RISK_BOARD_PAGE_SIZE` (fallback 50), clamped `[1, 100]`. **Factors blob is NOT returned** — only `factors_count`. |
| `GET` | `/admin/ptm/outcome-history?outcome_type=&before=&limit=` | All labelled outcomes joined with user (id, email) and labeller (id, email). Ordered by `labelled_at` DESC. `before` cursor on `labelled_at`. `limit` defaults 50, clamped `[1, 200]`. **Notes never returned.** |

## Tenancy and auth

- Class-level `@Roles('owner')` is the only authorization. There is no
  per-coach variant in 1C — coaches do not teach the model in this
  phase. Every recovery path (404 on unknown student, 403 from the
  guard) returns before any read of the prediction or signal tables.
- Mobile clients NEVER hit this surface. There is no path-rewrite
  onto `/admin/ptm/*` in the mobile API gateway, and the class guard
  blocks even if the route were reachable.
- The DTO `outcome_type` whitelist is the same `PtmOutcomeType` enum
  Prisma enforces at the row level. A request with an unknown
  outcome string fails validation before the service runs, and the
  database itself rejects bad enums on the server side as defense in
  depth.

## Doctrine notes

- **Notes never returned.** `ClientOutcome.notes` is persisted to the
  row but every `select` clause in `admin-ptm.service.ts` omits the
  column. The public response type is
  `Omit<ClientOutcome, 'notes'>`. Operators with a need to read a
  labeller's free-form notes do so via direct database access under
  legal review — there is no API path.
- **Advisory-only.** Every endpoint here is read-or-label. The PTM
  scoring path is owned by `src/ptm/`; this module never touches
  `PtmPrediction` writes directly. The recompute call goes through
  `PtmRecomputeService.recomputeOne`, which itself appends a fresh
  `PtmPrediction` row rather than mutating prior rows.
- **No model internals on the list view.** The risk-board response
  carries `factors_count` (a number) but never the `factors` JSON
  blob. The blob lives in the per-client detail endpoint behind a
  named click — this avoids surface-area for accidental inclusion in
  CSV dumps or screenshot dashboards.
- **Audit before response.** `AuditService.write` is awaited before
  the response returns. The audit service catches its own write
  errors internally so the outer flow is still 5xx-safe.

## Failure modes

- Target `:id` is not a `student` user → 404 `Student not found`.
- Recompute throws (heuristic engine outage, etc.) → outcome row and
  audit row already persisted; the controller logs the error and
  returns the existing latest prediction (which may be `null` if the
  client has never been scored).
- Risk-board cursor parses as `NaN` → treated as "no cursor", returns
  the first page.

## Tests

| Spec | Surface |
|---|---|
| `test/admin-ptm.controller.spec.ts` | Coach/student tokens get 403 from the class guard; OWNER tokens reach each handler; DTO validation rejects unknown `outcome_type` and notes >2000 chars. |
| `test/admin-ptm.service.spec.ts` | `labelOutcome` upserts, snapshots last-30-day signal counts via `prisma.clientSignal.groupBy`, writes the `ptm.outcome_labelled` AuditLog row, triggers recompute. `getRiskBoard` returns sorted-by-risk rows with bucket filter applied and cursor pagination on `computed_at`. |
