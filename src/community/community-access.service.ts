import { Injectable } from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityMembership,
  CommunityPost,
  CommunityWorkspace,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { isBannedFromWorkspace } from './community-ban';
import { canEnterSpace, rowsWithSpaceAccess } from './community-space-access';

/**
 * Shared authorization queries for the v1-3 write surfaces.
 *
 * Centralises the membership / ownership checks so messages, posts, DMs,
 * reactions, and moderation all enforce tenancy the SAME way the v1-2
 * foundation does: explicit application-layer filters (the app connects as
 * service_role / BYPASSRLS, so Postgres RLS does not constrain these queries —
 * see community.repository.ts). A non-member read resolves to null/false and
 * the caller maps that to 404 so existence is never leaked across tenants.
 */
@Injectable()
export class CommunityAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async findCohort(cohortId: string): Promise<CommunityCohort | null> {
    return this.prisma.communityCohort.findUnique({ where: { id: cohortId } });
  }

  /**
   * Batch-resolve cohort ids to their (id, name) in a SINGLE query. Used by the
   * v2-4 AI triage path to avoid an N+1 of per-cohort findCohort() calls when a
   * cache miss can carry up to ~100 unique cohort ids. De-duplication of the
   * input is the caller's concern; passing an empty list short-circuits to no
   * query at all.
   */
  async findCohortsByIds(ids: string[]): Promise<Array<Pick<CommunityCohort, 'id' | 'name'>>> {
    if (ids.length === 0) return [];
    return this.prisma.communityCohort.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }

  async findWorkspace(workspaceId: string): Promise<CommunityWorkspace | null> {
    return this.prisma.communityWorkspace.findUnique({
      where: { id: workspaceId },
    });
  }

  async findPost(postId: string): Promise<CommunityPost | null> {
    return this.prisma.communityPost.findUnique({ where: { id: postId } });
  }

  /** The person's membership row in a space (any status), or null when the rule keeps them out. */
  async membershipInCohort(cohortId: string, userId: string): Promise<CommunityMembership | null> {
    const m = await this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
    });
    return m && (await canEnterSpace(this.prisma, cohortId, userId)) ? m : null;
  }

  /** The spaces of a workspace the rule opens; lists put these in their query (never post-filter a page). */
  async listAccessibleCohortIds(workspaceId: string, userId: string): Promise<string[]> {
    return (await this.openSpaces(workspaceId, userId)).map((c) => c.id);
  }

  private async openSpaces(workspaceId: string, userId: string) {
    const spaces = await this.prisma.communityCohort.findMany({
      where: { workspace_id: workspaceId },
      select: { id: true, visibility: true },
    });
    return rowsWithSpaceAccess(this.prisma, spaces, (c) => [c.id, userId] as const);
  }

  /** Membership rows listed in the space (rosters, Remove): the rule, a pending invitation counted. */
  async peopleInSpace<T>(cohortId: string, rows: T[], personOf: (row: T) => string): Promise<T[]> {
    return rowsWithSpaceAccess(this.prisma, rows, (r) => [cohortId, personOf(r)] as const, true);
  }

  /** Push recipients: the people who may read a row of the workspace (of its space, if any) now. */
  async readersOf(workspaceId: string, cohortId: string | null, people: string[]): Promise<string[]> {
    if (cohortId) return rowsWithSpaceAccess(this.prisma, people, (id) => [cohortId, id] as const);
    const ok = await Promise.all(people.map((id) => this.canAccessWorkspace(workspaceId, { id, role: 'student' })));
    return people.filter((_, i) => ok[i]);
  }

  /** The person's first active row in a non-public space the rule opens (the Hall, DMs), or null. */
  async membershipInWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<CommunityMembership | null> {
    const rows = await this.prisma.communityMembership.findMany({
      where: {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'active',
        cohort: { visibility: { not: 'public' } },
      },
    });
    const open = await rowsWithSpaceAccess(this.prisma, rows, (m) => [m.cohort_id, userId] as const);
    return open[0] ?? null;
  }

  /**
   * B-610-2: an active durable ban (community_workspace_bans) denies every
   * member read/write in the workspace, whatever membership rows say.
   */
  async isBanned(workspaceId: string, userId: string): Promise<boolean> {
    return isBannedFromWorkspace(this.prisma, workspaceId, userId);
  }

  /** True when the user owns (coaches) the workspace. */
  async isWorkspaceCoach(workspaceId: string, userId: string): Promise<boolean> {
    const ws = await this.prisma.communityWorkspace.findFirst({
      where: { id: workspaceId, coach_id: userId },
      select: { id: true },
    });
    return ws !== null;
  }

  /** True when the user may read and write in a space: the rule, or the platform owner's override. */
  async canAccessCohort(
    cohort: Pick<CommunityCohort, 'id' | 'workspace_id'>,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    return canEnterSpace(this.prisma, cohort.id, user.id);
  }

  /** True when the user may read workspace-wide content: the coach, the owner, or a non-public space opens. */
  async canAccessWorkspace(
    workspaceId: string,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    if (await this.isWorkspaceCoach(workspaceId, user.id)) return true;
    return (await this.openSpaces(workspaceId, user.id)).some((c) => c.visibility !== 'public');
  }
}
