import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { canEnterSpace, rowsWithSpaceAccess } from './community-space-access';

/** Names for a coach's auto-created space (B-E2E-1); they match the clinic seed. */
export const DEFAULT_WORKSPACE_NAME = 'Community';
export const DEFAULT_COHORT_NAME = 'All members';

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

  /** The caller's oldest active row in a non-public space the rule opens (C6-BVIS), or null. */
  async findActiveMembershipForUser(userId: string) {
    const rows = await this.prisma.communityMembership.findMany({
      where: { user_id: userId, status: 'active', cohort: { visibility: { not: 'public' } } },
      orderBy: { joined_at: 'asc' },
    });
    return (await rowsWithSpaceAccess(this.prisma, rows, (m) => [m.cohort_id, userId] as const))[0] ?? null;
  }

  /** The workspace a coach owns, or null. */
  async findWorkspaceOwnedByCoach(coachId: string) {
    return this.prisma.communityWorkspace.findFirst({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * B-E2E-1: the coach's community space, created on first open when the coach
   * has none, in the same shape as scripts/seed-clinic-programs.ts (a workspace
   * plus its first cohort, "All members", sort_order 0). Both writes are upserts
   * on unique keys (workspace slug, cohort workspace_id + name), so two first
   * opens at once land on the same rows. An archived space stays archived.
   */
  async ensureWorkspaceForCoach(coachId: string) {
    const existing = await this.findWorkspaceOwnedByCoach(coachId);
    if (existing) return existing;
    const slug = `coach-${coachId}`;
    const workspace = await this.prisma.communityWorkspace.upsert({
      where: { slug },
      create: { coach_id: coachId, name: DEFAULT_WORKSPACE_NAME, slug },
      update: {},
    });
    if (workspace.coach_id !== coachId || workspace.archived_at) return null;
    await this.prisma.communityCohort.upsert({
      where: {
        workspace_id_name: { workspace_id: workspace.id, name: DEFAULT_COHORT_NAME },
      },
      create: { workspace_id: workspace.id, name: DEFAULT_COHORT_NAME, sort_order: 0 },
      update: {},
    });
    return workspace;
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
    const rows = await this.prisma.communityMembership.findMany({
      where: { cohort_id: cohortId, status: 'active' },
      select: { user_id: true },
    });
    return (await rowsWithSpaceAccess(this.prisma, rows, (m) => [cohortId, m.user_id] as const)).length;
  }

  async findWorkspaceById(workspaceId: string) {
    return this.prisma.communityWorkspace.findUnique({
      where: { id: workspaceId },
    });
  }

  /** True when the rule lets the caller into a space of the workspace that is not public. */
  async userHasMembershipInWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const spaces = await this.prisma.communityCohort.findMany({
      where: { workspace_id: workspaceId, visibility: { not: 'public' } },
      select: { id: true },
    });
    return (await rowsWithSpaceAccess(this.prisma, spaces, (c) => [c.id, userId] as const)).length > 0;
  }

  /**
   * Cohorts the caller can see:
   *  - students: the spaces of their rows and their coach's community the rule opens;
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
    const me = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { coach_id: true },
    });
    const candidates = await this.prisma.communityCohort.findMany({
      where: {
        archived_at: null,
        OR: [
          { memberships: { some: { user_id: params.userId, status: 'active' } } },
          ...(me?.coach_id ? [{ workspace: { coach_id: me.coach_id } }] : []),
        ],
      },
      orderBy: [{ workspace_id: 'asc' }, { sort_order: 'asc' }],
    });
    return rowsWithSpaceAccess(this.prisma, candidates, (c) => [c.id, params.userId] as const);
  }

  async findCohortById(cohortId: string) {
    return this.prisma.communityCohort.findUnique({
      where: { id: cohortId },
    });
  }

  /** True when the rule lets the caller into the cohort. */
  async canEnterCohort(cohortId: string, userId: string): Promise<boolean> {
    return canEnterSpace(this.prisma, cohortId, userId);
  }

  /** The caller's membership in a specific cohort (any status), or null. */
  async findMembershipInCohort(cohortId: string, userId: string) {
    return this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
    });
  }

  /**
   * Bounded "Today" content for a workspace, fetched concurrently (no N+1):
   * nearest upcoming event, most-recently-pinned post, active challenge with
   * the nearest ends_at; workspace-wide or in a space the rule opens to the caller.
   */
  async findTodayContent(workspaceId: string, userId: string, now: Date) {
    const spaces = await this.prisma.communityCohort.findMany({ where: { workspace_id: workspaceId }, select: { id: true } });
    const open = await rowsWithSpaceAccess(this.prisma, spaces, (c) => [c.id, userId] as const);
    const inSpace = { OR: [{ cohort_id: null }, { cohort_id: { in: open.map((c) => c.id) } }] };
    const [event, pinnedPost, challenge] = await Promise.all([
      this.prisma.communityEvent.findFirst({
        where: {
          ...inSpace,
          workspace_id: workspaceId,
          state: 'scheduled',
          starts_at: { gte: now },
          canceled_at: null,
        },
        orderBy: { starts_at: 'asc' },
      }),
      this.prisma.communityPost.findFirst({
        where: {
          ...inSpace,
          workspace_id: workspaceId,
          pinned_at: { not: null },
          visibility: 'active',
          deleted_at: null,
        },
        orderBy: { pinned_at: 'desc' },
      }),
      this.prisma.communityChallenge.findFirst({
        where: {
          ...inSpace,
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
        // Cross-surface containment: only plain cohort chat messages
        // (plan_context_type === null) count toward unread. Sub-surface rows
        // — post comments and v3-1 challenge comments / opt-in sentinels — carry
        // a non-null discriminator and must never inflate the unread badge.
        plan_context_type: null,
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
    const open = await rowsWithSpaceAccess(this.prisma, rows, (r) => [r.cohort_id, userId] as const);
    return open.map((r) => r.cohort_id);
  }
}
