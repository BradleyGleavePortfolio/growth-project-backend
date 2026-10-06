import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  CommunityModerationAction,
  CommunityModerationStatus,
  CommunityModerationTargetType,
  Prisma,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
import { CommunityMessagesRepository } from '../messages/community-messages.repository';
import { CommunityPostsRepository } from '../posts/community-posts.repository';
import { CommunityModerationRepository } from './community-moderation.repository';
import { PrismaService } from '../../prisma.service';
import { assertDmParticipantIfDm } from '../safety/community-safety.service';
import { VoiceUploadProvider } from '../voice/voice-upload.provider';
import { ReportAlertService } from '../../report-alerts/report-alert.service';
import { WIN_NOT_FOUND, winModerationWorkspaceId } from '../community-wins.policy';
import { recordWorkspaceBan } from '../community-ban';
import {
  storeModerationNotice,
  type ModerationNoticeResult,
} from '../safety/community-moderation-notices';
import {
  attemptVoiceErasures,
  objectTargets,
  recordVoiceErasures,
  type VoiceErasureRow,
} from '../voice/voice-erasure';
import {
  CommunityModerationItemListResponse,
  CommunityModerationItemListResponseSchema,
  CommunityModerationItemResponse,
  CommunityModerationItemResponseSchema,
  CommunityModerationItemView,
  ModerationActionKind,
  ReportTargetType,
} from '../dto/community-moderation.dto';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.moderation.not_found',
  message:
    'This item could not be found. It may have been removed or already handled. Refresh and try again.',
} as const;

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.moderation.not_moderator',
  message:
    'Only the coach who runs this community, or the TGP team, can review reports here. If you need help, email the safety contact in Community safety.',
} as const;

/**
 * A ban never removes the workspace coach or a platform owner (they run the
 * space and its moderation). Members whose MEMBERSHIP role is coach or
 * assistant can be banned by the workspace coach: they are members, not the
 * space owner.
 */
export const CANNOT_BAN_COACH = {
  error: 'forbidden',
  code: 'community.moderation.cannot_ban_coach',
  message:
    'The coach who runs this community and the TGP team cannot be banned. You can hide the content instead.',
} as const;

/**
 * B-610-4 round 5: enforcement strength. An actioned report may only move to
 * a stronger action; repeating the same action is an idempotent replay.
 */
const ACTION_STRENGTH: Record<string, number> = { dismiss: 0, warn: 1, hide: 2, ban: 3 };

const ACTION_LABEL: Record<string, string> = {
  warn: 'Warn',
  hide: 'Hide',
  ban: 'Ban',
  dismiss: 'Dismiss',
};

/** True when `next` may be applied to an item in its current state. */
export function moderationActionAllowed(
  current: { status: CommunityModerationStatus; action: string | null },
  next: string,
): boolean {
  if (current.status !== 'actioned') return true;
  const prev = current.action ?? '';
  if (prev === next) return true;
  return (ACTION_STRENGTH[next] ?? -1) > (ACTION_STRENGTH[prev] ?? 0);
}

/** 409 body for a weaker action or a Dismiss on an already-actioned report. */
export function alreadyActioned(currentAction: string | null) {
  const label = ACTION_LABEL[currentAction ?? ''] ?? 'an action';
  return {
    error: 'conflict',
    code: 'community.moderation.already_actioned',
    current_action: currentAction,
    message: `This report was already handled with ${label}. A handled report can only be made stronger (Warn, then Hide, then Ban). Refresh the queue to see where it stands.`,
  } as const;
}

/** 409 body when the item kept changing under concurrent moderators. */
export const MODERATION_CHANGED = {
  error: 'conflict',
  code: 'community.moderation.changed',
  message:
    'Another moderator acted on this report at the same moment. Refresh the queue to see the current outcome, then act again if needed.',
} as const;

/** Short-lived playback link for a reported voice note in the review queue. */
const QUEUE_PLAYBACK_TTL_SECONDS = 15 * 60;

/** Moderation target types the review queue renders and actions. */
const QUEUE_TARGET_TYPES: CommunityModerationTargetType[] = [
  'post',
  'message',
  'voice_note',
  'win',
];

