import { Injectable } from '@nestjs/common';
import type {
  CommunityCohort,
  CommunityMembership,
  CommunityPost,
  CommunityWorkspace,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';

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

  async findWorkspace(workspaceId: string): Promise<CommunityWorkspace | null> {
    return this.prisma.communityWorkspace.findUnique({
      where: { id: workspaceId },
    });
  }

  async findPost(postId: string): Promise<CommunityPost | null> {
    return this.prisma.communityPost.findUnique({ where: { id: postId } });
  }

  /** The caller's membership row in a cohort (any status), or null. */
  async membershipInCohort(
    cohortId: string,
    userId: string,
  ): Promise<CommunityMembership | null> {
    return this.prisma.communityMembership.findUnique({
      where: { cohort_id_user_id: { cohort_id: cohortId, user_id: userId } },
    });
  }

  /** The caller's first active membership row in a workspace, or null. */
  async membershipInWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<CommunityMembership | null> {
    return this.prisma.communityMembership.findFirst({
      where: { workspace_id: workspaceId, user_id: userId, status: 'active' },
    });
  }

  /** True when the user owns (coaches) the workspace. */
  async isWorkspaceCoach(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const ws = await this.prisma.communityWorkspace.findFirst({
      where: { id: workspaceId, coach_id: userId },
      select: { id: true },
    });
    return ws !== null;
  }

  /**
   * True when the user may READ within a cohort: an active member, the owning
   * coach, or the platform owner. Used to gate cohort message reads/writes.
   */
  async canAccessCohort(
    cohort: Pick<CommunityCohort, 'id' | 'workspace_id'>,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    if (await this.isWorkspaceCoach(cohort.workspace_id, user.id)) return true;
    const m = await this.membershipInCohort(cohort.id, user.id);
    return m?.status === 'active';
  }

  /**
   * True when the user may READ within a workspace: an active member, the owning
   * coach, or the platform owner.
   */
  async canAccessWorkspace(
    workspaceId: string,
    user: { id: string; role: string },
  ): Promise<boolean> {
    if (user.role === 'owner') return true;
    if (await this.isWorkspaceCoach(workspaceId, user.id)) return true;
    const m = await this.membershipInWorkspace(workspaceId, user.id);
    return m !== null;
  }
}
