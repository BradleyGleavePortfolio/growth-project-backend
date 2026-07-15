# ADR — Importer Import-Status Read: A Feature-Flagged, Tenant-Scoped, Evidence-Only Status Endpoint

- **Status:** Accepted
- **Date:** 2026-07-15
- **Decision owner:** Bradley Gleave (repo owner)
- **Lane:** IMPORTER — backend read surface for the mobile import-progress UI
- **Affected files:** `src/scout/scout.controller.ts`, `src/scout/scout.service.ts`,
  `src/scout/scout.dto.ts`, `src/analytics/events.ts`, `scripts/importer-contract.ts`,
  `docs/contracts/importer-openapi.json` (regenerated), plus co-located + contract specs.

## Context

The mobile app needs to render an honest import-progress screen for a single
tgp-importer run. Today the only importer read is the extension's own
cross-device progress snapshot (`POST /api/scout/progress` → `ScoutProgressSnapshot`),
whose counts are **extension-claimed estimates** (`total_estimated`), not proof.
The mobile client should not treat a peer client's self-reported numbers as
server truth, and it has no server-authoritative view of whether a run is still
running or has settled.

The backend already owns two provable facts per `(coach_id, intent_id)`:

1. `ScoutIngestEntity` — one row per entity the crawl actually committed
   (idempotent on `(coach_id, intent_id, source_id)`). A `groupBy(entity_type)`
   count is **server-authoritative committed volume**.
2. `ScoutImport` — the parent lifecycle row, created only at settle by
   `complete()`, carrying the verbatim `terminal_status`
   (`success | partial | failed`) and `completed_at` (R-STATE-1).

## Problem

Expose a read that returns **only states the backend can prove** for one run,
scoped to the calling coach in the data layer, feature-flagged OFF by default,
with no tokens, captured payloads, or PII — **without** inventing a second state
machine or a duplicate store.

## Root cause

There was no read projection over the existing importer tables. The write path
(`complete()`) is the sole owner of `ScoutImport`; nothing surfaced its state
plus the `ScoutIngestEntity` proof to a client. The blocker is a missing
read, not a missing model — so the fix is a projection over existing tables,
preceded by a bounded, single-flight persist of the requested run's own already
accepted-in-memory snapshot (no new state, no new store).

## Options considered

- **(a) Reflect the extension progress snapshot directly.** Cheapest, but
  dishonest: it ships a peer client's `total_estimated` estimates as if they were
  server truth, and cannot distinguish running from settled. Rejected — violates
  "expose only what the backend can prove."
- **(b) Introduce a dedicated `ImportRunStatus` table + a lifecycle state machine
  written on every ingest/progress/complete.** Most expressive (true `pending`,
  live `running`, `cancelled`), but a second source of truth that can disagree
  with `ScoutImport`/`ScoutIngestEntity`, plus a migration and write-path changes
  this PR is not scoped for. Rejected — duplicate storage + second state machine,
  explicitly forbidden.
- **(c) [CHOSEN] Read projection over existing tables (with a bounded requested-key
  handoff persist).** `getImportStatus`
  reads `ScoutImport` (verbatim terminal state + timestamps) and a
  `ScoutIngestEntity.groupBy` (authoritative committed counts) under a
  coach-scoped `WHERE`, derives `running` only from present evidence, and 404s an
  unknown/unowned intent. No new table, no second state machine, additive
  contract.

## Musk five-step result

- **Questioned:** Do we need a new lifecycle table? No — the required states are
  already derivable. Do we need `pending`/`cancelled`? No — neither is
  representable in the current model, so exposing them would be a lie.
- **Deleted:** The `pending` and `cancelled` states (no backing evidence) and the
  extension `total_estimated` estimates (not server-authoritative) are omitted
  from the response, not faked.
- **Simplified:** One projection method + one GET handler; status is
  `ScoutImport.terminal_status` reflected verbatim, or `running` when evidence
  exists but no settle row does.
- **Accelerated:** A single pre-read, **tenant + intent scoped** persist of only
  THIS run's cached snapshot (`flushRun`) so a just-started run whose snapshot is
  still cached is recognised as `running` rather than 404'd. This means the read
  MAY cause a bounded, idempotent write of the requested run's own key(s) — never
  another tenant's backlog, and never O(global backlog) work. It is not a pure
  read. The write is single-flight (concurrent reads for the same key join one
  in-flight upsert — no duplicate write, no gap that could false-404).

  **Read vs completion failure semantics differ deliberately.** On the read path
  a `flushRun` failure **propagates**: the read **fails closed** (5xx), never a
  misleading 404 for a run whose accepted snapshot could not be persisted, and the
  snapshot stays pending for retry. `complete()` reuses the same `flushRun` but
  **swallows** its failure (structured warn, run id only — no PII): settle takes
  its terminal state from the transaction below and its counts from
  `ScoutIngestEntity`, so it never depends on the progress snapshot persisting. A
  poison/deterministically-unpersistable snapshot therefore cannot wedge
  completion; the item is left pending (retryable) and a later read still fails
  closed on it. Then three parallel bounded reads (`Promise.all`) keyed on
  existing unique/index columns: `ScoutImport` on `@@unique([coach_id,intent_id])`,
  `ScoutIngestEntity.groupBy where{coach_id,intent_id}` served by the
  `@@unique([coach_id,intent_id,source_id])` prefix (carrying `_min.created_at`
  for the first-observation timestamp — no extra query), and the latest
  `ScoutProgressSnapshot where{coach_id,intent_id}` served by the
  `@@unique([coach_id,intent_id,device_id])` prefix for the `started_at` fallback;
  no scan, no N+1.

