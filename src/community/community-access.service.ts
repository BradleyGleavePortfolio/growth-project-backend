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

  /**
   * The person's membership row in a space (any status), or null when the one
   * rule (app.community_can_access, C6-BVIS) keeps them out of the space.
   */
  async membershipInCohort(cohortId: string, userId: string): Promise<CommunityMembership | null> {
    const m = await this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
    });
    return m && (await canEnterSpace(this.prisma, cohortId, userId)) ? m : null;
  }

  /**
   * The spaces of a workspace the person may read and write (the one rule).
   * The challenge, voice, search, classroom and event lists push these into
   * their repository query so a page and its cursor only ever hold rows the
   * person may read (never post-filtered after pagination).
   */
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

  /** The rows whose person the rule lets into the space (rosters). */
  async peopleInSpace<T>(cohortId: string, rows: T[], personOf: (row: T) => string): Promise<T[]> {
    return rowsWithSpaceAccess(this.prisma, rows, (r) => [cohortId, personOf(r)] as const);
  }

  /**
   * The person's first active row in a space of the workspace that is not
   * public and that the rule lets them into, or null. Workspace-wide surfaces
   * (the Hall, DMs, workspace voice and events) are the coach's circle; a
   * public space opens only itself.
   */
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

  /**
   * True when the user may read and write in a space: app.community_can_access
   * (the workspace coach always; otherwise the space's visibility decides), or
   * the platform owner's support override. Gates every cohort read and write.
   */
  async canAccessCohort(
    cohort: Pick<CommunityCohort, 'id' | 'workspace_id'>,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    return canEnterSpace(this.prisma, cohort.id, user.id);
  }

  /**
   * True when the user may read workspace-wide content (the Hall, workspace
   * lists): the owning coach, the platform owner, or a person the rule lets
   * into a space of the workspace that is not public.
   */
  async canAccessWorkspace(
    workspaceId: string,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    if (await this.isWorkspaceCoach(workspaceId, user.id)) return true;
    return (await this.openSpaces(workspaceId, user.id)).some((c) => c.visibility !== 'public');
  }
}
