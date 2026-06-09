import { Injectable } from '@nestjs/common';
import type { CommunityResponse, CommunityResponseTargetType } from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for emoji reactions (CommunityResponse rows).
 *
 * Idempotency is enforced by the schema's unique index
 * (target_type, target_id, user_id, response_kind): re-reacting with the same
 * emoji is an upsert no-op, removing a non-existent reaction is a deleteMany
 * that affects zero rows. Both are success, never 409/404.
 */
@Injectable()
export class CommunityReactionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotently attach a reaction. Returns the (existing or new) row. */
  async addReaction(params: {
    workspaceId: string;
    targetType: CommunityResponseTargetType;
    targetId: string;
    targetCreatedAt: Date | null;
    userId: string;
    emoji: string;
  }): Promise<CommunityResponse> {
    return this.prisma.communityResponse.upsert({
      where: {
        target_type_target_id_user_id_response_kind: {
          target_type: params.targetType,
          target_id: params.targetId,
          user_id: params.userId,
          response_kind: params.emoji,
        },
      },
      create: {
        workspace_id: params.workspaceId,
        target_type: params.targetType,
        target_id: params.targetId,
        target_created_at: params.targetCreatedAt,
        user_id: params.userId,
        response_kind: params.emoji,
      },
      update: {},
    });
  }

  /** Idempotently remove a reaction. Zero affected rows is still success. */
  async removeReaction(params: {
    targetType: CommunityResponseTargetType;
    targetId: string;
    userId: string;
    emoji: string;
  }): Promise<number> {
    const res = await this.prisma.communityResponse.deleteMany({
      where: {
        target_type: params.targetType,
        target_id: params.targetId,
        user_id: params.userId,
        response_kind: params.emoji,
      },
    });
    return res.count;
  }

  /** All reactions on a target (for the aggregated summary). */
  async listForTarget(
    targetType: CommunityResponseTargetType,
    targetId: string,
  ): Promise<CommunityResponse[]> {
    return this.prisma.communityResponse.findMany({
      where: { target_type: targetType, target_id: targetId },
      orderBy: { created_at: 'asc' },
    });
  }
}
