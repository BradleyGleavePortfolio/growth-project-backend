import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CommunityMembership,
  CommunityMessage,
  CommunityWorkspace,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityDmsRepository } from './community-dms.repository';
import {
  CommunityDmMessageListResponse,
  CommunityDmMessageListResponseSchema,
  CommunityDmMessageResponse,
  CommunityDmMessageResponseSchema,
  CommunityDmMessageView,
  CommunityDmThreadListResponse,
  CommunityDmThreadListResponseSchema,
  CommunityDmThreadResponse,
  CommunityDmThreadResponseSchema,
} from '../dto/community-dm.dto';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

const DM_NOT_FOUND = {
  error: 'not_found',
  code: 'community.dm.not_found',
} as const;

const DM_DISABLED = {
  error: 'forbidden',
  code: 'community.dm.disabled',
} as const;

/**
 * 1:1 direct messages within a workspace.
 *
 * DM eligibility follows the established v1-2 tri-state contract
 * (community.service.ts resolveDmEnabled): a membership's dm_enabled is nullable
 * — null inherits the workspace's dm_enabled_default, an explicit boolean
 * overrides. The secure default is OFF (dm_enabled_default defaults false), so
 * DMs are workspace-gated and opt-in.
 *
 * DEVIATION (surfaced as a blocker in the report): the brief specifies a
 * tri-state dm_policy (coach_only | members | disabled) on the workspace. No
 * such column exists in the v1-1 schema (only dm_enabled_default:boolean and the
 * per-membership dm_enabled:boolean?). Adding it would violate R69. This module
 * therefore enforces the boolean gate that DOES exist: both participants must be
 * active members of the same workspace AND have DMs effectively enabled. The
 * coach_only/members distinction is the single thing that cannot be honoured
 * until the column lands; canDm() is the one place to relax this.
 *
 * Both participants must be active workspace members or the caller gets 404
 * (cross-tenant non-leak posture). A disabled recipient yields 403 with an
 * explicit code so the client can render "this member has DMs off".
 */
@Injectable()
export class CommunityDmsService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly dms: CommunityDmsRepository,
  ) {}

  private resolveDmEnabled(
    membership: Pick<CommunityMembership, 'dm_enabled'> | null,
    workspace: Pick<CommunityWorkspace, 'dm_enabled_default'> | null,
  ): boolean {
    if (membership && membership.dm_enabled !== null) {
      return membership.dm_enabled;
    }
    return workspace?.dm_enabled_default ?? false;
  }

  private messageView(m: CommunityMessage): CommunityDmMessageView {
    return {
      id: m.id,
      thread_id: m.dm_key ?? '',
      sender_user_id: m.sender_id,
      recipient_user_id: m.recipient_user_id ?? '',
      body: m.deleted_at ? null : m.body,
      created_at: m.created_at.toISOString(),
      deleted: m.deleted_at !== null,
    };
  }

  private parsePage(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private parseBefore(before: string | undefined): Date | null {
    if (!before) return null;
    const d = new Date(before);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * Authorise a DM between the caller and a recipient in a workspace. Throws 404
   * if either side is not an active member (non-leak), 403 if either side has
   * DMs disabled. Returns the deterministic thread key.
   */
  private async authoriseDm(
    workspaceId: string,
    sender: User,
    recipientId: string,
  ): Promise<string> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(DM_NOT_FOUND);
    if (sender.id === recipientId) throw new NotFoundException(DM_NOT_FOUND);

    const senderMembership = await this.access.membershipInWorkspace(
      workspaceId,
      sender.id,
    );
    const recipientMembership = await this.access.membershipInWorkspace(
      workspaceId,
      recipientId,
    );
    // Owner/coach may not bypass membership for DMs: a DM is between two
    // workspace participants. Both must hold an active membership row.
    if (!senderMembership || !recipientMembership) {
      throw new NotFoundException(DM_NOT_FOUND);
    }

    if (!this.resolveDmEnabled(senderMembership, workspace)) {
      throw new ForbiddenException(DM_DISABLED);
    }
    if (!this.resolveDmEnabled(recipientMembership, workspace)) {
      throw new ForbiddenException(DM_DISABLED);
    }

    return CommunityDmsRepository.dmKey(workspaceId, sender.id, recipientId);
  }

  async openThread(
    user: User,
    workspaceId: string,
    recipientId: string,
  ): Promise<CommunityDmThreadResponse> {
    const dmKey = await this.authoriseDm(workspaceId, user, recipientId);
    return CommunityDmThreadResponseSchema.parse({
      thread: {
        thread_id: dmKey,
        workspace_id: workspaceId,
        other_user_id: recipientId,
        created_at: null,
        last_message_at: null,
      },
    });
  }

  async send(
    user: User,
    workspaceId: string,
    recipientId: string,
    body: string,
  ): Promise<CommunityDmMessageResponse> {
    const dmKey = await this.authoriseDm(workspaceId, user, recipientId);
    const created = await this.dms.createDm({
      workspaceId,
      dmKey,
      senderId: user.id,
      recipientId,
      body,
    });
    return CommunityDmMessageResponseSchema.parse({
      message: this.messageView(created),
    });
  }

  async listThread(
    user: User,
    workspaceId: string,
    recipientId: string,
    query: { before?: string; limit?: string },
  ): Promise<CommunityDmMessageListResponse> {
    const dmKey = await this.authoriseDm(workspaceId, user, recipientId);
    const rows = await this.dms.listThread({
      dmKey,
      before: this.parseBefore(query.before),
      limit: this.parsePage(query.limit),
    });
    return CommunityDmMessageListResponseSchema.parse({
      messages: rows.map((m) => this.messageView(m)),
    });
  }

  async listThreads(
    user: User,
    workspaceId: string,
    query: { limit?: string },
  ): Promise<CommunityDmThreadListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (
      !workspace ||
      !(await this.access.membershipInWorkspace(workspaceId, user.id))
    ) {
      throw new NotFoundException(DM_NOT_FOUND);
    }
    const rows = await this.dms.listThreadsForUser({
      workspaceId,
      userId: user.id,
      limit: this.parsePage(query.limit),
    });
    return CommunityDmThreadListResponseSchema.parse({
      threads: rows.map((m) => ({
        thread_id: m.dm_key ?? '',
        workspace_id: m.workspace_id,
        other_user_id:
          m.sender_id === user.id ? m.recipient_user_id ?? '' : m.sender_id,
        created_at: null,
        last_message_at: m.created_at.toISOString(),
      })),
    });
  }
}