- **Automated last:** The frozen OpenAPI slice is regenerated by
  `npm run contract:importer` and pinned by the byte-identical drift test — the
  contract is enforced by CI, not by hand.

## Idiot-index result

Theoretical minimum to satisfy the goal is "project the two tables the backend
already writes." Option (c) is at that floor: zero new storage, zero new writers,
zero new migration. Complexity removed vs. option (b): one table, one state
machine, one migration, and three write-path edits — all avoided while
preserving the full value (a provable status for the UI).

## Extreme test

- **10x/100x reads:** it is a bounded, indexed projection plus at most one
  idempotent single-flight upsert of the requested run's own cached snapshot; it
  scales with per-run entity cardinality (small, fixed entity families), and
  carries a per-caller throttle. The optional write is confined to the requested
  key — repeated or concurrent reads of the same run coalesce onto one in-flight
  upsert, so read volume does not amplify into extra writes.
- **Worst case (unknown/spoofed intent, cross-tenant probe):** every query is
  scoped by `coach_id` from the **token identity**, never a body/query field, so
  a coach probing another coach's `intent_id` gets the same `404` as a genuinely
  unknown id — no existence oracle (IDOR-safe, ENGINEERING_RULES §1: 404 not 403).
- **Worst case (flag off):** `featureFlagNotFoundMiddleware` returns a uniform
  `404` for the whole `/api/scout*` surface before any guard runs, so the route
  is indistinguishable from unmounted.

## Hyperscaler lens

- **Reliability/failure-containment:** the only write it can trigger is an
  idempotent upsert of the requested run's own progress snapshot (no cross-run,
  no cross-tenant reach); a DB blip on that write leaves the snapshot pending for
  retry and surfaces as a generic 5xx via the standard filter — the read fails
  closed rather than returning a false 404, and no other run's state is touched.
  `complete()`, by contrast, is decoupled from that snapshot: it flushes the run
  best-effort and continues to settle even if the flush fails, so an
  unpersistable (e.g. poison) snapshot cannot wedge completion — settle owns the
  terminal state and counts come from `ScoutIngestEntity`, not the snapshot.
- **Reversibility:** additive contract (version bump `1.0.0 → 1.1.0`), flag OFF
  by default; rollback is flag-off or revert with zero data migration.
- **Observability:** emits a non-PII RED-signal analytics event
  (`scout.import.status.read` with `{ intent_id, status }`) — no tokens, no
  payloads, no names. Follows the LaunchDarkly/Statsig "default-off, dark-launch"
  pattern and the Stripe posture of returning a stable, minimal read projection
  rather than internal rows.

## Good without bad

Benefit preserved: the mobile UI gets a server-authoritative, single-run status
with provable committed counts and true terminal state. Failure mode excluded:
no fabricated `pending`/`cancelled`, no peer-reported estimates dressed as truth,
no cross-tenant leakage, no PII in telemetry, no second state machine to drift.
The terminal error class is carried by `status` itself (`partial`/`failed`); a
separate `error_class` field was dropped as redundant (R131 delete step), and the
free-text `error_summary` is never surfaced (it could carry arbitrary content).

## Evidence required

- Service specs: every represented state (`running`, `success`, `partial`,
  `failed`), unknown-intent → 404, tenant scoping / IDOR (query keyed by
  passed `coachId`), partial-honesty (committed counts reflect only persisted
  rows; estimates absent), no-PII in the emitted event and the result shape.
- DTO specs: malformed/empty/oversized `intent_id` rejected by the global
  ValidationPipe.
- Controller specs: `@Roles('coach','owner')`, throttle metadata, GET path,
  identity taken from `req.user.id` not the query.
- Feature-flag spec: `/api/scout/import/status` 404s when `FEATURE_SCOUT_INGEST`
  is off.
- Contract: `/scout/import/status` added to the frozen slice; byte-identical
  drift test passes against the regenerated `importer-openapi.json`.

## Rollback / stop

Set `FEATURE_SCOUT_INGEST` unset/`!== 'true'` (the default) to dark the route, or
revert the PR. No migration, no data backfill, so rollback is instantaneous and
lossless. **Stop condition:** if the LOC/ratio gate cannot be met within one
coherent PR, split the contract bump out rather than requesting an exemption.

## Next action

Implement `getImportStatus` + the GET handler, add the read DTOs and the
analytics event, extend `IMPORTER_BARE_PATHS` and bump `CONTRACT_VERSION` to
`1.1.0`, regenerate the artifact, and land the test suite above.

## Deliberate non-goals

- **No cancellation.** The model has no cancel representation; adding one is a
  separate write-path change, out of scope (per task constraint).
- **No `pending`.** Nothing exists before the first ingest/progress, so there is
  no evidence to report; omitted rather than faked.
- **No change to `POST /api/scout/progress`** or any existing write route.