export type FlaggedTargetType = 'post' | 'message' | 'voice_note' | 'win';

/** Playable media for a reported voice note (null for text targets). */
export interface FlaggedMediaView {
  kind: 'voice_note';
  /** Signed, short-lived download URL; null when storage is unavailable. */
  url: string | null;
  duration_ms: number;
  mime_type: string;
}

export interface FlaggedItemView {
  id: string;
  workspace_id: string;
  target_type: FlaggedTargetType;
  target_id: string;
  content: string;
  /** Voice notes: the audio to review. Removed or text targets: null. */
  media: FlaggedMediaView | null;
  /** True once the content was hidden or deleted (content reads "Removed"). */
  removed: boolean;
  /** created_at + 24 hours: the published review commitment for this report. */
  respond_by: string;
  /** True when the report is still open past respond_by. */
  overdue: boolean;
  author_user_id: string | null;
  author_name: string;
  cohort_name: string | null;
  reason: string;
  notes: string | null;
  created_at: string;
}

interface ResolvedReportTarget {
  workspaceId: string;
  targetType: CommunityModerationTargetType;
  targetId: string;
}

/**
 * Report → review → action moderation.
 *
 * Availability: moderation carries ONLY the master CommunityFeatureFlagGuard, never
 * the message/post/DM write kill switches. When those flags are off (a content
 * freeze) coaches must STILL be able to triage and action the existing queue —
 * pausing writes must not also pause safety tooling. This is enforced at the
 * controller (guard stack) and is a hard requirement of the brief.
 *
 * Reporting: any active workspace member may file a report on a message, post,
 * or comment. Acting on an item (hide/warn/ban/dismiss) is coach/owner only.
 *
 * DEVIATION (report): the brief lists `comment` as a report target, but
 * CommunityModerationTargetType has no `comment` member. Comments are stored as
 * CommunityMessage rows (see CommunityPostsService), so a `comment` report is
 * persisted with target_type=`message`, which is faithful to where the row
 * actually lives. The API DTO still accepts `comment` for client clarity.
 */
@Injectable()
export class CommunityModerationService {
  private readonly logger = new Logger(CommunityModerationService.name);

  constructor(
    private readonly access: CommunityAccessService,
    private readonly moderation: CommunityModerationRepository,
    private readonly messagesRepo: CommunityMessagesRepository,
    private readonly postsRepo: CommunityPostsRepository,
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
    private readonly prisma: PrismaService,
    private readonly voiceStorage: VoiceUploadProvider,
    // B-REPORTALERT-125: provided by CommunityModule; optional so unit
    // harnesses that build the service by hand keep working.
    @Optional() private readonly reportAlerts?: ReportAlertService,
  ) {}

  private itemView(a: CommunityModerationAction): CommunityModerationItemView {
    return {
      id: a.id,
      workspace_id: a.workspace_id,
      target_type: a.target_type,
      target_id: a.target_id,
      reported_by_user_id: a.reported_by_id,
      actor_user_id: a.actor_id,
      status: a.status,
      reason: a.reason,
      notes: a.notes,
      action: a.action,
      created_at: a.created_at.toISOString(),
      resolved_at: a.resolved_at?.toISOString() ?? null,
    };
  }

