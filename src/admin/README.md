# admin

OWNER-only platform administration. The endpoints here are the operator
surface for promoting users, listing coaches with their roster stats, and
provisioning the per-coach `CoachProfile` row that drives the default
invite link.

## Purpose

- Single, audited path for `student → coach` and `student → owner`
  promotion. The self-service `become-coach` flow only handles password
  re-auth for an already-known account; cross-account elevation is
  exclusively this module.
- Lazy creation of `CoachProfile` rows so a coach gets a default invite
  code at promote-time without a follow-up call.
- Read-only inventory of coaches and users for the OWNER console.

## Key files

| File | What it owns |
|---|---|
| `admin.controller.ts` | `/admin/*` HTTP surface; class-level `@UseGuards(JwtAuthGuard, RolesGuard) @Roles('owner')` |
| `admin.service.ts` | Promotion, profile provisioning, listing, and 7-day activity stats |
| `admin.dto.ts` | `PromoteUserDto` — class-validator rules for the body |
| `admin.module.ts` | Wires `AdminController` and `AdminService` |

## Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/admin/coaches` | Every coach with their profile and active client count |
| `GET` | `/admin/coaches/:id` | One coach plus students and 7-day activity (logs, workouts, messages) |
| `GET` | `/admin/users?role=&q=&limit=` | Filterable user search; max 200 |
| `POST` | `/admin/users/:id/promote` | Promote/demote `role` and, on `coach`, ensure a `CoachProfile` |
| `GET` | `/admin/metrics?since_days=` | Authoritative platform counters from Postgres. `since_days` clamped to `(0, 365]`, defaults to 30. Stripe-sourced figures come from the webhook mirror, never synthesized. Documented in [`../../docs/metrics.md`](../../docs/metrics.md). |
| `GET` | `/admin/audit-log` | Cursor-paginated read over `AuditLog`. Filters: `action`, `target_user_id`, `tenant_coach_id`, `before`, `limit` (clamped `[1, 200]`, default 50). Documented in [`../../docs/audit-and-gdpr.md`](../../docs/audit-and-gdpr.md). |
| `GET` | `/admin/federation/search?q=&limit=` | Cross-product search across fitness Postgres + finance backend. See `federation/README.md`. |
| `GET` | `/admin/federation/clients/lookup?email=` | Per-client unified view with explicit fitness/finance product split. |
| `GET` | `/admin/federation/coaches/lookup?email=` | Per-coach unified view with explicit fitness/finance product split. |
| `GET` | `/admin/search?q=&limit=` | Console-friendly alias for the unified search bar. Same payload as `/admin/federation/search`. See `console/README.md`. |
| `GET` | `/admin/coaches/:id/overview` | Console coach-detail screen, id-keyed. Resolves to the same federation payload as `/admin/federation/coaches/lookup`. |
| `GET` | `/admin/clients/:id` | Console client-detail screen, id-keyed. Resolves to the same federation payload as `/admin/federation/clients/lookup`. |
| `GET` | `/admin/clients/:id/unified` | Alias of `/admin/clients/:id` for the console's unified-record verb. |
| `GET` | `/admin/clients/:id/entitlements` | Just the entitlement block for this client: `{ user_id, email, entitlements }`. See [`../../docs/entitlements.md`](../../docs/entitlements.md). |
| `GET` | `/admin/clients/:id/ptm` | Per-client PTM teaching detail: latest score, last-30 history, current outcome (no notes), recent signal aggregates. OWNER-only. See [`ptm/README.md`](./ptm/README.md). |
| `POST` | `/admin/clients/:id/outcome` | Label a client outcome (`churned`, `renewed`, ...) and trigger an immediate PTM recompute. Snapshots last-30-day signal counts to `ClientOutcome.signal_snapshot`. Writes `AuditLog` action `ptm.outcome_labelled`. Notes persisted but never returned. See [`ptm/README.md`](./ptm/README.md). |
| `GET` | `/admin/coaches/:id/entitlements` | Just the entitlement block for this coach: `{ user_id, email, entitlements }`. 404 for non-coach roles. |
| `GET` | `/admin/finance/health` | Liveness probe of the finance federation surface (real call to finance `/health`); returns `status`, `probe.identity_mapping`, `probe.service`, `probe.reason` for the operator status pill. |
| `GET` | `/admin/integrations/status` | Aggregate integrations envelope; currently only `finance_federation` populated. |
| `GET` | `/admin/product/usage` | Aggregate product-usage split (DAU/WAU/MAU + role split + EOD/what-if/coach-notes/milestones counters), proxied from finance `/usage/product`. Carries an explicit `status` field when finance is unreachable. |
| `GET` | `/admin/ptm/outcome-history?outcome_type=&before=&limit=` | Labelled-outcome training set, newest-first. Joined with user (id, email) and labeller (id, email). `before` cursor on `labelled_at`. `limit` clamped `[1, 200]`, default 50. Notes never returned. See [`ptm/README.md`](./ptm/README.md). |
| `GET` | `/admin/ptm/risk-board?bucket=&cursor=&limit=` | Per-student most-recent prediction sorted by `risk_score` DESC. `bucket` filter (`green`/`amber`/`red`) applied server-side. `cursor` on `computed_at`. `limit` defaults to env `PTM_RISK_BOARD_PAGE_SIZE` (fallback 50), clamped `[1, 100]`. Factors blob NOT returned. See [`ptm/README.md`](./ptm/README.md). |
| `GET` | `/admin/reports` | Manifest of available operational reports + supported formats. See `reports/README.md` and [`../../docs/admin-reports.md`](../../docs/admin-reports.md). |
| `GET` | `/admin/reports/{metrics-overview,coaches,clients,billing-past-due,product-usage,federation-health,audit-summary}?format=json\|csv` | OWNER-only operational exports. Each report response is wrapped in a `{ report, generated_at, window, data }` envelope. CSV downloads name themselves `<report>-YYYYMMDD.csv`. Source data comes verbatim from the existing live endpoints / Prisma reads — no fabricated values. |
| `GET` | `/admin/reports/transformation-scorecard?user_id=&coach_id=&since_days=&format=json\|csv` | Phase 5 — per-client transformation snapshot composed from live Postgres reads (identity, latest CheckIn, WeightLog deltas, 30-day workout / meal / messaging engagement, latest PtmPrediction + ClientOutcome). With `coach_id` returns that coach's roster (clamped to 1000); with neither walks every student (clamped to 1000). Phase-3 `DiagnosticSubmission` and Phase-4 `BuildWeekEnrollment` reads are defensive — missing tables render the corresponding columns `null`. See [`reports/README.md`](./reports/README.md) and [`../../docs/admin-reports.md`](../../docs/admin-reports.md). |

