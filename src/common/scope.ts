import type { User } from '@prisma/client';

/**
 * Phase 1B scope helpers.
 *
 * `scopeToCoach` returns a Prisma `where` clause fragment that limits a
 * client/student-bearing list to rows the calling user is allowed to
 * see:
 *
 *   - OWNER: empty filter (sees every coach's roster).
 *   - COACH: `{ coach_id: user.id }` — only their own clients.
 *   - everyone else: `{ id: user.id }` — only themselves.
 *
 * Centralizing this here means list controllers do not have to redo the
 * "OWNER bypass" check on every endpoint. Spread it into a Prisma
 * `where` like:
 *
 *   prisma.user.findMany({ where: { ...scopeToCoach(user), role: 'student' } })
 *
 * `assertCoachOwnsClient` is the single-record form: it throws unless
 * the caller is OWNER or the client's `coach_id` matches the caller.
 */
export type ScopeUser = Pick<User, 'id' | 'role' | 'coach_id'>;

export type CoachScopeFilter =
  | { coach_id: string }
  | { id: string }
  | Record<string, never>;

export function scopeToCoach(user: ScopeUser): CoachScopeFilter {
  if (!user) return { id: '__none__' } as unknown as CoachScopeFilter;
  if (user.role === 'owner') return {};
  if (user.role === 'coach') return { coach_id: user.id };
  return { id: user.id };
}

export function isOwner(user: Pick<User, 'role'> | null | undefined): boolean {
  return !!user && user.role === 'owner';
}

export function canCoachActOnClient(
  user: ScopeUser,
  client: Pick<User, 'coach_id'> | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!client) return false;
  return user.role === 'coach' && client.coach_id === user.id;
}
