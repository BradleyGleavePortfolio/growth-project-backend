import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommunityModerationAction,
  CommunityModerationStatus,
  CommunityModerationTargetType,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';

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

  async findById(itemId: string): Promise<CommunityModerationAction | null> {
    return this.prisma.communityModerationAction.findUnique({
      where: { id: itemId },
    });
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
