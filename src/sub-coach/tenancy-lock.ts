import { Prisma } from '@prisma/client';

/**
 * D8 — ONE atomic authorization/write protocol for every privileged (service-role, BYPASSRLS)
 * assignment writer (PR #593 fix round 3, R593-c7A2-01).
 *
 * The coach-client tenancy facts an assignment write depends on are
 *   - the client's `User.coach_id` (direct roster; changed by a roster reassignment),
 *   - the actor's `User.role` / `User.coach_id` (sub-coach team membership), and
 *   - the OPEN `SubCoachAssignment` rows actor -> client (closed by a delegation revocation).
 *
 * Prisma's interactive transaction runs at READ COMMITTED: each statement takes a fresh snapshot, so
 * a plain SELECT followed by an INSERT is NOT atomic with respect to a concurrent UPDATE of those
 * facts. This helper reads the facts with `SELECT ... FOR SHARE` INSIDE the caller's write
 * transaction. Consequences (PostgreSQL row-lock semantics):
 *   - a reassignment / revocation UPDATE that has not committed yet blocks on the share lock until
 *     the write transaction ends, so it cannot interleave between check and commit;
 *   - a reassignment / revocation that committed first makes our locking read wait for it and then
 *     re-evaluate the WHERE clause against the committed row version, so the predicate sees the
 *     revoked / reassigned state and the writer refuses.
 * Either serialization is consistent: an assignment is committed only against tenancy facts that
 * hold at its commit.
 *
 * The caller MUST pass its transaction client; on a non-transactional client the read is a plain
 * (autocommit) read and the lock is released immediately — correct as a pre-check, never as a gate.
 */
export type TenancyLockDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface TenancyUserFacts {
  id: string;
  role: string;
  coach_id: string | null;
  deleted_at: Date | null;
}

export interface LockedTenancyFacts {
  actor: TenancyUserFacts | null;
  client: TenancyUserFacts | null;
  /** True when an OPEN SubCoachAssignment (actor -> client, unassigned_at IS NULL) exists — locked FOR SHARE. */
  openDelegation: boolean;
}

/** Lock (FOR SHARE) and read the tenancy facts for `actorId` acting on `clientId`. */
export async function lockTenancyFacts(
  db: TenancyLockDb,
  actorId: string,
  clientId: string,
): Promise<LockedTenancyFacts> {
  const users = await db.$queryRaw<TenancyUserFacts[]>(
    Prisma.sql`SELECT "id", "role"::text AS "role", "coach_id", "deleted_at" FROM public."User" WHERE "id" IN (${actorId}, ${clientId}) FOR SHARE`,
  );
  const actor = users.find((u) => u.id === actorId) ?? null;
  const client = users.find((u) => u.id === clientId) ?? null;
  let openDelegation = false;
  if (actor && client) {
    const open = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM public."SubCoachAssignment" WHERE "sub_coach_id" = ${actorId} AND "client_id" = ${clientId} AND "unassigned_at" IS NULL FOR SHARE`,
    );
    openDelegation = open.length > 0;
  }
  return { actor, client, openDelegation };
}

/**
 * `SubCoachScopeService.canAccessClient` semantics over locked facts: the actor is a coach; a
 * sub-coach (coach_id set) reaches the client through an OPEN delegation; a head coach through the
 * direct roster; in both cases the client is a live (not soft-deleted) student.
 */
export function evaluateCanAccessClient(f: LockedTenancyFacts): boolean {
  if (!f.actor || f.actor.role !== 'coach' || !f.client) return false;
  const liveStudent = f.client.role === 'student' && f.client.deleted_at === null;
  if (f.actor.coach_id) return f.openDelegation && liveStudent;
  return f.client.coach_id === f.actor.id && liveStudent;
}

/**
 * `SubCoachScopeService.canActOnClient` semantics over locked facts (== the RLS helper
 * app.actor_coaches_client and WorkoutBuilderService.assertCanAccessClient): (a) the client's
 * coach_id is the actor (no role / deletion test), OR (b) canAccessClient admits the actor.
 */
export function evaluateCanActOnClient(f: LockedTenancyFacts, actorId: string): boolean {
  if (!f.client) return false;
  if (f.client.coach_id === actorId) return true;
  return evaluateCanAccessClient(f);
}
