# Team Mode scaffolding

Pure TypeScript scaffolding for the Team Mode permission matrix
(see [`docs/architecture/adr-0001-team-mode-foundation.md`](../../../docs/architecture/adr-0001-team-mode-foundation.md)).

The matrix is referenced conceptually by the wiring layer in
`src/team-mode/`, but `src/common/team-mode` itself remains a pure
module with no runtime imports — keeping the matrix reviewable in
isolation from the controllers and schema.

## Files

- `roles.ts` — the `TeamRole` enum and the `TeamAction` action vocabulary.
- `permissions.ts` — the permission matrix (one row per action) and
  the `can(...)` resolver. Pure function; no I/O. The single source of
  truth for §8 of the ADR.
- `types.ts` — DTO-shaped TypeScript types for `Team`, `TeamMembership`,
  and `ClientAssignment`. Contracts only; the live Prisma models added
  by the v1 migration (`TeamSubCoachAssignment`, `TeamAuditEvent`)
  live in the runtime layer.

## Runtime wiring

`src/team-mode/` is the v1 runtime. It registers `TeamModeModule`
(see `src/app.module.ts`) and ships:

- `TeamModeService` — assign / remove / list sub-coaches; write and
  read curated audit events.
- `TeamModeTierResolverService` — resolves the head coach's tier
  (`growth | pro | enterprise | unknown`) from
  `CoachSubscription.stripe_price_id` via env-var mapping.
- `TeamModeController` — REST surface under `/team/*` with per-route
  `JwtAuthGuard + CoachGuard`.

The §10 resolutions (Q1–Q6, locked 2026-05-10) drove the schema and
service shape; see ADR §10a for the resolution table.
