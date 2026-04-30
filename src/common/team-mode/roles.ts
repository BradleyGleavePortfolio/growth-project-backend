// Team Mode foundation — roles + action vocabulary.
//
// Pure constants. Nothing here imports Prisma, Nest, or any other
// runtime. See docs/architecture/adr-0001-team-mode-foundation.md for
// definitions and the full permission matrix.

export const TEAM_ROLES = [
  'team_owner',
  'head_coach',
  'junior_coach',
  'setter',
  'ops',
  'client',
] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

// Roles that may be **assigned a client**. Setters and ops never own
// clients (per ADR §5.4); the platform OWNER bypasses this list and
// is handled separately in permissions.ts.
export const ASSIGNABLE_TEAM_ROLES: ReadonlyArray<TeamRole> = [
  'team_owner',
  'head_coach',
  'junior_coach',
];

// Roles that count as "staff" — i.e. people working *in* the
// business as employees of the team owner. Excludes platform
// OWNER (a separate concept) and excludes `client`.
export const STAFF_TEAM_ROLES: ReadonlyArray<TeamRole> = [
  'team_owner',
  'head_coach',
  'junior_coach',
  'setter',
  'ops',
];

// Discrete actions the permission matrix grants/denies.
//
// Naming convention: `<resource>.<verb>` for object actions,
// `<noun>.<verb>` for top-level operations.
export const TEAM_ACTIONS = [
  // Roster + membership
  'roster.view',
  'staff.invite',
  'staff.revoke',
  'staff.promote_to_head_coach',
  'staff.demote_head_coach',
  'team.transfer_ownership',
  // Client work
  'client.view_profile',
  'client.view_health',
  'client.message',
  'client.reassign',
  // Lead / pre-paying flows
  'lead.message',
  // Team admin
  'team.edit_branding',
  'team.manage_invite_codes',
  'team.open_billing_portal',
  // Metrics
  'metrics.view_team',
  'metrics.view_self',
] as const;

export type TeamAction = (typeof TEAM_ACTIONS)[number];

// Scope of an action: who the actor is acting on.
//   - `self`     : the actor themselves
//   - `assigned` : a client the actor is assigned to (ClientAssignment)
//   - `team`     : team-wide (any client/member in this team)
//   - `global`   : platform-wide (only meaningful for platform OWNER)
export type TeamScope = 'self' | 'assigned' | 'team' | 'global';
