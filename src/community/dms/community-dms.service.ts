import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
import { IDEMPOTENCY_KEY_REUSED, keyedSendId } from '../messages/message-idempotency';
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
import { CommunitySafetyService, DM_UNAVAILABLE, crisisField } from '../safety/community-safety.service';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

// A member who is not there (left, banned, never joined). A block is told
// apart since #169-5 CLOSED-LINE (403 blocked_by_you / blocked_by_them).
const DM_NOT_FOUND = DM_UNAVAILABLE;

const DM_DISABLED = {
  error: 'forbidden',
  code: 'community.dm.disabled',
} as const;

/** C10RT: the DM rule, for reading a DM (authoriseDm) and for who hears a DM row's reaction pings.
 * Open when both people still hold a membership the rule opens (membershipInWorkspace), or, COACH-DM-BE,
 * when one of them is the workspace's coach (who holds no membership row) and the other is that coach's
 * current client (isCoachWithClient: clientOf) who still holds one. COMMUNITY-DM-RULES-BE (owner #203-E49,
 * 203-D12): or when one is the workspace's coach and the other that coach's former client who is still in
 * the community and already holds a thread with them (formerClientsIn: app.community_dm_former_client, the
 * row policies' own test), so a coach move alone no longer ends their thread; a removal, a ban or leaving
 * the community still does. Neither may have blocked the other (Apple 1.2). Nobody else is let in: a
 * co-coach or assistant row, another coach, the platform owner role and a sub-coach need their own
 * membership as before. Throws the refusal `a` gets; returns a's and b's memberships (null in the coach's
 * slot, which gateDmRead resolves to the workspace's default; a former client's dmSettingRow). */
export async function assertDmOpen(access: CommunityAccessService, safety: CommunitySafetyService,
  workspaceId: string, a: string, b: string): Promise<Array<CommunityMembership | null>> {
  const [ma, mb] = await Promise.all([a, b].map((p) => access.membershipInWorkspace(workspaceId, p)));
  const open = ma && mb ? true
    : ma ? await access.isCoachWithClient(workspaceId, b, a)
    : mb ? await access.isCoachWithClient(workspaceId, a, b)
    : false;
  const former = open ? new Set<string>() : await access.formerClientsIn(workspaceId, [[a, b], [b, a]]);
  if (!open && former.size === 0) throw new NotFoundException(DM_NOT_FOUND);
  await safety.assertDmAllowed(a, b);
  if (open) return [ma, mb];
  return Promise.all([a, b].map((p) => (former.has(p) ? access.dmSettingRow(workspaceId, p) : null)));
}

/**
 * Single source of truth for the per-participant DM gate: a member whose
 * effective DM state (tri-state membership.dm_enabled → workspace
 * dm_enabled_default, on by default since 20270502011600, owner 203-D11) resolves false may neither send
 * NOR read DM data. Throws 403 DM_DISABLED. assertDmReadable (write/thread
 * reads, coach acks on a DM row) and listThreads (the thread-metadata read)
 * route through here so no DM surface can return data to a default-OFF caller.
 */
function gateDmRead(
  membership: Pick<CommunityMembership, 'dm_enabled'> | null,
  workspace: Pick<CommunityWorkspace, 'dm_enabled_default'> | null,
): void {
  if (!resolveDmEnabled(membership, workspace)) {
    throw new ForbiddenException(DM_DISABLED);
  }
}

function resolveDmEnabled(
  membership: Pick<CommunityMembership, 'dm_enabled'> | null,
  workspace: Pick<CommunityWorkspace, 'dm_enabled_default'> | null,
): boolean {
  if (membership && membership.dm_enabled !== null) {
    return membership.dm_enabled;
  }
  return workspace?.dm_enabled_default ?? false;
}

/** FR-1174: the full DM read rule, for `a` reading the DM with `b` (authoriseDm, and the coach ack
 * routes on a DM row): not oneself, assertDmOpen, then DMs effectively on for both. Throws the
 * refusal `a` gets (404 DM_NOT_FOUND, or 403 DM_DISABLED). */
export async function assertDmReadable(access: CommunityAccessService, safety: CommunitySafetyService,
  workspace: Pick<CommunityWorkspace, 'id' | 'dm_enabled_default'>, a: string, b: string): Promise<void> {
  if (a === b) throw new NotFoundException(DM_NOT_FOUND);
  for (const m of await assertDmOpen(access, safety, workspace.id, a, b)) gateDmRead(m, workspace);
}