### Cross-product admin console (federation + alias layer)

The Healthie/EHR-style admin console is mounted as two cooperating
sublayers, both under `/api/admin/*`, both class-gated by
`@Roles('owner')`:

- **Federation primitives** at `/admin/federation/*`
  (`src/admin/federation/`, see its `README.md`). The canonical
  cross-product reads. Joins fitness Postgres rows with finance
  backend records on lowercased email; surfaces an explicit
  `finance.status` envelope (`ok` / `not_found` / `not_configured` /
  `auth_unconfigured` / `timeout` / `network_error` / `http_error` /
  `malformed_response`) so the console renders a degraded-state pill
  instead of synthetic data when finance is unreachable. Configured
  via `FINANCE_API_BASE_URL`, `FINANCE_SERVICE_TOKEN`,
  `FINANCE_FEDERATION_TIMEOUT_MS`. Merged in PR #79.
- **Console alias routes** at `/admin/{search,coaches/:id/overview,clients/:id,clients/:id/unified,finance/health,integrations/status}`
  (`src/admin/console/`, see its `README.md`). Thin id-keyed verb
  layer the console renders against; translates the user-id the
  console hands us into a fitness email and delegates to
  `FederationService` so the unified payload is identical to the
  federation response. Adds a real `/admin/finance/health` probe
  whose status is `ok` / `not_found` (still healthy) /
  `not_configured` / `auth_unconfigured` / `degraded` with the
  underlying `reason`. Merged in PR #80; depends on PR #79.

The console is **admin-only by definition**. Coach and student
tokens get a clean 403 from the class-level guard; there is no
client-facing surface.

## Request / data flow

1. Every route is class-gated: `JwtAuthGuard` resolves `req.user`, then
   `RolesGuard` requires `role === 'owner'`.
2. `promoteUser` updates `User.role` and, when promoting to `coach`,
   calls `ensureCoachProfile` to lazy-create the `CoachProfile` with a
   unique `GP-XXXXXX`-style invite code.
3. `getCoachDetail` aggregates 7-day counts from `LoggedFoodEntry`,
   `WorkoutSession`, and `CoachMessage` over the coach's roster in
   parallel. Empty rosters short-circuit to zeros.

## Security and tenancy rules

- Class-level `@Roles('owner')` is the only authorization. There is no
  per-row tenancy check below it because OWNER is the platform-wide
  superuser.
- Self-demotion is rejected: an OWNER cannot set their own role to
  anything other than `owner`. This keeps at least one OWNER online and
  prevents an accidental lockout.
- Invite-code generation uses an unambiguous alphabet (no `0/O/1/I/L`)
  and a unique constraint with retry on `P2002`. After 8 collisions the
  call surfaces an internal error rather than looping forever.
- Promotion does not touch the target user's `coach_id`; demoting a
  coach back to `student` leaves their original `coach_id` link
  unchanged. Operators who want to fully reset that relationship do so
  via SQL after archiving the existing roster.

## Environment variables

This module relies on the platform-wide secrets only. No admin-specific
env vars; promotion and listing are pure database operations.

## Failure modes

- Promotion against an unknown user → 404 `User not found`.
- Self-demotion → 400 `Cannot demote yourself`.
- Unique-constraint thrash on the invite-code unique index → 500 after 8
  retries. In practice this never happens against a 30-bit space.
- A coach with no `CoachProfile` (legacy data) → `getCoachDetail` returns
  `profile: null` rather than failing. The next promotion call repairs
  the row via `ensureCoachProfile`.

## Tests

The promotion + profile-provisioning paths are exercised through the
end-to-end SaaS smoke (`test/e2e-saas-smoke.spec.ts`) and indirectly
through `test/invite-codes.service.spec.ts`. The role gate is exercised
through `test/dto-mass-assignment.spec.ts` and the
`test/throttler.module.spec.ts` suite that walks every controller's
guard configuration.

## Operational notes

- The bootstrap script at `scripts/bootstrap-owners.ts` is the one-shot
  way to seed the initial OWNER list and back-fill `CoachProfile` rows
  for any pre-existing coaches. It is idempotent — re-running does not
  modify existing rows.
- For the Phase 1A rollout the canonical OWNER emails default to the
  two named operators (see `scripts/bootstrap-owners.ts`); override via
  `BOOTSTRAP_OWNER_EMAILS` for staging or local boxes.
- `getCoachDetail` is the read for the OWNER coach-detail screen. The
  7-day window is hard-coded; widen the window in code if a follow-up
  ever needs 30/90-day history — do not push date filtering down to the
  client.
