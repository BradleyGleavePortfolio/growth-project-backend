import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityModerationAction,
  CommunityModerationStatus,
  CommunityModerationTargetType,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { clientOf, PUBLIC_SPACE, unbannedSpaces } from '../community-public-row';

/**
 * Data access for the moderation queue (CommunityModerationAction rows).
 *
 * A "report" is an action row created with status=open and an actor not yet set.
 * Acting on it (hide/warn/ban/dismiss) stamps actor_id, status, action, and
 * resolved_at. Tenant scoping is application-layer (service_role/BYPASSRLS):
 * every queue read is bounded by the workspace id the service authorised.
 */
@Injectable()
export class CommunityModerationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createReport(params: {
    workspaceId: string;
    targetType: CommunityModerationTargetType;
    targetId: string;
    reportedById: string;
    reason: string;
    notes: string | null;
  }): Promise<CommunityModerationAction> {
    return this.prisma.communityModerationAction.create({
      data: {
        workspace_id: params.workspaceId,
        target_type: params.targetType,
        target_id: params.targetId,
        reported_by_id: params.reportedById,
        status: 'open',
        reason: params.reason,
        notes: params.notes,
      },
    });
  }

  async findById(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CommunityModerationAction | null> {
    return (tx ?? this.prisma).communityModerationAction.findUnique({
      where: { id: itemId },
    });
  }

  /**
   * Rule D (owner, 10-26; decision #178-2; FR-1173 LS-INBOX2 B1): the reports someone who does not run the
   * community reads there, to read only: a report on a public space's message, post or voice note reaches the
   * space's team (an active coach or assistant membership) and the author's own coach (the author is their
   * current client), never while they are banned from the community or in a block with the author. The same
   * rule as community-public-row.ts and app.community_public_row_of_my_client. Each report once.
   */
  async listForRuleDReader(params: {
    viewerId: string;
    workspaceId: string | null;
    status: CommunityModerationStatus | null;
    limit: number;
    newestFirst: boolean;
  }): Promise<CommunityModerationAction[]> {
    const { viewerId: me } = params;
    const dir = params.newestFirst ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    return this.prisma.$queryRaw<CommunityModerationAction[]>`
      SELECT a.* FROM "community_moderation_actions" a
      LEFT JOIN "community_messages" m ON a."target_type" = 'message' AND m."id" = a."target_id" AND m."scope" = 'cohort'
      LEFT JOIN "community_posts" p ON a."target_type" = 'post' AND p."id" = a."target_id" AND p."scope" = 'cohort'
      LEFT JOIN "community_voice_notes" v
        ON a."target_type" = 'voice_note' AND v."id" = a."target_id" AND v."conversation_id" IS NULL
      JOIN "community_cohorts" c ON c."id" = COALESCE(m."cohort_id", p."cohort_id", v."cohort_id")
        AND c."workspace_id" = a."workspace_id" AND c."visibility" = 'public'
      JOIN "community_workspaces" w ON w."id" = a."workspace_id" AND w."coach_id" <> ${me}
      JOIN "User" u ON u."id" = COALESCE(m."sender_id", p."author_id", v."author_id")
      WHERE TRUE
        ${params.workspaceId ? Prisma.sql`AND a."workspace_id" = ${params.workspaceId}::uuid` : Prisma.empty}
        ${params.status ? Prisma.sql`AND a."status" = ${params.status}::"CommunityModerationStatus"` : Prisma.empty}
        AND NOT EXISTS (SELECT 1 FROM "community_workspace_bans" b
          WHERE b."workspace_id" = a."workspace_id" AND b."user_id" = ${me} AND b."lifted_at" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "UserBlock" ub
          WHERE (ub."blocker_id" = ${me} AND ub."blocked_id" = u."id") OR (ub."blocker_id" = u."id" AND ub."blocked_id" = ${me}))
        AND ((u."coach_id" = ${me} AND u."role" = 'student')
          OR EXISTS (SELECT 1 FROM "community_memberships" cm WHERE cm."cohort_id" = c."id" AND cm."user_id" = ${me}
            AND cm."status" = 'active' AND cm."role" IN ('coach', 'assistant')))
      ORDER BY a."created_at" ${dir}, a."id" ${dir}
      LIMIT ${params.limit}`;
  }

  /**
   * Rule D: may the viewer read this community's report queue as a reader (listForRuleDReader)? A public space
   * there, the viewer not banned from it, where they are on the team or a current client of theirs is a member.
   */
  async isRuleDReaderOf(workspaceId: string, viewerId: string): Promise<boolean> {
    const spaces = await this.prisma.communityCohort.findMany({
      where: {
        workspace_id: workspaceId,
        ...PUBLIC_SPACE,
        memberships: { some: { OR: [{ user_id: viewerId, status: 'active', role: { in: ['coach', 'assistant'] } },
          { user: clientOf(viewerId) }] } },
      },
      select: { id: true, workspace_id: true },
    });
    return (await unbannedSpaces(this.prisma, viewerId, spaces)).length > 0;
  }

  /**
   * Moderation queue for a workspace, newest-first, optionally filtered by
   * status.
   */
  async listForWorkspace(params: {
    workspaceId: string;
    status: CommunityModerationStatus | null;
    limit: number;
  }): Promise<CommunityModerationAction[]> {
    return this.prisma.communityModerationAction.findMany({
      where: {
        workspace_id: params.workspaceId,
        ...(params.status ? { status: params.status } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: params.limit,
    });
  }

  /**
   * B-610-4 round 5: compare-and-set resolution. Writes only when the item is
   * still in the state the caller decided on (status + action), so two
   * moderators acting at once can never silently overwrite each other.
   * Returns null when the item changed underneath (the caller re-evaluates).
   */
  async resolveIfUnchanged(
    params: {
      itemId: string;
      expectedStatus: CommunityModerationStatus;
      expectedAction: string | null;
      actorId: string;
      status: CommunityModerationStatus;
      action: string;
      notes: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<CommunityModerationAction | null> {
    const written = await tx.communityModerationAction.updateMany({
      where: {
        id: params.itemId,
        status: params.expectedStatus,
        action: params.expectedAction,
      },
      data: {
        actor_id: params.actorId,
        status: params.status,
        action: params.action,
        ...(params.notes !== null ? { notes: params.notes } : {}),
        resolved_at: new Date(),
      },
    });
    if (written.count !== 1) return null;
    return tx.communityModerationAction.findUnique({ where: { id: params.itemId } });
  }

  async resolve(
    params: {
      itemId: string;
      actorId: string;
      status: CommunityModerationStatus;
      action: string;
      notes: string | null;
    },
    // Optional transaction client: act() commits the resolution together with
    // the member's moderation notice (B-610-4).
    tx?: Prisma.TransactionClient,
  ): Promise<CommunityModerationAction> {
    const db = tx ?? this.prisma;
    return db.communityModerationAction.update({
      where: { id: params.itemId },
      data: {
        actor_id: params.actorId,
        status: params.status,
        action: params.action,
        ...(params.notes !== null ? { notes: params.notes } : {}),
        resolved_at: new Date(),
      },
    });
  }
}
