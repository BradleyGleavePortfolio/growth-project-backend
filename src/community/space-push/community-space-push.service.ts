/**
 * SC-PUSH: the space chat's pushes. CommunityRealtimeService calls `messageStored` once for every stored space
 * message (text and voice today; images ride the same messageCreated point), behind FEATURE_COMMUNITY_SPACE_PUSH
 * (default off). Only chat messages push: the rows the unread count counts (scope cohort, no plan tag, not
 * deleted), so a post comment never does. A sender banned from the community causes none. Recipients are
 * everyone who may read the space now (app.community_can_access, so no banned member), minus the sender and
 * anyone who blocks the sender or is blocked by them (owner 10-22: hide ALL messaging), each with their own
 * setting for the space and their own unread count. A reply or High alert opens the space at that message; the
 * unread notification opens it at the read line. Delivery is the push outbox (NotificationsService.sendPush):
 * the master switch, quiet hours held to the morning and the lock-screen rule apply as for every other push.
 * Fire-and-forget: it never throws into the write.
 */
import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotificationKind } from '../../notifications/notification-kind';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma.service';
import { isBannedFromWorkspace } from '../community-ban';
import { fullNamesFor, readersNow } from '../community-space-access';
import { memberName } from '../member-display-name';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { notifySettingOf, spaceUnreadCounts } from '../space-reads/community-space-reads.service';
import { HIGH_ALERT_DAILY_LIMIT, planSpacePush, spacePushOn, type SpacePushReader } from './space-push-policy';

export interface HighAlertAllowance {
  reach: number;
  used_today: number;
  limit: number;
}

@Injectable()
export class CommunitySpacePushService implements OnModuleInit {
  private readonly logger = new Logger(CommunitySpacePushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly realtime: CommunityRealtimeService,
  ) {}

  onModuleInit(): void {
    this.realtime.onSpaceMessageStored((messageId) => this.messageStored(messageId));
  }

  /** Who would hear a High alert in this space now: readers minus the sender, blocked pairs and Mute all. */
  async highAlertReach(senderId: string, workspaceId: string, cohortId: string): Promise<number> {
    const readers = await this.readers(senderId, workspaceId, cohortId, false);
    return readers.filter((r) => r.effectiveMode !== 'mute_all').length;
  }

  /** Only the coach of the space's community may send a High alert; at most HIGH_ALERT_DAILY_LIMIT there a
   * day (UTC day; deleted ones still count). 403 `community.high_alert.coach_only` for anyone else. */
  async highAlertAllowance(userId: string, cohort: { id: string; workspace_id: string }): Promise<HighAlertAllowance> {
    const ws = await this.prisma.communityWorkspace.findUnique({ where: { id: cohort.workspace_id }, select: { coach_id: true } });
    if (!ws || ws.coach_id !== userId) throw new ForbiddenException({ code: 'community.high_alert.coach_only' });
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const [used_today, reach] = await Promise.all([
      this.prisma.communityMessage.count({ where: { cohort_id: cohort.id, high_alert: true, created_at: { gte: since } } }),
      this.highAlertReach(userId, cohort.workspace_id, cohort.id),
    ]);
    return { reach, used_today, limit: HIGH_ALERT_DAILY_LIMIT };
  }

  async markHighAlert(messageId: string): Promise<void> {
    await this.prisma.communityMessage.updateMany({ where: { id: messageId }, data: { high_alert: true } });
  }

  async messageStored(messageId: string): Promise<void> {
    if (!spacePushOn()) return;
    try {
      const m = await this.prisma.communityMessage.findFirst({
        where: { id: messageId, scope: 'cohort', plan_context_type: null, deleted_at: null },
        select: { id: true, workspace_id: true, cohort_id: true, sender_id: true, parent_message_id: true, high_alert: true },
      });
      if (!m?.cohort_id) return;
      const cohortId = m.cohort_id;
      const [cohort, parent, banned] = await Promise.all([
        this.prisma.communityCohort.findUnique({ where: { id: cohortId }, select: { name: true } }),
        m.parent_message_id
          ? this.prisma.communityMessage.findFirst({
              where: { id: m.parent_message_id, cohort_id: cohortId, scope: 'cohort', deleted_at: null },
              select: { sender_id: true },
            })
          : null,
        isBannedFromWorkspace(this.prisma, m.workspace_id, m.sender_id),
      ]);
      if (!cohort || banned) return;
      const readers = await this.readers(m.sender_id, m.workspace_id, cohortId, true);
      const pushes = planSpacePush({ senderId: m.sender_id, repliedToId: parent?.sender_id ?? null, highAlert: m.high_alert }, readers);
      for (const p of pushes) {
        const from = p.kind === 'reply' ? await this.nameIn(cohortId, m.workspace_id, m.sender_id, p.userId) : undefined;
        void this.notifications.sendPush({
          user_id: p.userId,
          kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
          body: '',
          deep_link: `tgp://community/cohorts/${cohortId}${p.kind === 'unread' ? '' : `?message=${m.id}`}`,
          // Each message is its own outbox event, so the unread notification updates instead of being dropped.
          dedupe_key: `space-push:${m.id}:${p.userId}`,
          context: { spacePush: { kind: p.kind, unread: p.unread, space: cohort.name, cohortId, ...(from ? { from } : {}) } },
        });
      }
    } catch (err) {
      this.logger.warn(`space push skipped: message=${messageId} error=${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  /** #168-14: the sender's name as `viewerId` sees it in the space (memberName); undefined when none is stored. */
  private async nameIn(cohortId: string, workspaceId: string, senderId: string, viewerId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: senderId }, select: { name: true } });
    if (!user?.name?.trim()) return undefined;
    const full = await fullNamesFor(this.prisma, viewerId, workspaceId, [[cohortId, senderId]]);
    return memberName(user.name, full(cohortId, senderId));
  }

  private async readers(senderId: string, workspaceId: string, cohortId: string, withUnread: boolean): Promise<SpacePushReader[]> {
    const everyone = (await readersNow(this.prisma, workspaceId, cohortId)).filter((id) => id !== senderId);
    if (everyone.length === 0) return [];
    const [blocks, rows, cohort] = await Promise.all([
      this.prisma.userBlock.findMany({
        where: { OR: [{ blocker_id: senderId, blocked_id: { in: everyone } }, { blocked_id: senderId, blocker_id: { in: everyone } }] },
        select: { blocker_id: true, blocked_id: true },
      }),
      this.prisma.communitySpaceRead.findMany({
        where: { cohort_id: cohortId, user_id: { in: everyone } },
        select: { user_id: true, notify_mode: true, silenced_until: true },
      }),
      this.prisma.communityCohort.findUniqueOrThrow({ where: { id: cohortId }, select: { kind: true } }),
    ]);
    const hidden = new Set(blocks.flatMap((b) => [b.blocker_id, b.blocked_id]));
    const rowOf = new Map(rows.map((r) => [r.user_id, r]));
    const now = new Date();
    const out: SpacePushReader[] = [];
    for (const userId of everyone) {
      if (hidden.has(userId)) continue;
      const { effective_mode } = notifySettingOf(cohort, rowOf.get(userId) ?? null, now);
      const unread =
        withUnread && effective_mode === 'all' ? ((await spaceUnreadCounts(this.prisma, userId, [cohortId])).get(cohortId) ?? 0) : 0;
      out.push({ userId, effectiveMode: effective_mode, unread });
    }
    return out;
  }
}
