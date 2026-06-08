import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Data-access layer for the Community v1-2 foundation endpoints.
 *
 * Tenant scoping is enforced HERE, in application-layer query filters, not by
 * Postgres RLS. The app's Prisma connection uses the Supabase service_role
 * (BYPASSRLS), so RLS policies — which protect direct/Supabase-client access —
 * do not constrain these queries. Every method therefore filters by the
 * caller's membership or workspace ownership explicitly. The controller maps an
 * empty/null result to 403 so existence is never leaked to a non-member.
 *
 * "Default cohort" is derived, not stored: the schema has no is_default column
 * (see ADR-aligned schema), so the default is the active cohort with the lowest
 * sort_order (tie-broken by earliest created_at) in a workspace.
 */
@Injectable()
export class CommunityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's active membership row (any cohort), or null. */
  async findActiveMembershipForUser(userId: string) {
    return this.prisma.communityMembership.findFirst({
      where: { user_id: userId, status: 'active' },
      orderBy: { joined_at: 'asc' },
    });
  }

  /** The workspace a coach owns, or null. */
  async findWorkspaceOwnedByCoach(coachId: string) {
    return this.prisma.communityWorkspace.findFirst({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * The derived default cohort for a coach's workspace: the active cohort with
   * the lowest sort_order, tie-broken by earliest created_at. Returns null when
   * the coach has no workspace or no active cohort.
   */
  async findDefaultCohortForCoach(coachId: string) {
    const workspace = await this.findWorkspaceOwnedByCoach(coachId);
    if (!workspace) return null;
    return this.prisma.communityCohort.findFirst({
      where: { workspace_id: workspace.id, status: 'active', archived_at: null },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
  }

  /**
   * Idempotently create the student's membership in their coach's default
   * cohort. Keyed on the (cohort_id, user_id) unique constraint so concurrent
   * first-touch calls collapse to a single row.
   */
  async bootstrapStudentMembership(params: {
    workspaceId: string;
    cohortId: string;
    userId: string;
  }) {
    return this.prisma.communityMembership.upsert({
      where: {
        cohort_id_user_id: {
          cohort_id: params.cohortId,
          user_id: params.userId,
        },
      },
      create: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        user_id: params.userId,
        role: 'student',
        status: 'active',
        joined_at: new Date(),
      },
      update: {},
    });
  }

  /** Is the cohort the derived default for its workspace? */
  async isDefaultCohort(cohort: {
    id: string;
    workspace_id: string;
  }): Promise<boolean> {
    const def = await this.prisma.communityCohort.findFirst({
      where: {
        workspace_id: cohort.workspace_id,
        status: 'active',
        archived_at: null,
      },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      select: { id: true },
    });
    return def?.id === cohort.id;
  }

  /** Active-member count for a cohort. */
  async cohortMemberCount(cohortId: string): Promise<number> {
    return this.prisma.communityMembership.count({
      where: { cohort_id: cohortId, status: 'active' },
    });
  }

  async findWorkspaceById(workspaceId: string) {
    return this.prisma.communityWorkspace.findUnique({
      where: { id: workspaceId },
    });
  }

  /** True when the caller holds an active membership in the workspace. */
  async userHasMembershipInWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const m = await this.prisma.communityMembership.findFirst({
      where: { workspace_id: workspaceId, user_id: userId, status: 'active' },
      select: { id: true },
    });
    return m !== null;
  }

  /**
   * Cohorts the caller can see:
   *  - students: cohorts with an active membership of theirs;
   *  - coaches:  all cohorts in workspaces they own;
   *  - owners:   every cohort.
   * Scope is always server-derived from the caller's role/identity.
   */
  async findCohortsForUser(params: {
    userId: string;
    role: 'student' | 'coach' | 'owner';
  }) {
    if (params.role === 'owner') {
      return this.prisma.communityCohort.findMany({
        where: { archived_at: null },
        orderBy: [{ workspace_id: 'asc' }, { sort_order: 'asc' }],
      });
    }
    if (params.role === 'coach') {
      return this.prisma.communityCohort.findMany({
        where: {
          archived_at: null,
          workspace: { coach_id: params.userId, archived_at: null },
        },
        orderBy: [{ workspace_id: 'asc' }, { sort_order: 'asc' }],
      });
    }
    return this.prisma.communityCohort.findMany({
      where: {
        archived_at: null,
        memberships: {
          some: { user_id: params.userId, status: 'active' },
        },
      },
      orderBy: [{ workspace_id: 'asc' }, { sort_order: 'asc' }],
    });
  }

  async findCohortById(cohortId: string) {
    return this.prisma.communityCohort.findUnique({
      where: { id: cohortId },
    });
  }

  /** The caller's active membership in a specific cohort, or null. */
  async findMembershipInCohort(cohortId: string, userId: string) {
    return this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
    });
  }

  /**
   * Bounded "Today" content for a workspace, fetched concurrently (no N+1):
   * nearest upcoming event, most-recently-pinned post, active challenge with
   * the nearest ends_at.
   */
  async findTodayContent(workspaceId: string, now: Date) {
    const [event, pinnedPost, challenge] = await Promise.all([
      this.prisma.communityEvent.findFirst({
        where: {
          workspace_id: workspaceId,
          state: 'scheduled',
          starts_at: { gte: now },
          canceled_at: null,
        },
        orderBy: { starts_at: 'asc' },
      }),
      this.prisma.communityPost.findFirst({
        where: {
          workspace_id: workspaceId,
          pinned_at: { not: null },
          visibility: 'active',
          deleted_at: null,
        },
        orderBy: { pinned_at: 'desc' },
      }),
      this.prisma.communityChallenge.findFirst({
        where: {
          workspace_id: workspaceId,
          status: 'active',
          archived_at: null,
          ends_at: { not: null },
        },
        orderBy: { ends_at: 'asc' },
      }),
    ]);
    return { event, pinnedPost, challenge };
  }

  /**
   * Count cohort messages newer than the caller's last-read marker, excluding
   * messages the caller sent. Bounded to the caller's active cohorts.
   */
  async countUnreadCohortMessages(params: {
    userId: string;
    cohortIds: string[];
    since: Date | null;
  }): Promise<number> {
    if (params.cohortIds.length === 0) return 0;
    return this.prisma.communityMessage.count({
      where: {
        scope: 'cohort',
        cohort_id: { in: params.cohortIds },
        sender_id: { not: params.userId },
        deleted_at: null,
        ...(params.since ? { created_at: { gt: params.since } } : {}),
      },
    });
  }

  /** Active cohort ids the caller belongs to. */
  async findActiveCohortIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.communityMembership.findMany({
      where: { user_id: userId, status: 'active' },
      select: { cohort_id: true },
    });
    return rows.map((r) => r.cohort_id);
  }
}