/**
 * 1:1 direct messages within a workspace.
 *
 * DM eligibility follows the established v1-2 tri-state contract. The
 * resolveDmEnabled above is a local mirror of the community.service.ts resolver,
 * kept byte-for-byte in sync; a future refactor will share a single
 * implementation. A membership's dm_enabled is nullable — null inherits the
 * workspace's dm_enabled_default, an explicit boolean overrides. The default
 * is ON (owner 203-D11, #203-E49: dm_enabled_default defaults true, and
 * 20270502011600 set every existing community true); an explicit false on a
 * membership is that person's own off, and a community set false is off.
 *
 * DEVIATION (surfaced as a blocker in the report): the brief specifies a
 * tri-state dm_policy (coach_only | members | disabled) on the workspace. No
 * such column exists in the v1-1 schema (only dm_enabled_default:boolean and the
 * per-membership dm_enabled:boolean?). Adding it would violate R69. This module
 * therefore enforces the boolean gate that DOES exist: the pair must be open by
 * assertDmOpen (both active members of the same workspace, or the workspace's
 * coach with their own current client who is one) AND have DMs effectively
 * enabled (the coach, who has no membership row, by the workspace default). The
 * coach_only/members distinction is the single thing that cannot be honoured
 * until the column lands; assertDmReadable() is the one place to relax this.
 *
 * A pair assertDmOpen does not open gets 404 (cross-tenant non-leak posture). The
 * workspace coach's thread list holds only their threads with their own current
 * clients. A disabled recipient yields 403 with an explicit code so the client
 * can render "this member has DMs off".
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
   * when assertDmOpen does not open the pair (non-leak), 403 if either side has
   * DMs disabled. Returns the deterministic thread key.
   */
  private async authoriseDm(
    workspaceId: string,
    sender: User,
    recipientId: string,
  ): Promise<string> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(DM_NOT_FOUND);
    await assertDmReadable(this.access, this.safety, workspace, sender.id, recipientId);
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
    idempotencyKey?: string | null,
  ): Promise<CommunityDmMessageResponse & { crisis_flag?: true }> {
    const dmKey = await this.authoriseDm(workspaceId, user, recipientId);
    const screen = this.safety.screenText('dm', user.id, [body]);
    // SEND-ONCE-SERVER: a resend with the same Idempotency-Key (same author, same thread) answers with the first
    // message and repeats neither the realtime ping nor the push; the same key on other words is refused (409).
    const keyedId = idempotencyKey ? keyedSendId('dm', user.id, dmKey, idempotencyKey) : null;
    const sentBefore = keyedId ? await this.dms.findById(keyedId) : null;
    if (sentBefore) return { ...this.replay(sentBefore, user, dmKey, body), ...crisisField(screen) };
    const params = { workspaceId, dmKey, senderId: user.id, recipientId, body };
    const { row: created, replayed } = keyedId
      ? await this.dms.createKeyedDm(keyedId, params)
      : { row: await this.dms.createDm(params), replayed: false };
    if (replayed) return { ...this.replay(created, user, dmKey, body), ...crisisField(screen) };
    // #200-S1 / FIX-1232R1 C1: staff are told right after the write, before any later step that can throw.
    void this.safety.alertStaff(screen, created.id);
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
      deepLink: `tgp://community/dm/${user.id}`,
      otherUserId: created.sender_id,
      workspaceId,
    });
    const answer = CommunityDmMessageResponseSchema.parse({
      message: this.messageView(created),
    });
    return { ...answer, ...crisisField(screen) };
  }

  /** SEND-ONCE-SERVER: the first DM under a key, answered again only for the same author, thread and words. */
  private replay(row: CommunityMessage, user: User, dmKey: string, body: string): CommunityDmMessageResponse {
    const same = row.sender_id === user.id && row.scope === 'dm' && row.dm_key === dmKey && row.body === body;
    if (!same) throw new ConflictException(IDEMPOTENCY_KEY_REUSED);
    return CommunityDmMessageResponseSchema.parse({ message: this.messageView(row) });
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
    // COACH-DM-BE: the workspace's coach holds no membership row; they list only their threads with their own
    // current clients (assertDmOpen's coach pair), kept before the page is cut. COMMUNITY-DM-RULES-BE (203-D12):
    // and with their former clients who keep a thread (formerClientsIn); such a former client lists that one thread.
    const coach = workspace?.coach_id === user.id;
    const former = !workspace || membership || coach ? false
      : (await this.access.formerClientsIn(workspaceId, [[workspace.coach_id, user.id]])).has(user.id);
    if (!workspace || !(membership || coach || former)) {
      throw new NotFoundException(DM_NOT_FOUND);
    }
    // Reading thread metadata is a DM surface too: gate on the caller's
    // effective DM state before returning any rows.
    gateDmRead(former ? await this.access.dmSettingRow(workspaceId, user.id) : membership, workspace);
    // The other people whose thread the coach and former-client arms keep: asked once, before the page is cut.
    const kept = new Set<string>(former ? [workspace.coach_id] : []);
    const keep = coach
      ? async (others: string[]) => {
        const [clients, formers] = await Promise.all([this.dms.clientsAmong(user.id, others),
          this.access.formerClientsIn(workspaceId, others.map((o) => [user.id, o] as const))]);
        for (const o of formers) kept.add(o);
        return new Set([...clients, ...formers]);
      }
      : former ? async () => kept : undefined;
    const rows = await this.dms.listThreadsForUser({
      workspaceId,
      userId: user.id,
      limit: this.parsePage(query.limit),
      keep,
    });
    // #168-4: the other member's place in this community too (left, or banned). Owner 10-23
    // "Dissapear": a block either way drops the thread from both lists (no row, no name, no time);
    // unblock brings it back. Opening it another way answers 403 blocked_by_you / blocked_by_them.
    // A coach and former client's thread (203-D12) gets the block alone: their test already holds the rest.
    const other = (m: CommunityMessage) => (m.sender_id === user.id ? m.recipient_user_id : m.sender_id);
    const [placed, pairs] = await Promise.all([
      this.safety.filterBlocked(user.id, rows.filter((m) => !kept.has(other(m) ?? '')), other, (m) => [m.workspace_id, null]),
      this.safety.filterBlocked(user.id, rows.filter((m) => kept.has(other(m) ?? '')), other),
    ]);
    const shown = new Set([...placed, ...pairs]);
    const visible = rows.filter((m) => shown.has(m));
    return CommunityDmThreadListResponseSchema.parse({
      threads: visible.map((m) => ({
        thread_id: m.dm_key ?? '',
        workspace_id: m.workspace_id,
        other_user_id: m.sender_id === user.id ? (m.recipient_user_id ?? '') : m.sender_id,
        created_at: null,
        last_message_at: m.created_at.toISOString(),
      })),
    });
  }
}
