// Team Mode foundation — permission matrix + resolver.
//
// Single source of truth for the matrix described in §8 of
// docs/architecture/adr-0001-team-mode-foundation.md.
//
// Pure module: no I/O, no Nest, no Prisma. The caller is responsible
// for resolving `isAssigned` and `sameTeam` from the database (or a
// batch pre-load) before calling `can(...)`.
//
// IMPORTANT: nothing in the runtime imports this file today. The
// wiring PR (separate, future) will add a TeamPermissionGuard that
// composes with the existing JwtAuthGuard + RolesGuard chain.

import type { TeamAction, TeamRole, TeamScope } from './roles';
import type { PermissionActor, PermissionContext } from './types';

// ------------------------------------------------------------------
// Matrix rows
// ------------------------------------------------------------------
//
// Each row maps a (role, action) pair to the maximum scope at which
// the role is permitted. A scope of `null` means "denied at any
// scope".
//
// Resolution rules in `can(...)`:
//   - `self`     ⊂ `assigned` ⊂ `team` ⊂ `global`. A row granting
//                  `team` therefore grants `assigned` and `self` too.
//   - `null`     means denied unconditionally (subject to platform
//                  OWNER bypass, which short-circuits before the
//                  matrix is consulted).
//
// `client` rows are omitted entirely: a member with role=client
// has zero team-management permissions. Platform OWNER and
// non-Team-Mode actors are handled by the resolver, not the matrix.

type RowsForRole = Partial<Record<TeamAction, TeamScope | null>>;

const ROW_TEAM_OWNER: RowsForRole = {
  'roster.view': 'team',
  'staff.invite': 'team',
  'staff.revoke': 'team',
  'staff.promote_to_head_coach': 'team',
  'staff.demote_head_coach': 'team',
  'team.transfer_ownership': null, // platform OWNER only — see ADR §8 footnote
  'client.view_profile': 'team',
  'client.view_health': 'team',
  'client.message': 'team',
  'client.reassign': 'team',
  'lead.message': 'team',
  'team.edit_branding': 'team',
  'team.manage_invite_codes': 'team',
  'team.open_billing_portal': 'team',
  'metrics.view_team': 'team',
  'metrics.view_self': 'self',
};

const ROW_HEAD_COACH: RowsForRole = {
  'roster.view': 'team',
  'staff.invite': null,
  'staff.revoke': null,
  'staff.promote_to_head_coach': null,
  'staff.demote_head_coach': null,
  'team.transfer_ownership': null,
  'client.view_profile': 'team',
  'client.view_health': 'team',
  'client.message': 'team',
  'client.reassign': 'team',
  'lead.message': 'team',
  'team.edit_branding': null,
  'team.manage_invite_codes': null,
  'team.open_billing_portal': null,
  'metrics.view_team': 'team',
  'metrics.view_self': 'self',
};

const ROW_JUNIOR_COACH: RowsForRole = {
  'roster.view': 'self',
  'staff.invite': null,
  'staff.revoke': null,
  'staff.promote_to_head_coach': null,
  'staff.demote_head_coach': null,
  'team.transfer_ownership': null,
  'client.view_profile': 'assigned',
  'client.view_health': 'assigned',
  'client.message': 'assigned',
  'client.reassign': null,
  'lead.message': 'assigned',
  'team.edit_branding': null,
  'team.manage_invite_codes': null,
  'team.open_billing_portal': null,
  'metrics.view_team': null,
  'metrics.view_self': 'self',
};

const ROW_SETTER: RowsForRole = {
  'roster.view': null,
  'staff.invite': null,
  'staff.revoke': null,
  'staff.promote_to_head_coach': null,
  'staff.demote_head_coach': null,
  'team.transfer_ownership': null,
  'client.view_profile': null,
  'client.view_health': null,
  'client.message': null,
  'client.reassign': null,
  'lead.message': 'team',
  'team.edit_branding': null,
  'team.manage_invite_codes': null,
  'team.open_billing_portal': null,
  'metrics.view_team': null,
  'metrics.view_self': 'self',
};

