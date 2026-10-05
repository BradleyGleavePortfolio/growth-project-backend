import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';

export interface CoachScope {
  /** The caller (head coach or sub-coach). */
  actorId: string;
  /** Head coach id: the tenant and the CoachMessage thread namespace. */
  tenantId: string;
  /** Clients the caller may message (live students only). */
  clientIds: string[];
}

/** Why the send-time authority check refused a copy (A-659-7). */
export type SendAuthorityRefusal = 'author_not_in_tenant' | 'not_on_roster' | 'author_not_assigned';

interface LockedUser {
  id: string;
  role: string;
  coach_id: string | null;
  deleted_at: Date | null;
}

/**
 * Single place that answers "whose roster is this caller allowed to reach".
 * Reuses SubCoachScopeService (the same rule the command center and the
 * 1:1 messaging path use), so a sub-coach reaches only assigned clients and
 * every row is written under the head coach's tenant id.
 */
@Injectable()
export class BroadcastScopeService {
  constructor(private readonly subCoachScope: SubCoachScopeService) {}

  async resolve(actorId: string): Promise<CoachScope> {
    const [clientIds, head] = await Promise.all([
      this.subCoachScope.getAuthorizedClientIds(actorId),
      this.subCoachScope.getHeadCoachIdForSubCoach(actorId),
    ]);
    return { actorId, tenantId: head ?? actorId, clientIds };
  }

  /**
   * A-659-7: the same rule as `resolve(authorId).clientIds.includes(clientId)`
   * with `tenantId` as the effective tenant, decided INSIDE the caller's
   * message transaction and held until it commits. The author's and the
   * client's User rows, the membership row that proves the author's team
   * (SubCoachScopeService.lockMembershipHeadCoachIdInTx) and, for a sub-coach,
   * the open assignment to this client are read FOR SHARE. A seat removal,
   * reassignment, transfer, role change or deletion that committed first is
   * seen here and refuses the copy; one that starts later waits until the
   * copy has committed. Null means the author may message this client now.
   */
  async lockSendAuthority(
    tx: Prisma.TransactionClient,
    tenantId: string,
    authorId: string,
    clientId: string,
  ): Promise<SendAuthorityRefusal | null> {
    const author = await lockUser(tx, authorId);
    if (!author || author.deleted_at || author.role !== 'coach') return 'author_not_in_tenant';
    const head = await this.subCoachScope.lockMembershipHeadCoachIdInTx(tx, authorId, author);
    if ((head ?? authorId) !== tenantId) return 'author_not_in_tenant';
    const client = await lockUser(tx, clientId);
    if (!client || client.deleted_at || client.role !== 'student' || client.coach_id !== tenantId) {
      return 'not_on_roster';
    }
    if (authorId === tenantId) return null;
    const open = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "SubCoachAssignment"
      WHERE "sub_coach_id" = ${authorId} AND "client_id" = ${clientId} AND "unassigned_at" IS NULL
      LIMIT 1 FOR SHARE`;
    return open.length > 0 ? null : 'author_not_assigned';
  }
}

async function lockUser(tx: Prisma.TransactionClient, id: string): Promise<LockedUser | null> {
  const rows = await tx.$queryRaw<LockedUser[]>`
    SELECT "id", "role"::text AS "role", "coach_id", "deleted_at"
    FROM "User" WHERE "id" = ${id} FOR SHARE`;
  return rows[0] ?? null;
}
