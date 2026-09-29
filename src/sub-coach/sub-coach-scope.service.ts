import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * The subset of the Prisma client the scope predicates read. Accepting it as a
 * parameter lets a caller evaluate the predicate INSIDE its own interactive
 * transaction (`tx`), so the tenancy decision and the write it guards read the
 * same snapshot (D8, PR #593 fix round 2).
 */
type ScopeDb = Pick<Prisma.TransactionClient, 'user' | 'subCoachAssignment'>;

/**
 * SubCoachScopeService
 *
 * Resolves which clients a given coach user is authorized to access.
 *
 * Phase 11 model (overlay):
 *   - Head coaches: own a roster directly via User.coach_id = headCoachId.
 *     A head coach sees every client on that roster.
 *   - Sub-coaches: have role='coach' and User.coach_id = headCoachId (they
 *     belong to the head coach team). Their authorized clients come from
 *     open SubCoachAssignment rows where sub_coach_id = userId.
 *
 * This service is the single source of truth for "which clients can THIS
 * coach see?" across roster, messaging, threads, and console APIs. It
 * intentionally does no role-mapping itself — call sites that already know
 * a user is a coach pass in their id and we figure out head vs sub from the
 * data.
 *
 * Detection rule: a user is a SUB-COACH iff role='coach' AND coach_id is
 * non-null (i.e. they themselves are scoped under another head coach). A
 * head coach has role='coach' AND coach_id IS NULL.
 */
@Injectable()
export class SubCoachScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** True if this coach user is a sub-coach (has a parent head coach). */
  async isSubCoach(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, coach_id: true },
    });
    return !!u && u.role === 'coach' && !!u.coach_id;
  }

  /**
   * IDs of clients this coach is authorized to access.
   *
   * - Head coach: every `User.id` where coach_id = userId, role='student',
   *   not soft-deleted.
   * - Sub-coach: every client_id from open SubCoachAssignment rows for
   *   this sub-coach (joined to User to filter out soft-deleted clients
   *   and non-students).
   *
   * Returns [] if the user has no clients (or isn't a coach at all).
   */
  async getAuthorizedClientIds(
    userId: string,
    db: ScopeDb = this.prisma,
  ): Promise<string[]> {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { role: true, coach_id: true },
    });
    if (!u || u.role !== 'coach') return [];

    if (u.coach_id) {
      // Sub-coach: scope through SubCoachAssignment overlay.
      const open = await db.subCoachAssignment.findMany({
        where: { sub_coach_id: userId, unassigned_at: null },
        select: { client_id: true },
      });
      if (open.length === 0) return [];
      const ids = open.map((r) => r.client_id);
      // Filter out soft-deleted clients / non-students at the DB level.
      const live = await db.user.findMany({
        where: { id: { in: ids }, role: 'student', deleted_at: null },
        select: { id: true },
      });
      return live.map((r) => r.id);
    }

    // Head coach: own roster.
    const clients = await db.user.findMany({
      where: { coach_id: userId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    return clients.map((r) => r.id);
  }

  /**
   * Resolve the "thread coach id" for a client message thread when the
   * caller is a sub-coach. Sub-coaches send/receive on behalf of the head
   * coach team: the CoachMessage row's coach_id is the head coach's id
   * (so existing head-coach queries keep working). The sender_id captures
   * which sub-coach actually sent.
   *
   * Returns null if the caller isn't a sub-coach (caller should use their
   * own id as coach_id in that case).
   */
  async getHeadCoachIdForSubCoach(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, coach_id: true },
    });
    if (!u || u.role !== 'coach' || !u.coach_id) return null;
    return u.coach_id;
  }

  /**
   * Check whether `userId` can access `clientId`. Returns true if the
   * caller is a head coach who owns the client, OR a sub-coach with an
   * open assignment to that client.
   */
  async canAccessClient(
    userId: string,
    clientId: string,
    db: ScopeDb = this.prisma,
  ): Promise<boolean> {
    const ids = await this.getAuthorizedClientIds(userId, db);
    return ids.includes(clientId);
  }

  /**
   * THE coach-client tenancy rule for assignment writes (owner decision D8,
   * 2026-09-29): the acting user may write an assignment naming `clientId`
   * when EITHER
   *   (a) the client's `User.coach_id` is the acting user (head coach / owner
   *       direct roster — no test of the target's role or deletion state, exactly
   *       as `WorkoutBuilderService.assertCanAccessClient` evaluates it), OR
   *   (b) `canAccessClient` admits them (a sub-coach with an OPEN
   *       SubCoachAssignment to that live student).
   *
   * This is the predicate `WorkoutBuilderService.assertCanAccessClient` applies on
   * every human assignment write, expressed as a boolean so the AI approval
   * materialisers (which write as the service role, where RLS does not run) can
   * apply the SAME rule at approval time. The RLS helper
   * `app.actor_coaches_client(actor, client)` (migration 20270125000012) encodes
   * the same predicate for the direct-access path; the two must not diverge.
   *
   * Pass `db` to evaluate inside the caller's transaction. Unknown client → false.
   */
  async canActOnClient(
    actingUserId: string,
    clientId: string,
    db: ScopeDb = this.prisma,
  ): Promise<boolean> {
    const client = await db.user.findUnique({
      where: { id: clientId },
      select: { id: true, coach_id: true },
    });
    if (!client) return false;
    if (client.coach_id === actingUserId) return true;
    return this.canAccessClient(actingUserId, clientId, db);
  }
}
