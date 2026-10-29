import { Injectable, type Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommunityMessage, CommunityMessageImage } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import type { PlanContextTag } from '../plan-context/plan-context.dto';
import { bannedAmong } from '../community-ban';
import { authorsWhoLeft, fullNamesFor, rowsWithSpaceAccess } from '../community-space-access';
import { clientsAmong, isPublicRowOfMyClient } from '../community-public-row';
import { bytesToPeaks } from '../voice/community-voice.dto';
import { storeRemovalNotice } from '../safety/community-moderation-notices';
import { imageErasureTargets, sentImageKey } from '../images/community-image-store';
import {
  attemptVoiceErasures,
  recordVoiceErasures,
  type VoiceErasureOutcome,
  type VoiceErasureReason,
  type VoiceErasureRow,
  type VoiceErasureStorage,
} from '../voice/voice-erasure';
import { LOCK_NS_COMMUNITY_MESSAGE_KEY } from './message-idempotency';

/** A new text message in a space. */
export interface NewCohortMessage {
  workspaceId: string;
  cohortId: string;
  senderId: string;
  body: string;
  // v2-1: a validated plan-context tag to persist into plan_context_payload
  // (JsonB). Null/undefined writes a SQL NULL — the common, untagged case and
  // the only case when FEATURE_COMMUNITY_PLAN_TAGS is off (tag dropped on send).
  planContext?: PlanContextTag | null;
  // SC-BE1: the thread's first message this reply answers, or none.
  parent?: { id: string; at: Date } | null;
}

/** SC-BE3: a new photo message (caption in `body`) and its photo. */
export interface NewImageMessage extends NewCohortMessage {
  image: { key: string; width: number; height: number; sizeBytes: number };
  /** FX-1139: copies the upload to its sent key; runs after the rows, so a reused key never copies. */
  publish: () => Promise<void>;
}

const cohortMessageData = (params: NewCohortMessage): Prisma.CommunityMessageUncheckedCreateInput => ({
  workspace_id: params.workspaceId,
  cohort_id: params.cohortId,
  scope: 'cohort',
  kind: 'text',
  sender_id: params.senderId,
  body: params.body,
  visibility: 'active',
  parent_message_id: params.parent?.id ?? null,
  parent_message_at: params.parent?.at ?? null,
  plan_context_payload:
    params.planContext == null
      ? Prisma.JsonNull
      : (params.planContext as unknown as Prisma.InputJsonValue),
});

/** A space's client messages still waiting on a coach reply (the coach inbox message arm) that
 * `viewerId` can read (FR-1174): the authors authorsWhoLeft names for this space — moved away, banned,
 * or in a block either way with the viewer — stay out, as the inbox and getOne leave them out. */
export async function openClientMessagesReadBy(prisma: PrismaService, cohortId: string,
  viewerId: string): Promise<Prisma.CommunityMessageWhereInput> {
  const hidden = (await authorsWhoLeft(prisma, [cohortId], viewerId)).map(([, a]) => a);
  return {
    cohort_id: cohortId,
    scope: 'cohort',
    deleted_at: null,
    plan_context_type: null,
    coach_replied_at: null,
    ...(hidden.length > 0 ? { sender_id: { notIn: hidden } } : {}),
    sender: { role: { notIn: ['coach', 'owner'] } },
  };
}

/** VOICE-BE: what a voice chat message shows before play (the URL comes from the voice route). */
export interface ChatVoiceNote {
  id: string;
  duration_ms: number;
  waveform_peaks: number[] | null;
  heard_at: string | null;
}

/**
 * Data access for cohort messages and post-comments.
 *
 * Tenant scoping follows the v1-2 doctrine (community.repository.ts): the app
 * connects as the Supabase service_role (BYPASSRLS), so isolation is enforced
 * HERE in explicit query filters, never assumed from Postgres RLS. Every read
 * is bounded by cohort/workspace membership at the service layer; the methods
 * below take the already-authorised cohort/workspace id.
 *
 * community_messages has a COMPOSITE primary key [id, created_at] (Postgres
 * range partitioning). Prisma cannot findUnique/update/delete by `id` alone, so
 * single-row reads use findFirst({ where: { id } }) and mutations resolve the
 * partition key (created_at) first, then update by the composite unique.
 */
