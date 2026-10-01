import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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
 * Detection rule (tightened in the clinic C13 fix round, audit Opus A1): a
 * user is a SUB-COACH iff role='coach' AND coach_id is non-null AND the head
 * coach has an EXPLICIT membership relation with them — an active
 * `TeamSubCoachAssignment(head_coach_id = coach_id, sub_coach_id = user)`
 * (Team Mode seat / accepted sub-coach invite) or an open
 * `SubCoachAssignment(head_coach_id = coach_id, sub_coach_id = user)` (the
 * head coach delegated a client to them). A bare `coach_id` on a coach row
 * is NOT enough: guest checkout used to stamp `coach_id` onto any buyer, so a
 * self-serve coach who bought another coach's package became a phantom
 * sub-coach with tenant-wide access. Without a membership row the caller is
 * treated as a head coach of their own (possibly empty) roster — never as a
 * member of someone else's tenant.
 */
@Injectable()
export class SubCoachScopeService {
  private readonly logger = new Logger(SubCoachScopeService.name);
  // Warn once per process per anomalous row (coach_id set, no membership) so
  // the A1 chain is visible in logs without flooding them on every request.
  private readonly warnedNoMembership = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Head coach id for `userId` when — and only when — they are a sub-coach
   * with an explicit membership relation to that head coach. Null for head
   * coaches, non-coaches, unknown ids, and coach rows whose `coach_id` has no
   * backing membership row.
   */
  private async resolveMembershipHeadCoachId(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, coach_id: true },
    });
    return this.membershipHeadCoachIdFor(userId, u);
  }

  /** Same as above for an already-loaded `{ role, coach_id }` row. */
  private async membershipHeadCoachIdFor(
    userId: string,
    u: { role: string; coach_id: string | null } | null,
  ): Promise<string | null> {
    if (!u || u.role !== 'coach' || !u.coach_id) return null;

    const teamSeat = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { head_coach_id: u.coach_id, sub_coach_id: userId, archived_at: null },
      select: { id: true },
    });
    if (teamSeat) return u.coach_id;

    const delegation = await this.prisma.subCoachAssignment.findFirst({
      where: { head_coach_id: u.coach_id, sub_coach_id: userId, unassigned_at: null },
      select: { id: true },
    });
    if (delegation) return u.coach_id;

    if (!this.warnedNoMembership.has(userId)) {
      this.warnedNoMembership.add(userId);
      if (this.warnedNoMembership.size > 5_000) this.warnedNoMembership.clear();
      this.logger.warn(
        `sub-coach scope: user=${userId} has role=coach and coach_id=${u.coach_id} but no membership relation (TeamSubCoachAssignment / SubCoachAssignment); treating as head coach of own roster, NOT as a sub-coach`,
      );
    }
    return null;
  }

  /** True if this coach user is a sub-coach (has a parent head coach). */
  async isSubCoach(userId: string): Promise<boolean> {
    return (await this.resolveMembershipHeadCoachId(userId)) !== null;
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
  async getAuthorizedClientIds(userId: string): Promise<string[]> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, coach_id: true },
    });
    if (!u || u.role !== 'coach') return [];

    const headCoachId = await this.membershipHeadCoachIdFor(userId, u);
    if (headCoachId) {
      // Sub-coach: scope through SubCoachAssignment overlay.
      const open = await this.prisma.subCoachAssignment.findMany({
        where: { sub_coach_id: userId, unassigned_at: null },
        select: { client_id: true },
      });
      if (open.length === 0) return [];
      const ids = open.map((r) => r.client_id);
      // Filter out soft-deleted clients / non-students at the DB level.
      const live = await this.prisma.user.findMany({
        where: { id: { in: ids }, role: 'student', deleted_at: null },
        select: { id: true },
      });
      return live.map((r) => r.id);
    }

    // Head coach: own roster.
    const clients = await this.prisma.user.findMany({
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
   * own id as coach_id in that case). This is the tenant-promotion hook used
   * by packages / coach-media / command-center / workout-builder, so it
   * requires the explicit membership relation described above.
   */
  async getHeadCoachIdForSubCoach(userId: string): Promise<string | null> {
    return this.resolveMembershipHeadCoachId(userId);
  }

  /**
   * Check whether `userId` can access `clientId`. Returns true if the
   * caller is a head coach who owns the client, OR a sub-coach with an
   * open assignment to that client.
   */
  async canAccessClient(userId: string, clientId: string): Promise<boolean> {
    const ids = await this.getAuthorizedClientIds(userId);
    return ids.includes(clientId);
  }
}
