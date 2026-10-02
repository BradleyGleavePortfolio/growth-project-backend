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

  async findById(
    itemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CommunityModerationAction | null> {
    return (tx ?? this.prisma).communityModerationAction.findUnique({
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