  private parsePage(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private parseStatus(status: string | undefined): CommunityModerationStatus | null {
    if (
      status === 'open' ||
      status === 'reviewed' ||
      status === 'actioned' ||
      status === 'dismissed'
    ) {
      return status;
    }
    return null;
  }

  /**
   * Resolve + authorise a report target, or throw 404. The reporter must be able
   * to read the target's workspace (cross-tenant non-leak posture). Maps the
   * API `comment` type onto a CommunityMessage row + the schema `message` type.
   */
  private async resolveReportTarget(
    user: User,
    apiType: ReportTargetType,
    targetId: string,
  ): Promise<ResolvedReportTarget> {
    if (apiType === 'post') {
      const post = await this.postsRepo.findById(targetId);
      if (!post || post.deleted_at) throw new NotFoundException(NOT_FOUND);
      if (!(await this.access.canAccessWorkspace(post.workspace_id, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
      return {
        workspaceId: post.workspace_id,
        targetType: 'post',
        targetId: post.id,
      };
    }

    if (apiType === 'voice_note') return this.resolveVoiceNoteTarget(user, targetId);
    if (apiType === 'win') return this.resolveWinTarget(user, targetId);

    // message OR comment — both are CommunityMessage rows.
    const msg = await this.messagesRepo.findById(targetId);
    if (!msg || msg.deleted_at) throw new NotFoundException(NOT_FOUND);
    if (msg.cohort_id) {
      const cohort = await this.access.findCohort(msg.cohort_id);
      if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
    } else if (!(await this.access.canAccessWorkspace(msg.workspace_id, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    // A DM can be reported only by one of its two participants, so a third
    // member cannot pull someone else's DM into the coach's queue by id.
    assertDmParticipantIfDm(msg, user.id, NOT_FOUND);
    return {
      workspaceId: msg.workspace_id,
      targetType: 'message',
      targetId: msg.id,
    };
  }

  /**
   * A voice note is reportable by anyone who can play it: a channel note by a
   * member of its cohort (or of the workspace for a hall note), and the
   * workspace coach / platform owner. Same 404 as "does not exist" otherwise.
   * Audio is never text-filtered (there is no transcription), so report plus
   * moderation is the safety control for voice.
   */
  private async resolveVoiceNoteTarget(
    user: User,
    targetId: string,
  ): Promise<ResolvedReportTarget> {
    const note = await this.prisma.communityVoiceNote.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        workspace_id: true,
        cohort_id: true,
        conversation_id: true,
        author_id: true,
        soft_deleted_at: true,
      },
    });
    if (!note || note.soft_deleted_at) throw new NotFoundException(NOT_FOUND);
    const isModerator =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(note.workspace_id, user.id));
    if (!isModerator) {
      if (note.conversation_id !== null) {
        // Direct-message voice notes are not offered; only their author could
        // ever read one, so nobody else can report it.
        if (note.author_id !== user.id) throw new NotFoundException(NOT_FOUND);
      } else if (note.cohort_id) {
        const cohort = await this.access.findCohort(note.cohort_id);
        if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
          throw new NotFoundException(NOT_FOUND);
        }
      } else if (!(await this.access.canAccessWorkspace(note.workspace_id, user))) {
        throw new NotFoundException(NOT_FOUND);
      }
    }
    return { workspaceId: note.workspace_id, targetType: 'voice_note', targetId: note.id };
  }

  /**
   * A member win is reportable by the people who can see it: teammates in the
   * same coach's circle, the coach, and the platform owner. The report lands
   * in the queue of the coach's community workspace (community-wins.policy).
   */
  private async resolveWinTarget(user: User, targetId: string): Promise<ResolvedReportTarget> {
    const win = await this.prisma.communityWin.findUnique({
      where: { id: targetId },
      select: { id: true, user_id: true, coach_id: true, hidden_at: true },
    });
    if (!win || win.hidden_at) throw new NotFoundException(WIN_NOT_FOUND);
    const sameCircle =
      user.role === 'owner' ||
      win.user_id === user.id ||
      (win.coach_id !== null &&
        (win.coach_id === user.id || (user.role === 'student' && user.coach_id === win.coach_id)));
    if (!sameCircle) throw new NotFoundException(WIN_NOT_FOUND);
    const workspaceId = await winModerationWorkspaceId(this.prisma, win.coach_id);
    if (!workspaceId) throw new NotFoundException(WIN_NOT_FOUND);
    return { workspaceId, targetType: 'win', targetId: win.id };
  }

  async report(
    user: User,
    apiType: ReportTargetType,
    targetId: string,
    reason: string,
    notes: string | undefined,
  ): Promise<CommunityModerationItemResponse> {
    const t = await this.resolveReportTarget(user, apiType, targetId);
    const created = await this.moderation.createReport({
      workspaceId: t.workspaceId,
      targetType: t.targetType,
      targetId: t.targetId,
      reportedById: user.id,
      reason,
      notes: notes ?? null,
    });
    // B-REPORTALERT-125: a person is told about every new report (ids and the
    // reason only, never the notes). reportFiled() never rejects.
    void this.reportAlerts?.reportFiled({
      kind: 'community',
      reportId: created.id,
      reason: created.reason,
      createdAt: created.created_at,
      targetType: created.target_type,
      targetId: created.target_id,
    });
    return CommunityModerationItemResponseSchema.parse({
      item: this.itemView(created),
    });
  }

  /** Coach (workspace owner) or platform owner may triage a queue. */
  private async assertModerator(workspaceId: string, user: User): Promise<void> {
    const isModerator =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(workspaceId, user.id));
    if (!isModerator) throw new ForbiddenException(FORBIDDEN);
  }

  async listQueue(
    user: User,
    workspaceId: string,
    query: { status?: string; limit?: string },
  ): Promise<CommunityModerationItemListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundException(NOT_FOUND);
    await this.assertModerator(workspaceId, user);
    const rows = await this.moderation.listForWorkspace({
      workspaceId,
      status: this.parseStatus(query.status),
      limit: this.parsePage(query.limit),
    });
    return CommunityModerationItemListResponseSchema.parse({
      items: rows.map((r) => this.itemView(r)),
    });
  }

