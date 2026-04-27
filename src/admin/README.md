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