const ROW_OPS: RowsForRole = {
  'roster.view': 'team',
  'staff.invite': null,
  'staff.revoke': null,
  'staff.promote_to_head_coach': null,
  'staff.demote_head_coach': null,
  'team.transfer_ownership': null,
  'client.view_profile': null,
  'client.view_health': null,
  'client.message': null,
  'client.reassign': null,
  'lead.message': null,
  'team.edit_branding': 'team',
  'team.manage_invite_codes': 'team',
  'team.open_billing_portal': null,
  'metrics.view_team': null,
  'metrics.view_self': 'self',
};

// `client` has no team-management permissions of its own; the empty
// row makes that explicit in code. The matrix exporter still lists
// it so a future test can assert "every TeamRole has a row".
const ROW_CLIENT: RowsForRole = {};

export const PERMISSION_MATRIX: Readonly<Record<TeamRole, RowsForRole>> = {
  team_owner: ROW_TEAM_OWNER,
  head_coach: ROW_HEAD_COACH,
  junior_coach: ROW_JUNIOR_COACH,
  setter: ROW_SETTER,
  ops: ROW_OPS,
  client: ROW_CLIENT,
};

// ------------------------------------------------------------------
// Resolver
// ------------------------------------------------------------------

const SCOPE_ORDER: Record<TeamScope, number> = {
  self: 0,
  assigned: 1,
  team: 2,
  global: 3,
};

function scopeAtLeast(granted: TeamScope, requested: TeamScope): boolean {
  return SCOPE_ORDER[granted] >= SCOPE_ORDER[requested];
}

export interface CanInput {
  actor: PermissionActor;
  action: TeamAction;
  scope: TeamScope;
  context?: PermissionContext;
}

// Pure permission check.
//
// Returns `true` iff the actor may perform `action` at the requested
// `scope` given `context`. All decisions are derived from
// PERMISSION_MATRIX plus the platform-OWNER bypass plus a short list
// of cross-cutting invariants (see comments inline).
export function can(input: CanInput): boolean {
  const { actor, action, scope, context } = input;

  // 1) Platform OWNER bypass. Mirrors RolesGuard. A platform OWNER
  //    can hit any team-mode action at any scope, including the
  //    explicitly-denied `team.transfer_ownership`.
  if (actor.isPlatformOwner) return true;

  // 2) An actor with no team role has zero permissions inside a team.
  //    They may still have other (non-team) permissions, which the
  //    existing RolesGuard handles upstream of this resolver.
  if (actor.teamRole === null) return false;

  // 3) Look up the row.
  const row = PERMISSION_MATRIX[actor.teamRole];
  const granted = row[action];

  // 4) Unset entry (undefined) is a deny-by-default. Explicit `null`
  //    is also a deny — both produce the same outcome here. The
  //    distinction (`null` vs `undefined`) matters only for the
  //    matrix-completeness test (see test/team-mode-permissions.spec.ts).
  if (granted === null || granted === undefined) return false;

  // 5) Granted scope must subsume the requested scope.
  if (!scopeAtLeast(granted, scope)) return false;

  // 6) Cross-cutting invariants (per ADR §5.4 + §8):
  //
  //    - `assigned` scope requires `context.isAssigned === true`
  //      AND `context.sameTeam === true` to actually act on a
  //      specific client. The matrix grant is necessary but not
  //      sufficient. The caller is responsible for resolving
  //      these flags from ClientAssignment.
  if (scope === 'assigned') {
    if (context?.sameTeam !== true) return false;
    if (context?.isAssigned !== true) return false;
  }

  //    - `team` scope requires `context.sameTeam === true`. A
  //      head_coach in team A may not act team-wide on a client in
  //      team B even though their matrix row grants `team`.
  if (scope === 'team') {
    if (context?.sameTeam !== true) return false;
  }

  return true;
}

// Convenience helper used by future controllers and CSV exporters.
// Returns `true` for every action in `actions` for which `can` would
// return true at the supplied scope. Pure; just composes `can`.
export function canAll(
  base: Omit<CanInput, 'action'>,
  actions: TeamAction[],
): boolean {
  return actions.every((action) => can({ ...base, action }));
}
