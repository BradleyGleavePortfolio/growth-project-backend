# ADR — IMPORTER-G: Authoritative Coach-Scoped Read Bridge for the Reconstructed Invite-Pending Roster

- **Status:** Accepted
- **Date:** 2026-07-17
- **Decision owner:** Bradley Gleave (repo owner)
- **Lane:** IMPORTER-G — backend read bridge that unblocks mobile PR-M3
- **Canonical context:** builds directly on IMPORTER-F (D2 DECIDED, Op 59); see
  `2026-07-16-importer-f-scout-reconstruct.md`.
- **Affected files:** `src/scout/scout-roster.dto.ts`,
  `src/scout/scout-roster.service.ts`, `src/scout/scout-roster.controller.ts`,
  `src/scout/scout.module.ts`, `src/analytics/events.ts`,
  `scripts/importer-contract.ts`, `docs/contracts/importer-openapi.json`
  (regenerated), plus co-located + contract specs.

## Context

IMPORTER-F (`POST /api/scout/reconstruct`) turns a **settled** crawl intent's
staged `clients` into invite-pending, non-login, tenant-owned canonical `Person`
rows, recording per-entity outcomes in `ScoutReconstructionLedger`. The write
side is complete and dark-by-default.

Mobile **PR-M3** must show the coach the roster those reconstructions produced —
the invite-pending imported clients — plus honest accounting (how many
reconstructed / skipped / failed). Its mandated stop-gate **rejected**
implementation because there was no honest read path:

- The existing roster contracts `/coach/clients` and `/v1/coach/me/clients` read
  auth `User role=student` and never expose `Person`. Invite-pending imports have
  no `User`, so they are invisible to those endpoints.
- The scout import-status read (`GET /api/scout/import/status`) exposes ingest
  **committed counts**, not the authoritative reconstruction ledger or the
  materialized `Person` rows.

So mobile cannot honestly show the reconstructed roster delta. This is the
confirmed blocker.

## Decision

Add a dedicated, coach-scoped, tenant-isolated **read** endpoint:

```
GET /api/scout/reconstruct/roster?intent_id=<id>&cursor=<opaque>&limit=<1..200>
```

backed **directly** by the two canonical IMPORTER-F tables — `Person`
(materialized roster) and `ScoutReconstructionLedger` (honest per-entity
accounting) — with no shadow table, no cache, and no new state.

### Options evaluated

- **(A) Extend `/v1/coach/me/clients` to include pending `Person` rows —
  REJECTED.** That endpoint is an auth-`User`-backed contract consumed by every
  existing roster client. Splicing non-login `Person` rows into it would change a
  widely-consumed shape (regression risk across all roster clients), blur the
  canonical `User` vs `Person` lifecycle distinction, and force one shape onto two
  different identity models. No rigorous compatibility evidence makes A safer than
  a dedicated endpoint, so the locked backward-compatibility invariant forbids it.
- **(B) Dedicated read-model endpoint over `Person` + ledger — CHOSEN.** Smallest
  backward-compatible canonical solution: additive, dark-by-default, touches no
  existing endpoint, reads the two canonical tables under mechanical coach
  scoping and the existing service-role/RLS boundary.
- **(C) Project `Person` rows into `User`/auth rows — REJECTED by D2.** Minting
  `AuthPrincipal`/`User`/credential/session for invite-pending imports (or keying
  on email) directly violates the D2 locked invariant. Rejected outright.

### Route placement / feature gating

The route is deliberately a **subpath of `/api/scout/reconstruct`** so it
inherits the existing R-DARK-1 registry entries unchanged: it is dark unless
**both** `FEATURE_SCOUT_INGEST` and `FEATURE_SCOUT_RECONSTRUCT` are exactly
`"true"`. Zero middleware change, zero new env var — the read cannot be exposed
more broadly than the write it reads from.

### Contract

`accounting` mirrors the IMPORTER-F reconstruct result exactly
(`{ staged, reconstructed, skipped, failed }`), so a partial pass is visible
(`staged > reconstructed + skipped + failed`). `staged` is the authoritative
`ScoutIngestEntity` source count; the other three are ledger-derived. `persons`
is a deterministic, cursor-paginated (`source_id` asc) list joining
`reconstructed` ledger rows to their `Person`, exposing only the opaque `id`,
lifecycle `state`, provenance (`source_platform`, `source_person_id`),
`display_name`, and timestamps. `Deleted` persons are excluded (erasure
preserved). Pagination is bounded (default 50, max 200); the cursor is an opaque
base64url token; a malformed cursor / oversized limit fails closed (400).

## Security / isolation

- Coach identity is taken **only** from the authenticated server context
  (`req.user.id`) — never body/query. A `coach_id`/`intent_id` in the query or
  body cannot spoof tenant.
- Every query is mechanically scoped `WHERE coach_id = caller.id`; the `Person`
  join re-asserts `coach_id` as defense in depth.
- Unknown/cross-tenant intent → uniform **404** (no existence oracle), gated on a
  `ScoutImport` row for `(coach, intent)`.
- `Person` + `ScoutReconstructionLedger` remain RESTRICTIVE deny-all to
  anon/authenticated; the read runs server-side as `service_role`. No secrets,
  email, or billing fields are ever returned or logged.

## What is NOT built

- No claim/link/invite flow; no `User`/credential minting (D2).
- No cross-intent aggregate roster — intent-scoped only, matching the reconstruct
  write's unit of work.
- No mutation, no schema change, no migration.
- No change to `/coach/clients`, `/v1/coach/me/clients`, or any existing endpoint.
- No new feature flag and no broadening of the existing dark gate.

## Consequence

PR-M3 consumes this endpoint to honestly render the reconstructed invite-pending
roster and its accounting, clearing its stop-gate. The endpoint stays dark in
production until both scout flags are enabled.
