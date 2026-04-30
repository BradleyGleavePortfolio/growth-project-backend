// Team Mode foundation — DTO-shaped types.
//
// These types describe the shape the future API will return for Team
// Mode entities. They are NOT Prisma models — Prisma will generate
// its own types when the migration lands. Until then, these stand in
// as the contract a future controller / Nest DTO can be validated
// against.
//
// Pure types only. No imports from Prisma, Nest, or class-validator.

import type { TeamRole } from './roles';

export interface TeamDTO {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: string; // ISO-8601
  archivedAt: string | null;
}

export interface TeamMembershipDTO {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  invitedByUserId: string | null;
  invitedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface ClientAssignmentDTO {
  id: string;
  teamId: string;
  clientUserId: string;
  assignedToUserId: string;
  assignedByUserId: string;
  assignedAt: string;
  revokedAt: string | null;
}

// Input shape the future TeamPermissionGuard hands to `can(...)`.
// Kept here (not in permissions.ts) so DTO consumers can reuse the
// shape without pulling in the matrix.
export interface PermissionActor {
  // The team-mode role of the acting user, or `null` if the user
  // is not yet attached to a team (e.g. platform OWNER, brand-new
  // signup). When null, only `isPlatformOwner=true` actors can
  // pass any check; everyone else is denied by default.
  teamRole: TeamRole | null;
  // Platform OWNER bypass. Mirrors RolesGuard semantics so platform
  // OWNERs (Growth Project staff) keep working without any
  // additional matrix entries.
  isPlatformOwner: boolean;
}

export interface PermissionContext {
  // Whether the actor's `assigned_to_user_id` set contains the target
  // client. Resolved by the caller before invoking `can(...)` so the
  // resolver itself stays I/O-free.
  isAssigned?: boolean;
  // Whether the actor and the target are in the same team. Required
  // for any non-`self` non-`global` scope.
  sameTeam?: boolean;
}
