import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CommunityMembership,
  CommunityMessage,
  CommunityWorkspace,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
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
import { CommunitySafetyService, DM_UNAVAILABLE } from '../safety/community-safety.service';
import { memberName } from '../member-display-name';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

// A member who is not there (left, banned, never joined). A block is told
// apart since #169-5 (403 blocked_by_you / blocked_by_them).
const DM_NOT_FOUND = DM_UNAVAILABLE;

const DM_DISABLED = {
  error: 'forbidden',
  code: 'community.dm.disabled',
} as const;

/** C10RT: the DM rule, for reading a DM (authoriseDm) and for who hears a DM row's reaction pings.
 * Both people still hold a membership the rule opens (owner and coach included), so a removal, a ban
 * or a coach move ends the DM for both at once, and neither blocked the other (Apple 1.2). Throws the
 * refusal `a` gets; returns a's and b's memberships. */
export async function assertDmOpen(access: CommunityAccessService, safety: CommunitySafetyService,
  workspaceId: string, a: string, b: string): Promise<CommunityMembership[]> {
  const [ma, mb] = await Promise.all([a, b].map((p) => access.membershipInWorkspace(workspaceId, p)));
  if (!ma || !mb) throw new NotFoundException(DM_NOT_FOUND);
  await safety.assertDmAllowed(a, b);
  return [ma, mb];
}

/**
 * 1:1 direct messages within a workspace.
 *
 * DM eligibility follows the established v1-2 tri-state contract. The
 * resolveDmEnabled below is a local mirror of the community.service.ts resolver,
 * kept byte-for-byte in sync; a future refactor will share a single
 * implementation. A membership's dm_enabled is nullable — null inherits the
 * workspace's dm_enabled_default, an explicit boolean overrides. The secure
 * default is OFF (dm_enabled_default defaults false), so DMs are workspace-gated
 * and opt-in.
 *
 * DEVIATION (surfaced as a blocker in the report): the brief specifies a
 * tri-state dm_policy (coach_only | members | disabled) on the workspace. No
 * such column exists in the v1-1 schema (only dm_enabled_default:boolean and the
 * per-membership dm_enabled:boolean?). Adding it would violate R69. This module
 * therefore enforces the boolean gate that DOES exist: both participants must be
 * active members of the same workspace AND have DMs effectively enabled. The
 * coach_only/members distinction is the single thing that cannot be honoured
 * until the column lands; authoriseDm() is the one place to relax this.
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
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
    private readonly safety: CommunitySafetyService,
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
   * Single source of truth for the per-participant DM gate: a member whose
   * effective DM state (tri-state membership.dm_enabled → workspace
   * dm_enabled_default) resolves false may neither send NOR read DM data. Throws
   * 403 DM_DISABLED. Both authoriseDm (write/thread reads) and listThreads (the
   * thread-metadata read) route through here so no DM surface can return data to
   * a default-OFF caller.
   */
  private gateDmRead(
    membership: Pick<CommunityMembership, 'dm_enabled'> | null,
    workspace: Pick<CommunityWorkspace, 'dm_enabled_default'> | null,
  ): void {
    if (!this.resolveDmEnabled(membership, workspace)) {
      throw new ForbiddenException(DM_DISABLED);
    }
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

    const pair = await assertDmOpen(this.access, this.safety, workspaceId, sender.id, recipientId);
    for (const membership of pair) this.gateDmRead(membership, workspace);

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
    this.safety.assertAllowed(body);
    const created = await this.dms.createDm({
      workspaceId,
      dmKey,
      senderId: user.id,
      recipientId,
      body,
    });
    // v1-4 post-write tail (after gateDmRead, inside authoriseDm). Best-effort
    // realtime refetch ping to the RECIPIENT's private topic only — IDs only,
    // never the DM body (#24/#36). DMs have no dedicated broadcast event in the
    // v1-4 channel/event contract, so we reuse the message-created refetch
    // signal: the recipient pings → refetches the thread via authenticated REST.
    void this.realtime.broadcastCommunityEvent(
      { people: [recipientId] },
      COMMUNITY_BROADCAST_EVENTS.messageCreated,
      {
        id: created.id,
        cohortId: created.dm_key ?? dmKey,
        authorId: created.sender_id,
        createdAt: created.created_at.toISOString(),
      },
      { distinctId: recipientId, channelKind: 'user' },
    );
    // Push the recipient that they have a new DM. Gated behind
    // FEATURE_COMMUNITY_PUSH inside the service; idempotent per (kind,
    // recipient, thread, message).
    void this.communityPush.sendCommunityPush({
      recipientId,
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      targetType: 'dm',
      targetId: created.id,
      deepLink: `tgp://community/dms/${dmKey}`,
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
    const membership = await this.access.membershipInWorkspace(workspaceId, user.id);
    if (!workspace || !membership) {
      throw new NotFoundException(DM_NOT_FOUND);
    }
    // Reading thread metadata is a DM surface too: gate on the caller's
    // effective DM state before returning any rows.
    this.gateDmRead(membership, workspace);
    const rows = await this.dms.listThreadsForUser({
      workspaceId,
      userId: user.id,
      limit: this.parsePage(query.limit),
    });
    const otherOf = (m: CommunityMessage) => (m.sender_id === user.id ? (m.recipient_user_id ?? '') : m.sender_id);
    // #168-4: a partner who left or is banned drops the row. #169-5 CLOSED-LINE: a block either way keeps
    // it for both people as a closed row (no time), so each phone can say who closed it.
    const kept = await this.safety.dmRowsWithBlock(user.id, rows, otherOf, (m) => [m.workspace_id, null]);
    const ids = kept.map(({ row }) => otherOf(row));
    const [names, full] = await Promise.all([
      this.dms.namesOf(ids),
      this.access.fullNamesFor(user.id, workspaceId, ids.map((id) => [null, id] as const)),
    ]);
    // The community's own name rule: the coach sees full names; members see a first name, or the full
    // name where a space open to all of the coach's clients shows it (#C6-NAMES-EVERYWHERE).
    const nameOf = (id: string) => memberName(names.get(id), workspace.coach_id === user.id || full(null, id));
    return CommunityDmThreadListResponseSchema.parse({
      threads: kept.map(({ row: m, closed, blockedByMe }) => ({
        thread_id: m.dm_key ?? '',
        workspace_id: m.workspace_id,
        other_user_id: otherOf(m),
        created_at: null,
        last_message_at: closed ? null : m.created_at.toISOString(),
        closed,
        blocked_by_me: blockedByMe,
        other_display_name: nameOf(otherOf(m)),
      })),
    });
  }
}
