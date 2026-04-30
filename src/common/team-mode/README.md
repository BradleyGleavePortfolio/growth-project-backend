# Team Mode scaffolding

This directory contains the **pure** TypeScript scaffolding for the
Team Mode foundation described in
[`docs/architecture/adr-0001-team-mode-foundation.md`](../../../docs/architecture/adr-0001-team-mode-foundation.md).

**Nothing in this directory is wired into the runtime.** No module
imports it; no controller calls it; no migration depends on it. It
exists so that the permission contract for Team Mode can be reviewed
and unit-tested ahead of the schema and controller work.

Removing this directory and its accompanying test
(`test/team-mode-permissions.spec.ts`) is a clean revert.

## Files

- `roles.ts` — the `TeamRole` enum and the `TeamAction` action vocabulary.
- `permissions.ts` — the permission matrix (one row per action) and
  the `can(...)` resolver. Pure function; no I/O. The single source of
  truth for §8 of the ADR.
- `types.ts` — DTO-shaped TypeScript types for `Team`, `TeamMembership`,
  and `ClientAssignment`. These are *contracts*, not Prisma models —
  they describe the shape the API will return once the schema lands.

## Wiring

The wiring PR (a *separate* PR, not this one) will:

1. Add the migration that introduces `Team`, `TeamMembership`, and
   `ClientAssignment` plus the `TeamRole` enum.
2. Add a `TeamPermissionGuard` that calls `can(...)` from this
   directory.
3. Add a `@TeamPermission(...)` decorator that the guard reads.
4. Wire the guard into the controllers that need team-aware gates.

Until that PR lands, the value of this directory is exactly:

- The matrix is reviewable as code, not as prose.
- The `can(...)` function is unit-tested with high coverage on a
  pure input/output shape.
- The wiring PR can land as a smaller, mechanical change against an
  already-agreed contract.