@Injectable()
export class CommunityMessagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SC-BE1: what a page of space chat rows needs for one viewer, in at most
   * five reads: the reply parents it names (inside that space only), the coach,
   * each person's name and avatar, and the voice note full-name rule.
   */
  /** Rule D (FR-1173R2): is the viewer the sender's own coach for this public space row (community-public-row.ts)? */
  isPublicRowOfMyClient(cohortId: string, viewerId: string, senderId: string): Promise<boolean> {
    return isPublicRowOfMyClient(this.prisma, cohortId, viewerId, senderId);
  }

  /** Rule D (FR-1173R2): the people among `ids` who are the viewer's current clients. */
  clientsAmong(viewerId: string, ids: string[]): Promise<Set<string>> {
    return clientsAmong(this.prisma, viewerId, ids);
  }

  async chatExtras(viewerId: string, workspaceId: string, cohortId: string, rows: CommunityMessage[]) {
    const ids = [...new Set(rows.flatMap((m) => (m.parent_message_id ? [m.parent_message_id] : [])))];
    const parents = ids.length
      ? await this.prisma.communityMessage.findMany({
          where: { id: { in: ids }, cohort_id: cohortId, scope: 'cohort' },
        })
      : [];
    const named = [...rows, ...parents];
    // REMOVED-BY-BE: a coach-removed row also names who removed it.
    const removers = rows.flatMap((m) => (m.deleted_at && m.removed_by_user_id ? [[m.cohort_id, m.removed_by_user_id] as const] : []));
    const [workspace, users, fullName] = await Promise.all([
      this.prisma.communityWorkspace.findUnique({ where: { id: workspaceId }, select: { coach_id: true } }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set([...named.map((m) => m.sender_id), ...removers.map(([, id]) => id)])] } },
        select: { id: true, name: true, profile: { select: { avatar_url: true } } },
      }),
      fullNamesFor(this.prisma, viewerId, workspaceId, [
        ...named.map((m) => [m.cohort_id, m.sender_id] as const),
        ...removers,
      ]),
    ]);
    const people = new Map(users.map((u) => [u.id, u]));
    return { parents, coachId: workspace?.coach_id ?? null, people, fullName };
  }

  async createCohortMessage(params: NewCohortMessage): Promise<CommunityMessage> {
    return this.prisma.communityMessage.create({ data: cohortMessageData(params) });
  }

  /**
   * FX-IDEM: the keyed send. One transaction lock per message id (the id an author's Idempotency-Key names in
   * a space, message-idempotency.ts), then the first row with that id is returned as is, or the row is written
   * under that id. Racing resends wait on the lock and read the first row; no unique index is needed.
   */
  async createKeyedCohortMessage(
    id: string,
    params: NewCohortMessage,
  ): Promise<{ row: CommunityMessage; replayed: boolean }> {
    return this.prisma.$transaction((tx) =>
      this.keyed(tx, id, () => tx.communityMessage.create({ data: { ...cohortMessageData(params), id } })));
  }

  /** FX-IDEM: under the transaction lock on a keyed id, the first row with it (a replay), else `write`'s new row. */
  private async keyed(
    tx: Prisma.TransactionClient,
    id: string,
    write: () => Promise<CommunityMessage>,
  ): Promise<{ row: CommunityMessage; replayed: boolean }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_COMMUNITY_MESSAGE_KEY}::int4, hashtext(${id}))`;
    const first = await tx.communityMessage.findFirst({ where: { id } });
    return first ? { row: first, replayed: true } : { row: await write(), replayed: false };
  }

  /**
   * Group chat push recipients (C-S-PUSH-4): every ACTIVE member of the cohort
   * other than the sender, minus anyone with an active ban in the workspace
   * (a ban also marks memberships removed; the ban row is the authority).
   * Block filtering and the notify level are applied by the caller.
   */
  async listCohortPushRecipients(params: {
    workspaceId: string;
    cohortId: string;
    senderId: string;
  }): Promise<Array<{ user_id: string; notify_level: string }>> {
    const rows = await this.prisma.communityMembership.findMany({
      where: {
        cohort_id: params.cohortId,
        status: 'active',
        user_id: { not: params.senderId },
      },
      select: { user_id: true, notify_level: true },
    });
    const banned = await bannedAmong(
      this.prisma,
      params.workspaceId,
      rows.map((r) => r.user_id),
    );
    // C6-BVIS: only people the rule still lets into the space get the push.
    return rowsWithSpaceAccess(
      this.prisma,
      rows.filter((r) => !banned.has(r.user_id)),
      (r) => [params.cohortId, r.user_id] as const,
    );
  }

  /**
   * Clear the "unanswered" flag on a cohort's outstanding client messages.
   *
   * Producer for the coach-inbox message arm (community-coach-inbox.repository
   * `unansweredMessages` reads `coach_replied_at IS NULL`). Called when a coach
   * sends a cohort message: every prior non-deleted, non-comment CLIENT message
   * in that cohort that is still open is stamped `coach_replied_at = now`, so it
   * drops out of the inbox. Bounded to client (non coach/owner) senders so the
   * coach's own messages are never flagged, and (FR-1174) to rows the sender
   * `viewerId` can read. Returns the count updated.
   */
  async markCohortClientMessagesReplied(params: {
    cohortId: string;
    repliedAt: Date;
    viewerId: string;
  }): Promise<number> {
    const { count } = await this.prisma.communityMessage.updateMany({
      where: await openClientMessagesReadBy(this.prisma, params.cohortId, params.viewerId),
      data: { coach_replied_at: params.repliedAt },
    });
    return count;
  }

  /** VOICE-BE: the live voice notes behind these voice chat messages (same ids), for one viewer. */
  async voiceNotesFor(ids: string[], viewerId: string): Promise<Map<string, ChatVoiceNote>> {
    if (ids.length === 0) return new Map();
    const [notes, heard] = await Promise.all([
      this.prisma.communityVoiceNote.findMany({
        where: { id: { in: ids }, soft_deleted_at: null },
        select: { id: true, duration_ms: true, waveform_peaks: true },
      }),
      this.prisma.communityVoiceNoteListen.findMany({ where: { user_id: viewerId, voice_note_id: { in: ids } } }),
    ]);
    const heardAt = new Map(heard.map((h) => [h.voice_note_id, h.heard_at.toISOString()]));
    return new Map(notes.map((n) => [n.id, {
      id: n.id,
      duration_ms: n.duration_ms,
      waveform_peaks: bytesToPeaks(n.waveform_peaks),
      heard_at: heardAt.get(n.id) ?? null,
    }]));
  }

  /**
   * A single message by id (any scope), or null.
   *
   * v2-2: this returns the full CommunityMessage row (no `select` projection),
   * so the existing coach_seen_at / coach_acked_at / coach_replied_at columns
   * are included in the result and the service can build the ack envelope when
   * FEATURE_COMMUNITY_ACKS is on. No new columns are introduced (R69).
   */
  /** `tx`: run inside the caller's transaction (moderation act, B-610-13). */
  async findById(
    messageId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CommunityMessage | null> {
    return (tx ?? this.prisma).communityMessage.findFirst({
      where: { id: messageId },
    });
  }

  /**
   * Cohort messages newest-first, cursor-paginated by created_at. `before` is an
   * ISO timestamp; rows strictly older than it are returned. Soft-deleted rows
   * are excluded.
   *
   * Post-comments are stored as CommunityMessage rows (scope='cohort', same
   * cohort_id) tagged with plan_context_type=COMMENT_CONTEXT_TYPE. They must NOT
   * appear in the cohort chat feed, so this list is bounded to rows with a null
   * discriminator. The community module is the only writer of plan_context_type
   * on cohort-scope messages (verified by grep), so `null` is the tightest
   * correct exclusion — a plain cohort message never sets it.
   */
  // v2-2: like findById, this list returns full rows (no `select`), so the
  // existing coach_*_at ack columns ride along for the read-side ack envelope
  // when FEATURE_COMMUNITY_ACKS is on. No new columns are introduced (R69).
  async listCohortMessages(params: {
    cohortId: string;
    before: Date | null;
    limit: number;
  }): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        cohort_id: params.cohortId,
        scope: 'cohort',
        // REMOVED-BY-BE: live rows, plus a coach's removal (a placeholder).
        // An author's own delete and older removals stay gone.
        OR: [{ deleted_at: null }, { removed_by_user_id: { not: null } }],
        plan_context_type: null,
        ...(params.before ? { created_at: { lt: params.before } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: params.limit,
    });
  }

  async updateBody(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
    body: string,
  ): Promise<CommunityMessage> {
    return this.prisma.communityMessage.update({
      where: {
        id_created_at: { id: message.id, created_at: message.created_at },
      },
      data: { body },
    });
  }

  async softDelete(
    message: Pick<CommunityMessage, 'id' | 'created_at'>,
    tx?: Prisma.TransactionClient,
  ): Promise<CommunityMessage> {
    return (tx ?? this.prisma).communityMessage.update({
      where: {
        id_created_at: { id: message.id, created_at: message.created_at },
      },
      data: { deleted_at: new Date(), visibility: 'hidden' },
    });
  }

  /**
   * REMOVED-BY-BE (#174-4): a coach (or the TGP owner) removes someone else's
   * message. One write keeps who removed it and when (the placeholder) and
   * erases the words; the same transaction stores the author's notice (the
   * report queue's hide notice, once per message). An already-removed row is
   * returned unchanged with no second notice. FR-1165R: the report queue's
   * Hide writes the same removal with `tellAuthor` false (it stores its own
   * once-only notice for the action).
   */
  async removeByCoach(
    message: Pick<CommunityMessage, 'id' | 'created_at' | 'sender_id'>,
    removerId: string,
    tx?: Prisma.TransactionClient,
    tellAuthor = true,
  ): Promise<CommunityMessage> {
    const run = async (t: Prisma.TransactionClient) => {
      const hit = await t.communityMessage.updateMany({
        where: { id: message.id, created_at: message.created_at, deleted_at: null },
        data: { deleted_at: new Date(), visibility: 'hidden', removed_by_user_id: removerId, body: null },
      });
      if (hit.count > 0 && tellAuthor) {
        await storeRemovalNotice(t, { recipientId: message.sender_id, targetType: 'message', targetId: message.id });
      }
      const row = await t.communityMessage.findUnique({
        where: { id_created_at: { id: message.id, created_at: message.created_at } },
      });
      if (!row) throw new Error('community message vanished during removal');
      return row;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  // ── Post comments (stored as CommunityMessage; see service docblock) ───────

  async createComment(params: {
    workspaceId: string;
    cohortId: string | null;
    senderId: string;
    postId: string;
    body: string;
  }): Promise<CommunityMessage> {
    return this.prisma.communityMessage.create({
      data: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        scope: 'cohort',
        kind: 'text',
        sender_id: params.senderId,
        body: params.body,
        visibility: 'active',
        plan_context_type: COMMENT_CONTEXT_TYPE,
        plan_context_id: params.postId,
      },
    });
  }

  /** FR-1165R3: `withRemoved` keeps a coach's removals for their placeholders. */
  async listComments(postId: string, withRemoved = false): Promise<CommunityMessage[]> {
    return this.prisma.communityMessage.findMany({
      where: {
        plan_context_type: COMMENT_CONTEXT_TYPE,
        plan_context_id: postId,
        ...(withRemoved ? { OR: [{ deleted_at: null }, { removed_by_user_id: { not: null } }] } : { deleted_at: null }),
      },
      orderBy: { created_at: 'asc' },
    });
  }

  // ── SC-BE3: photos in the space chat ───────────────────────────────────────

  /** A kind 'image' message (caption in `body`) and its photo row, in one transaction. */
  async createImageMessage(params: NewImageMessage): Promise<CommunityMessage> {
    return this.prisma.$transaction((tx) => this.imageRows(tx, params), { timeout: 15_000 });
  }

  /** FR-1144B (Sol B1): a photo under an Idempotency-Key, by createKeyedCohortMessage's rule; a replay copies nothing. */
  async createKeyedImageMessage(id: string, params: NewImageMessage): Promise<{ row: CommunityMessage; replayed: boolean }> {
    return this.prisma.$transaction((tx) => this.keyed(tx, id, () => this.imageRows(tx, params, id)), { timeout: 15_000 });
  }

  private async imageRows(tx: Prisma.TransactionClient, params: NewImageMessage, id?: string): Promise<CommunityMessage> {
    const m = await tx.communityMessage.create({ data: { ...cohortMessageData(params), kind: 'image', ...(id ? { id } : {}) } });
    await tx.communityMessageImage.create({
      data: {
        message_id: m.id,
        cohort_id: params.cohortId,
        author_id: params.senderId,
        storage_key: sentImageKey(params.image.key),
        width: params.image.width,
        height: params.image.height,
        size_bytes: params.image.sizeBytes,
        mime: 'image/jpeg',
      },
    });
    await params.publish();
    return m;
  }

  /** The photo rows behind these image messages. */
  async imagesFor(ids: string[]): Promise<CommunityMessageImage[]> {
    if (ids.length === 0) return [];
    return this.prisma.communityMessageImage.findMany({ where: { message_id: { in: ids } } });
  }

  /**
   * Delete an image message: record the object's erasure (B-610-5 order), then
   * soft-delete the message, in one transaction. The caller tries the erasure
   * after commit; an unverified row stays open for the voice erasure cron.
   */
  async softDeleteImage(
    message: Pick<CommunityMessage, 'id' | 'created_at' | 'sender_id'>,
    reason: VoiceErasureReason,
    removerId: string | null = null,
  ): Promise<{ deleted: CommunityMessage; work: VoiceErasureRow[] }> {
    return this.prisma.$transaction(async (tx) => {
      const image = await tx.communityMessageImage.findUnique({ where: { message_id: message.id } });
      const work = image ? await recordVoiceErasures(tx, imageErasureTargets(image.storage_key), reason) : [];
      // REMOVED-BY-BE: a coach's removal keeps who and when (placeholder) and tells the author.
      const deleted = removerId ? await this.removeByCoach(message, removerId, tx) : await this.softDelete(message, tx);
      return { deleted, work };
    });
  }

  /** Try the recorded image erasure now; an unverified row stays open for the voice erasure cron. */
  async attemptImageErasure(
    images: VoiceErasureStorage | undefined,
    rows: VoiceErasureRow[],
    logger?: Pick<Logger, 'warn' | 'error'>,
  ): Promise<VoiceErasureOutcome> {
    return attemptVoiceErasures(this.prisma, { images }, rows, logger);
  }
}

/**
 * Discriminator written to community_messages.plan_context_type so a post
 * comment is distinguishable from a plain cohort message. plan_context_id holds
 * the parent post id. Reusing these existing columns avoids a schema change
 * (R69) while storing the full comment body honestly in the 4000-char `body`
 * column (no truncation).
 */
export const COMMENT_CONTEXT_TYPE = 'community_post_comment';