  /**
   * Act on a queued item. `dismiss` closes it with no enforcement; hide/warn/ban
   * record the enforcement and mark it actioned. `hide` additionally soft-hides
   * the underlying content so the action has a real effect, not just an audit
   * note.
   *
   * B-610-4 round 5 (resolution rules):
   *  - repeating the action a report already has is an idempotent replay: no
   *    second notice, no second push, the existing notice is the accurate one;
   *  - an actioned report can only be escalated (Warn -> Hide -> Ban). The
   *    escalation stores the notice for the NEW action, so a Ban after a Warn
   *    leaves the member a ban notice;
   *  - a weaker action or a Dismiss on an actioned report is refused with
   *    409 community.moderation.already_actioned before anything is written;
   *  - the resolution is a compare-and-set inside the action transaction, so a
   *    concurrent action is re-evaluated instead of silently overwritten.
   *
   * B-610-13 (atomic enforcement): the resolution (compare-and-set), the
   * enforcement (ban row + memberships removed, content hidden), the recording
   * erasure intent and the member-readable notice are ONE database
   * transaction. Either all of them commit or none do: a failed notice write,
   * a failed commit or a process that dies mid-action leaves the member with
   * full access, the content visible and the report open, so the moderator's
   * retry (or the queue) applies it cleanly. Only external work runs after the
   * commit: the storage erasure attempt (durably recorded inside the
   * transaction and retried by VoiceErasureService), realtime and push.
   */
  async act(
    user: User,
    itemId: string,
    action: ModerationActionKind,
    notes: string | undefined,
  ): Promise<CommunityModerationItemResponse> {
    const item = await this.moderation.findById(itemId);
    if (!item) throw new NotFoundException(NOT_FOUND);
    await this.assertModerator(item.workspace_id, user);
    if (!moderationActionAllowed(item, action)) {
      throw new ConflictException(alreadyActioned(item.action));
    }

    // The member whose content this is (null when unresolvable or a dismiss).
    const ownerId =
      action === 'dismiss' ? null : await this.contentOwnerId(item.target_type, item.target_id);

    // A ban never removes the workspace coach or a platform owner. Checked
    // BEFORE the transaction opens, so a refused ban writes nothing at all.
    if (action === 'ban') await this.assertBannable(item.workspace_id, ownerId);

    const status: CommunityModerationStatus = action === 'dismiss' ? 'dismissed' : 'actioned';
    // Push stays a best-effort extra on top of the stored notice, sent only
    // when this call wrote a new notice.
    const notify = action !== 'dismiss' && ownerId !== null && ownerId !== user.id;
    const { resolved, notice, erasures } = await this.prisma.$transaction(async (tx) => {
      // The compare-and-set comes first: it takes the report's row lock, so a
      // concurrent moderator waits and is then re-evaluated against our
      // committed outcome.
      const row = await this.resolveGuarded(
        item,
        { actorId: user.id, status, action, notes: notes ?? null },
        tx,
      );
      let work: VoiceErasureRow[] = [];
      if (action === 'ban') {
        // A ban removes the content AND the author's access to the workspace:
        // a durable ban row (B-610-2) plus every membership -> removed. The
        // access service denies banned members everything (Hall, cohorts,
        // DMs, voice, challenges) and the bootstrap never re-admits them.
        await this.banAuthor(tx, item.workspace_id, ownerId, user.id, item.id);
      }
      if (action === 'ban' || action === 'hide') {
        work = await this.hideTarget(tx, item.target_type, item.target_id);
      }
      let result: ModerationNoticeResult = 'skipped';
      if (notify && ownerId) {
        result = await storeModerationNotice(tx, {
          recipientId: ownerId,
          moderationActionId: row.id,
          action,
          targetType: row.target_type,
          targetId: row.target_id,
        });
      }
      return { resolved: row, notice: result, erasures: work };
    });
    const noticeStored = notice !== 'skipped';

    // B-610-5: a hidden/banned voice note's recording erasure was recorded
    // durably in the action transaction (hideTarget, before the soft delete).
    // Storage is external, so it is tried only now, after the commit;
    // anything not verified stays open and VoiceErasureService retries it.
    if (erasures.length > 0) {
      try {
        const outcome = await attemptVoiceErasures(
          this.prisma,
          this.voiceStorage,
          erasures,
          this.logger,
        );
        if (outcome.pending > 0) {
          this.logger.warn(
            `moderation ${resolved.id}: voice recording removal not yet verified; erasure recorded and retried`,
          );
        }
      } catch (err) {
        // The action and its erasure work are committed; the retry cron owns
        // the work from here, so the moderator still gets the real outcome.
        this.logger.error(
          `moderation ${resolved.id}: erasure attempt failed after commit (${(err as Error).message}); VoiceErasureService retries it`,
        );
      }
    }

    // v1-4 post-action tail — best-effort realtime ping on the moderation
    // channel (IDs + enum action only, NEVER the moderation reason/notes,
    // #24/#36). Mobile moderators refetch the queue via authenticated REST.
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.moderation(resolved.workspace_id),
      COMMUNITY_BROADCAST_EVENTS.moderationActionCreated,
      {
        actionId: resolved.id,
        wsId: resolved.workspace_id,
        targetType: resolved.target_type,
        targetId: resolved.target_id,
        action: resolved.action ?? action,
      },
      { distinctId: user.id, channelKind: 'moderation' },
    );
    // Push to the affected member: best-effort extra on top of the stored
    // notice (gated behind FEATURE_COMMUNITY_PUSH inside the service). Only
    // for a notice written by this call: a replay never pushes twice.
    const pushed = notify && ownerId !== null && notice === 'created';
    if (pushed && ownerId) {
      void this.communityPush.sendCommunityPush({
        recipientId: ownerId,
        kind: NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
        targetType: resolved.target_type,
        targetId: resolved.target_id,
        deepLink: 'tgp://community/moderation',
      });
    }
    return CommunityModerationItemResponseSchema.parse({
      item: this.itemView(resolved),
      member_notice: {
        stored: noticeStored,
        // Push is attempted only as an extra; delivery is never promised.
        push: pushed ? 'attempted' : 'not_sent',
      },
    });
  }

  /**
   * Compare-and-set the resolution (B-610-4 round 5). If another moderator
   * changed the item between our read and this write, re-read it: a state we
   * may still escalate from is retried; a state that is already the same or
   * stronger is refused with a coded 409 (our enforcement, if any, is
   * contained in the stronger action: Ban hides, Hide is stronger than Warn).
   */
  private async resolveGuarded(
    item: CommunityModerationAction,
    params: {
      actorId: string;
      status: CommunityModerationStatus;
      action: ModerationActionKind;
      notes: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<CommunityModerationAction> {
    let expected: Pick<CommunityModerationAction, 'status' | 'action'> = item;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await this.moderation.resolveIfUnchanged(
        {
          itemId: item.id,
          expectedStatus: expected.status,
          expectedAction: expected.action,
          ...params,
        },
        tx,
      );
      if (row) return row;
      const current = await this.moderation.findById(item.id, tx);
      if (!current) throw new NotFoundException(NOT_FOUND);
      if (!moderationActionAllowed(current, params.action)) {
        throw new ConflictException(alreadyActioned(current.action));
      }
      expected = current;
    }
    throw new ConflictException(MODERATION_CHANGED);
  }

  /**
   * Resolve the owning user of a moderated target (post author or message
   * sender) so we can notify them. Returns null when unresolvable — the push
   * is simply skipped (best-effort, never throws).
   */
  private async contentOwnerId(
    targetType: CommunityModerationTargetType,
    targetId: string,
  ): Promise<string | null> {
    if (targetType === 'post') {
      const post = await this.postsRepo.findById(targetId);
      return post?.author_id ?? null;
    }
    if (targetType === 'message') {
      const msg = await this.messagesRepo.findById(targetId);
      return msg?.sender_id ?? null;
    }
    if (targetType === 'voice_note') {
      const note = await this.prisma.communityVoiceNote.findUnique({
        where: { id: targetId },
        select: { author_id: true },
      });
      return note?.author_id ?? null;
    }
    if (targetType === 'win') {
      const win = await this.prisma.communityWin.findUnique({
        where: { id: targetId },
        select: { user_id: true },
      });
      return win?.user_id ?? null;
    }
    return null;
  }

  /**
   * A ban never removes the workspace coach or a platform owner (a ban must
   * not lock a space out of its own moderator). Read-only, run before the
   * action transaction opens.
   */
  private async assertBannable(workspaceId: string, ownerId: string | null): Promise<void> {
    if (!ownerId) return;
    if (await this.access.isWorkspaceCoach(workspaceId, ownerId)) {
      throw new ForbiddenException(CANNOT_BAN_COACH);
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { role: true },
    });
    if (owner?.role === 'owner') {
      throw new ForbiddenException(CANNOT_BAN_COACH);
    }
  }

  /**
   * Ban the content owner from the workspace (B-610-2): a durable ban row
   * (authoritative for every read/write/bootstrap path, independent of
   * cohorts) plus every membership there -> removed. Runs inside the action
   * transaction (B-610-13); assertBannable has already refused a coach/owner.
   */
  private async banAuthor(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    ownerId: string | null,
    actorId: string,
    moderationActionId: string,
  ): Promise<void> {
    if (!ownerId) return;
    const removedAt = new Date();
    await recordWorkspaceBan(tx, {
      workspaceId,
      userId: ownerId,
      bannedById: actorId,
      moderationActionId,
      at: removedAt,
    });
    const updated = await tx.communityMembership.updateMany({
      where: { workspace_id: workspaceId, user_id: ownerId },
      data: { status: 'removed', removed_at: removedAt },
    });
    if (updated.count === 0) {
      // The author never joined a cohort here (possible for a member win).
      // The ban row above is what every path checks; a removed membership
      // in the current default cohort is kept as well so membership-only
      // readers (older code paths, reports) also see them as removed.
      const cohort = await tx.communityCohort.findFirst({
        where: { workspace_id: workspaceId, status: 'active', archived_at: null },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
        select: { id: true },
      });
      if (cohort) {
        await tx.communityMembership.upsert({
          where: { cohort_id_user_id: { cohort_id: cohort.id, user_id: ownerId } },
          create: {
            workspace_id: workspaceId,
            cohort_id: cohort.id,
            user_id: ownerId,
            role: 'student',
            status: 'removed',
            removed_at: removedAt,
          },
          update: { status: 'removed', removed_at: removedAt },
        });
      }
    }
  }

  /**
   * GET /community/moderation/flagged — the coach's review queue across every
   * workspace they own (platform owner: every workspace), open reports only,
   * oldest first (so the 24-hour commitment is worked in order), enriched
   * with the reported content, its author and cohort so the mobile reviewer
   * can decide without another round trip. Voice notes carry a short-lived
   * playback link (`media`). Content of already-removed targets is shown as
   * "Removed" with `removed: true`.
   */
  async listFlagged(user: User, query: { limit?: string }): Promise<{ items: FlaggedItemView[] }> {
    if (user.role !== 'coach' && user.role !== 'owner') {
      throw new ForbiddenException(FORBIDDEN);
    }
    const workspaceFilter = user.role === 'owner' ? {} : { workspace: { coach_id: user.id } };
    const rows = await this.prisma.communityModerationAction.findMany({
      where: {
        status: 'open',
        target_type: { in: QUEUE_TARGET_TYPES },
        ...workspaceFilter,
      },
      orderBy: { created_at: 'asc' },
      take: this.parsePage(query.limit),
    });
    if (rows.length === 0) return { items: [] };
    const idsOf = (t: CommunityModerationTargetType) =>
      rows.filter((r) => r.target_type === t).map((r) => r.target_id);
    const [posts, msgs, notes, wins] = await Promise.all([
      this.prisma.communityPost.findMany({
        where: { id: { in: idsOf('post') } },
        select: {
          id: true,
          title: true,
          body: true,
          author_id: true,
          cohort_id: true,
          deleted_at: true,
        },
      }),
      this.prisma.communityMessage.findMany({
        where: { id: { in: idsOf('message') } },
        select: {
          id: true,
          body: true,
          sender_id: true,
          cohort_id: true,
          deleted_at: true,
        },
      }),
      this.prisma.communityVoiceNote.findMany({
        where: { id: { in: idsOf('voice_note') } },
        select: {
          id: true,
          author_id: true,
          cohort_id: true,
          storage_key: true,
          duration_ms: true,
          mime_type: true,
          soft_deleted_at: true,
        },
      }),
      this.prisma.communityWin.findMany({
        where: { id: { in: idsOf('win') } },
        select: { id: true, user_id: true, title: true, description: true, hidden_at: true },
      }),
    ]);
    const postById = new Map(posts.map((p) => [p.id, p]));
    const msgById = new Map(msgs.map((m) => [m.id, m]));
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const winById = new Map(wins.map((w) => [w.id, w]));
    const authorIds = new Set<string>();
    const cohortIds = new Set<string>();
    for (const p of posts) {
      authorIds.add(p.author_id);
      if (p.cohort_id) cohortIds.add(p.cohort_id);
    }
    for (const m of msgs) {
      authorIds.add(m.sender_id);
      if (m.cohort_id) cohortIds.add(m.cohort_id);
    }
    for (const n of notes) {
      authorIds.add(n.author_id);
      if (n.cohort_id) cohortIds.add(n.cohort_id);
    }
    for (const w of wins) authorIds.add(w.user_id);
    const [users, cohorts] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...authorIds] } },
        select: { id: true, name: true },
      }),
      this.prisma.communityCohort.findMany({
        where: { id: { in: [...cohortIds] } },
        select: { id: true, name: true },
      }),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const cohortById = new Map(cohorts.map((c) => [c.id, c.name]));

    const now = Date.now();
    const items: FlaggedItemView[] = await Promise.all(
      rows.map(async (r) => {
        const respondBy = new Date(r.created_at.getTime() + REVIEW_WITHIN_MS);
        let content = REMOVED_CONTENT;
        let removed = true;
        let media: FlaggedMediaView | null = null;
        let authorId: string | null = null;
        let cohortId: string | null = null;
        let targetType: FlaggedTargetType = 'message';
        if (r.target_type === 'post') {
          targetType = 'post';
          const p = postById.get(r.target_id);
          if (p) {
            authorId = p.author_id;
            cohortId = p.cohort_id;
            if (!p.deleted_at) {
              content = [p.title, p.body].filter((x): x is string => !!x).join('\n\n');
              removed = false;
            }
          }
        } else if (r.target_type === 'voice_note') {
          targetType = 'voice_note';
          const n = noteById.get(r.target_id);
          if (n) {
            authorId = n.author_id;
            cohortId = n.cohort_id;
            if (!n.soft_deleted_at) {
              content = voiceNoteLabel(n.duration_ms);
              removed = false;
              media = {
                kind: 'voice_note',
                url: await this.voiceStorage.createSignedDownload(
                  n.storage_key,
                  QUEUE_PLAYBACK_TTL_SECONDS,
                  n.author_id,
                ),
                duration_ms: n.duration_ms,
                mime_type: n.mime_type,
              };
            }
          }
        } else if (r.target_type === 'win') {
          targetType = 'win';
          const w = winById.get(r.target_id);
          if (w) {
            authorId = w.user_id;
            if (!w.hidden_at) {
              content = [w.title, w.description].filter((x) => !!x).join('\n\n');
              removed = false;
            }
          }
        } else {
          const m = msgById.get(r.target_id);
          if (m) {
            authorId = m.sender_id;
            cohortId = m.cohort_id;
            if (!m.deleted_at) {
              content = m.body ?? '';
              removed = false;
            }
          }
        }
        return {
          id: r.id,
          workspace_id: r.workspace_id,
          target_type: targetType,
          target_id: r.target_id,
          content,
          media,
          removed,
          author_user_id: authorId,
          author_name: (authorId && nameById.get(authorId)) || 'Member',
          cohort_name: cohortId ? (cohortById.get(cohortId) ?? null) : null,
          reason: r.reason,
          notes: r.notes,
          created_at: r.created_at.toISOString(),
          respond_by: respondBy.toISOString(),
          overdue: respondBy.getTime() < now,
        };
      }),
    );
    return { items };
  }

  /**
   * Soft-hide the content a moderation action targets, where applicable,
   * inside the action transaction (B-610-13). Returns the recorded erasure
   * work for a voice note (attempted by act() after the commit).
   */
  private async hideTarget(
    tx: Prisma.TransactionClient,
    targetType: CommunityModerationTargetType,
    targetId: string,
  ): Promise<VoiceErasureRow[]> {
    // B-610-13: every read and write here uses the action transaction.
    if (targetType === 'post') {
      const post = await this.postsRepo.findById(targetId, tx);
      if (post && !post.deleted_at) await this.postsRepo.softDelete(post.id, tx);
      return [];
    }
    if (targetType === 'message') {
      const msg = await this.messagesRepo.findById(targetId, tx);
      if (msg && !msg.deleted_at) {
        await this.messagesRepo.softDelete({ id: msg.id, created_at: msg.created_at }, tx);
      }
      return [];
    }
    if (targetType === 'voice_note') {
      // Same soft delete as the author's own delete: every read path
      // (list, by id, search, signed playback) skips soft-deleted notes.
      // The recording itself is erased after the action commits (act()).
      const at = new Date();
      const note = await tx.communityVoiceNote.findUnique({
        where: { id: targetId },
        select: { storage_key: true },
      });
      // B-610-5 round 5: the recording erasure is recorded durably BEFORE
      // the soft delete (and, B-610-13, in the same transaction), so a crash
      // or storage outage can never strand it.
      const work = note
        ? await recordVoiceErasures(tx, objectTargets([note.storage_key]), 'moderation')
        : [];
      await tx.communityVoiceNote.updateMany({
        where: { id: targetId, soft_deleted_at: null },
        data: { soft_deleted_at: at },
      });
      await tx.communitySearchEntry.updateMany({
        where: { kind: 'voice_note_transcript', targetId, softDeletedAt: null },
        data: { softDeletedAt: at },
      });
      return work;
    }
    if (targetType === 'win') {
      await tx.communityWin.updateMany({
        where: { id: targetId, hidden_at: null },
        data: { hidden_at: new Date() },
      });
    }
    return [];
  }
}

const REMOVED_CONTENT = 'Removed';

/** The published commitment: reports are reviewed within 24 hours. */
export const REVIEW_WITHIN_MS = 24 * 60 * 60 * 1000;

/** Queue label for a voice note, e.g. "Voice note, 0:42". */
export function voiceNoteLabel(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `Voice note, ${minutes}:${seconds}`;
}
