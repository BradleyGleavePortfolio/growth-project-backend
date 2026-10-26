import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CommunityCohort, CommunityMessage, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { type ChatVoiceNote, CommunityMessagesRepository } from './community-messages.repository';
import { PlanContextService, planTagsEnabled } from '../plan-context/plan-context.service';
import { acksEnabled } from '../ack/ack.feature';
import { buildSlaSnapshot } from '../ack/sla';
import type { MessageAckEnvelope } from '../dto/community-message.dto';
import { PlanContextTag, PlanContextTagSchema } from '../plan-context/plan-context.dto';
import {
  CommunityMessageListResponse,
  CommunityMessageListResponseSchema,
  CommunityMessageResponse,
  CommunityMessageResponseSchema,
  CommunityMessageView,
} from '../dto/community-message.dto';
import { CommunitySafetyService } from '../safety/community-safety.service';
import { placeOf } from '../community-space-access';
import { memberName } from '../member-display-name';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { describeFailure } from '../../observability/log-pii';
import {
  CommunityImageStore,
  communityImagesEnabled,
  IMAGE_READ_TTL_SEC,
  isOwnImage,
  isPublishableImageKey,
} from '../images/community-image-store';

/** SC-BE3: a photo message as the send route takes it. */
export interface ImageSend {
  key: string;
  width: number;
  height: number;
}
type ChatImage = NonNullable<CommunityMessageView['image']>;
const IMAGE_REJECTED = (code: string) => new UnprocessableEntityException({ error: 'invalid_image', code });

const EDIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.message.not_found',
} as const;

/** SC-BE1: how much of the answered message a reply quotes. */
const QUOTE_CHARS = 120;

/** SC-BE1: a quote of a message the viewer may no longer see says only that. */
const GONE = { gone: true, kind: null, sender_name: null, snippet: null, voice_duration_ms: null } as const;

/** SC-BE1: the sender and reply quote a space chat read adds to one row. */
type ChatOf = (m: CommunityMessage) => Pick<CommunityMessageView, 'sender' | 'parent'>;

/**
 * Cohort-channel messages (group chat within a cohort).
 *
 * Authorization mirrors the v1-2 doctrine: a caller who is not an active member
 * of the cohort (nor its coach/owner) gets 404 — never 403 — so a foreign
 * cohort id can't be probed for existence (cross-tenant leak gate).
 *
 * Edit/delete rules (brief §Messages):
 *  - PATCH: author only, within 5 minutes of creation.
 *  - DELETE: author, OR the workspace coach (moderator), OR platform owner.
 */
@Injectable()
export class CommunityMessagesService {
  private readonly logger = new Logger(CommunityMessagesService.name);

  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityMessagesRepository,
    private readonly realtime: CommunityRealtimeService,
    private readonly planContext: PlanContextService,
    private readonly safety: CommunitySafetyService,
    private readonly communityPush: CommunityNotificationsService,
    // SC-BE3: photo storage (optional so the positional test constructions
    // keep working; a photo send without it is 503).
    @Optional() private readonly images?: CommunityImageStore,
  ) {}

  private view(
    m: CommunityMessage,
    voice?: Map<string, ChatVoiceNote>,
    chat?: ChatOf,
    images?: Map<string, ChatImage>,
  ): CommunityMessageView {
    return {
      id: m.id,
      cohort_id: m.cohort_id,
      sender_user_id: m.sender_id,
      body: m.deleted_at ? null : m.body,
      kind: m.kind,
      created_at: m.created_at.toISOString(),
      updated_at: m.updated_at.toISOString(),
      edited: m.updated_at.getTime() - m.created_at.getTime() > 1000,
      deleted: m.deleted_at !== null,
      plan_context: this.viewPlanContext(m.plan_context_payload),
      // v2-2: attach the coach ack envelope ONLY when FEATURE_COMMUNITY_ACKS is
      // on. When off, the key is omitted entirely (spread of undefined adds no
      // key) so the v1-6/v2-1 response shape is preserved byte-for-byte
      // (kill-switch / back-compat invariant).
      ...(acksEnabled() ? { ack: this.viewAck(m) } : {}),
      parent_message_id: m.parent_message_id ?? null,
      voice_note: (!m.deleted_at && voice?.get(m.id)) || null,
      ...(chat ? chat(m) : {}),
      // SC-BE3: only on kind 'image' rows (other shapes are unchanged).
      ...(m.kind === 'image' ? { image: (!m.deleted_at && images?.get(m.id)) || null } : {}),
    };
  }

  /** SC-BE3: this page's live photos, each with a short-lived signed read URL. */
  private async imagesOf(rows: CommunityMessage[]): Promise<Map<string, ChatImage>> {
    const live = new Map(rows.filter((m) => m.kind === 'image' && !m.deleted_at).map((m) => [m.id, m]));
    if (live.size === 0) return new Map();
    const expires_at = new Date(Date.now() + IMAGE_READ_TTL_SEC * 1000).toISOString();
    // FX-1139 B2: only the message's own photo (its sender, its space) is signed.
    const found = (await this.repo.imagesFor([...live.keys()])).filter((i) => isOwnImage(live.get(i.message_id), i));
    const sign = async (key: string, owner: string) =>
      (await this.images?.createSignedDownload(key, IMAGE_READ_TTL_SEC, owner)) ?? null;
    return new Map(
      await Promise.all(
        found.map(async (i) => [i.message_id, { url: await sign(i.storage_key, i.author_id), width: i.width, height: i.height, expires_at }] as const),
      ),
    );
  }

  /**
   * SC-BE3: write a photo message. Flag off is 422. The key must be one this
   * server minted for this sender in this space (10 minutes); the object must
   * be at that key, JPEG and within 10 MB, else 422. Storage down is 503.
   * FX-1139: the rows and the copy to the sent key commit together.
   * FR-1139 (Sol C): a validated plan tag is stored, as on a text message.
   * PHOTO-GPS: a photo that carries a location is 422 community.image.has_location,
   * nothing is written and its upload is erased now; if that erase fails, the
   * upload's erasure row (recorded when its link was signed) erases it at link death.
   */
  private async createImage(
    user: User,
    cohort: CommunityCohort,
    body: string,
    parent: { id: string; at: Date } | null,
    image: ImageSend,
    planContext: PlanContextTag | null,
  ): Promise<CommunityMessage> {
    if (!communityImagesEnabled()) throw IMAGE_REJECTED('community.image.disabled');
    if (!isPublishableImageKey(image.key, user.id, cohort.id)) throw IMAGE_REJECTED('community.image.key_invalid');
    const images = this.images;
    if (!images) throw new ServiceUnavailableException({ error: 'unavailable', code: 'community.image.storage_unavailable' });
    const { result, size } = await images.check(image.key, user.id);
    if (result === 'unavailable') {
      throw new ServiceUnavailableException({ error: 'unavailable', code: 'community.image.storage_unavailable' });
    }
    if (result === 'has_location' && (await images.removeObjects([image.key]).catch(() => ({ failed: true }))).failed) {
      this.logger.warn('community.image outcome=has_location erase=deferred_to_link_expiry');
    }
    if (result !== 'ok') throw IMAGE_REJECTED(`community.image.${result}`);
    try {
      return await this.repo.createImageMessage({
        workspaceId: cohort.workspace_id,
        cohortId: cohort.id,
        senderId: user.id,
        body,
        planContext,
        parent,
        image: { key: image.key, width: image.width, height: image.height, sizeBytes: size },
        publish: () => images.publish(image.key),
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw IMAGE_REJECTED('community.image.key_used');
      throw e;
    }
  }

  /**
   * SC-BE1: who sent each row and what each reply answers, as this viewer may
   * see them, in one batch per page. Names follow the voice note rule
   * (#C6-NAMES-EVERYWHERE: full names in a space open to all of a coach's
   * clients, first names elsewhere). A parent that is deleted or removed, whose
   * author is blocked either way, or whose author left reads `gone` and nothing
   * else: no words, name or length.
   */
  private async chatOf(user: User, cohort: CommunityCohort, rows: CommunityMessage[]): Promise<ChatOf> {
    const x = await this.repo.chatExtras(user.id, cohort.workspace_id, cohort.id, rows);
    const live = x.parents.filter((p) => !p.deleted_at && p.plan_context_type === null);
    const parents = new Map(
      (await this.safety.filterBlocked(user.id, live, (p) => p.sender_id, placeOf)).map((p) => [p.id, p]),
    );
    const parentImages = await this.imagesOf([...parents.values()]); // FR-1139 (Opus C2): a quoted photo, signed
    const name = (m: CommunityMessage) =>
      memberName(x.people.get(m.sender_id)?.name, x.fullName(m.cohort_id, m.sender_id));
    return (m) => {
      const p = m.parent_message_id ? parents.get(m.parent_message_id) : undefined;
      const voice = p?.kind === 'voice';
      return {
        sender: {
          id: m.sender_id,
          name: name(m),
          avatar_url: x.people.get(m.sender_id)?.profile?.avatar_url ?? null,
          is_coach: m.sender_id === x.coachId,
        },
        parent: !m.parent_message_id
          ? null
          : p
            ? {
                id: p.id,
                gone: false,
                kind: p.kind,
                sender_name: name(p),
                snippet: voice ? null : Array.from(p.body ?? '').slice(0, QUOTE_CHARS).join(''),
                voice_duration_ms: voice ? p.voice_duration_ms : null,
                ...(p.kind === 'image' ? { image: parentImages.get(p.id) ?? null } : {}),
              }
            : { id: m.parent_message_id, ...GONE },
      };
    };
  }

  /**
   * SC-BE1: a text reply. The tapped message and its thread's first message are
   * each a live plain chat message in the same space whose author the caller can
   * see (blocks and bans, #168-4); a reply to a reply joins the first message's
   * thread (one level). A missing or hidden one is the message 404 (no new
   * words). In a coach-only space a member answers only a thread the coach
   * started (plan §3); any other thread needs the start right (403).
   * app.community_voice_reply (20270502009000) holds direct writes to the same.
   */
  private async replyParent(
    user: User,
    cohort: CommunityCohort,
    parentId: string | undefined,
  ): Promise<{ id: string; at: Date } | null> {
    if (!parentId) return null;
    const tapped = await this.liveParent(user, cohort.id, parentId);
    const root = tapped.parent_message_id
      ? await this.liveParent(user, cohort.id, tapped.parent_message_id)
      : tapped;
    const open =
      cohort.posting_policy !== 'coach' ||
      (await this.access.isWorkspaceCoach(cohort.workspace_id, root.sender_id));
    if (!open) await this.access.assertCanPost(cohort, user);
    return { id: root.id, at: root.created_at };
  }

  private async liveParent(user: User, cohortId: string, messageId: string): Promise<CommunityMessage> {
    const m = await this.repo.findById(messageId);
    if (!m || m.scope !== 'cohort' || m.cohort_id !== cohortId || m.deleted_at || m.plan_context_type !== null) {
      throw new NotFoundException(NOT_FOUND);
    }
    await this.safety.assertVisibleTo(user.id, m.sender_id, NOT_FOUND, placeOf(m));
    return m;
  }

  /** VOICE-BE: the voice notes behind this page's live voice messages (one read; none for text). */
  private async voiceOf(user: User, rows: CommunityMessage[]): Promise<Map<string, ChatVoiceNote>> {
    const ids = rows.filter((m) => m.kind === 'voice' && !m.deleted_at).map((m) => m.id);
    return ids.length > 0 ? this.repo.voiceNotesFor(ids, user.id) : new Map();
  }

  /**
   * v2-2: project the persisted coach_*_at columns into the optional ack
   * envelope shown TO the client. The SLA state is derived at read time from
   * the message receipt (created_at) vs the configured thresholds; the
   * timestamps mirror the existing columns (null when un-stamped). Read-only —
   * a read NEVER mutates ack state.
   */
  private viewAck(m: CommunityMessage): MessageAckEnvelope {
    return {
      seen_at: m.coach_seen_at ? m.coach_seen_at.toISOString() : null,
      acked_at: m.coach_acked_at ? m.coach_acked_at.toISOString() : null,
      replied_at: m.coach_replied_at ? m.coach_replied_at.toISOString() : null,
      sla_state: buildSlaSnapshot({ receivedAt: m.created_at }).sla_state,
    };
  }

  /**
   * Project the persisted plan_context_payload JsonB back into the typed tag
   * for the response. A row written before v2-1, or with the flag off, has a
   * null payload. We re-validate through PlanContextTagSchema so a row that
   * somehow holds a malformed payload surfaces as null rather than leaking an
   * unvalidated shape (defence-in-depth at the read boundary).
   */
  private viewPlanContext(payload: unknown): PlanContextTag | null {
    if (payload == null) return null;
    const parsed = PlanContextTagSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Resolve an incoming raw plan_context field into a validated tag to persist.
   *
   * Flag OFF: every incoming tag is dropped (returns null) with an INFO log
   *   carrying reason "flag_off_drop" — the send still succeeds (brief contract).
   * Flag ON, no field: returns null (untagged message).
   * Flag ON, field present: parsed by Zod (malformed → 422), then
   *   PlanContextService.validate() applies the existence + ownership gate
   *   (missing → 422, foreign coach → 403).
   */
  private async resolveIncomingPlanContext(
    user: User,
    raw: unknown,
  ): Promise<PlanContextTag | null> {
    if (raw == null) return null;
    if (!planTagsEnabled()) {
      this.logger.log(`dropping plan_context on send reason=flag_off_drop sender=${user.id}`);
      return null;
    }
    const parsed = PlanContextTagSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        error: 'unprocessable_entity',
        code: 'community.plan_context.malformed',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    return this.planContext.validate(user, parsed.data);
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

  async send(
    user: User,
    cohortId: string,
    body: string,
    planContextRaw?: unknown,
    parentId?: string,
    image?: ImageSend,
  ): Promise<CommunityMessageResponse> {
    const cohort = await this.access.findCohort(cohortId);
    // Treat a missing cohort and an unauthorised cohort identically (404).
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    // C6-B1: a section takes no messages; a coach-only space only the coach's.
    // SC-BE1: there a member may still reply to the coach's thread.
    if (!parentId || cohort.kind === 'section') await this.access.assertCanPost(cohort, user);
    const parent = await this.replyParent(user, cohort, parentId);
    // Apple 1.2: objectionable-content filter before anything is written.
    this.safety.assertAllowed(body);
    // v2-1: validate + authorize any attached plan-context tag BEFORE the write
    // (flag-off drops it; malformed → 422; missing entity → 422; foreign → 403).
    const planContext = await this.resolveIncomingPlanContext(user, planContextRaw);
    const created = image
      ? await this.createImage(user, cohort, body, parent, image, planContext)
      : await this.repo.createCohortMessage({
          workspaceId: cohort.workspace_id,
          cohortId: cohort.id,
          senderId: user.id,
          body,
          planContext,
          parent,
        });
    // v1-6 coach-inbox producer: a coach/owner message into the cohort answers
    // the cohort's outstanding client messages, so stamp coach_replied_at on
    // them (the inbox message arm keys "unanswered" off that column). Bounded to
    // the write result's cohort_id (never request params) and to client senders.
    if (user.role === 'coach' || user.role === 'owner') {
      await this.repo.markCohortClientMessagesReplied({
        cohortId: created.cohort_id ?? cohort.id,
        repliedAt: created.created_at,
      });
    }
    // v1-4 post-write tail: best-effort realtime ping (IDs only) to everyone who
    // may read the space now. The space comes from the WRITE RESULT's cohort_id
    // (never request params) so a foreign cohortId cannot mis-route it (#5 IDOR).
    // void-prefixed fire-and-forget — never blocks or fails the write (#24).
    void this.realtime.broadcastCommunityEvent(
      { workspaceId: created.workspace_id, cohortId: created.cohort_id ?? cohort.id },
      COMMUNITY_BROADCAST_EVENTS.messageCreated,
      {
        id: created.id,
        cohortId: created.cohort_id ?? cohort.id,
        authorId: created.sender_id,
        createdAt: created.created_at.toISOString(),
      },
      { distinctId: created.sender_id, channelKind: 'cohort' },
    );
    // C-S-PUSH-4: tell the other members about the new group message. Fire-and-
    // forget after the write; never blocks or fails the send.
    void this.pushCohortMessage(created, cohort.workspace_id, created.cohort_id ?? cohort.id);
    return CommunityMessageResponseSchema.parse({ message: this.view(created, undefined, undefined, await this.imagesOf([created])) });
  }

  /**
   * Group chat push (C-S-PUSH-4): one COMMUNITY_MESSAGE_RECEIVED push per
   * other active, unbanned member of the cohort, through the existing
   * sendCommunityPush (flag, "Mute all notifications", token and lock-screen
   * privacy gates live there; the body is the fixed safe string, never the
   * message text). Skips both sides of a block with the sender and members
   * whose cohort notify level is "quiet". Recipients come from the write
   * result's cohort, never request params.
   */
  private async pushCohortMessage(
    created: CommunityMessage,
    workspaceId: string,
    cohortId: string,
  ): Promise<void> {
    try {
      if (!this.communityPush.pushEnabled()) return;
      const members = await this.repo.listCohortPushRecipients({
        workspaceId,
        cohortId,
        senderId: created.sender_id,
      });
      if (members.length === 0) return;
      const hidden = await this.safety.hiddenFromViewer(created.sender_id);
      for (const m of members) {
        if (hidden.has(m.user_id) || m.notify_level === 'quiet') continue;
        void this.communityPush.sendCommunityPush({
          recipientId: m.user_id,
          kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
          targetType: 'message',
          targetId: created.id,
          deepLink: `tgp://community/cohorts/${cohortId}`,
        });
      }
    } catch (err) {
      this.logger.warn(
        `cohort message push skipped: message=${created.id} cohort=${cohortId}: ${describeFailure(err)}`,
      );
    }
  }

  async list(
    user: User,
    cohortId: string,
    query: { before?: string; limit?: string },
  ): Promise<CommunityMessageListResponse> {
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const limit = this.parsePage(query.limit);
    const rows = await this.repo.listCohortMessages({
      cohortId: cohort.id,
      before: this.parseBefore(query.before),
      limit,
    });
    const next = rows.length === limit ? rows[rows.length - 1].created_at.toISOString() : null;
    // Block filter AFTER the cursor is computed from the unfiltered page, so
    // pagination stays stable and a hidden row never becomes the cursor.
    const visible = await this.safety.filterBlocked(user.id, rows, (m) => m.sender_id, placeOf);
    const [voice, chat, images] = await Promise.all([
      this.voiceOf(user, visible),
      this.chatOf(user, cohort, visible),
      this.imagesOf(visible),
    ]);
    return CommunityMessageListResponseSchema.parse({
      messages: visible.map((m) => this.view(m, voice, chat, images)),
      next_before: next,
    });
  }

  async getOne(user: User, messageId: string): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    // Cross-surface containment: the cohort chat surface only owns plain
    // messages (plan_context_type === null). Any row carrying a non-null
    // discriminator is a sub-surface row — a post comment (v2-2) or a v3-1
    // challenge comment / leaderboard opt-in sentinel — and MUST be invisible
    // here so it can't be read/edited/deleted through the message endpoints.
    if (!m || m.scope !== 'cohort' || !m.cohort_id || m.plan_context_type !== null) {
      throw new NotFoundException(NOT_FOUND);
    }
    const cohort = await this.access.findCohort(m.cohort_id);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    // Two-way block: a direct id read cannot go around the list filter.
    await this.safety.assertVisibleTo(user.id, m.sender_id, NOT_FOUND, placeOf(m));
    const [voice, chat, images] = await Promise.all([
      this.voiceOf(user, [m]),
      this.chatOf(user, cohort, [m]),
      this.imagesOf([m]),
    ]);
    return CommunityMessageResponseSchema.parse({ message: this.view(m, voice, chat, images) });
  }

  async edit(user: User, messageId: string, body: string): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    // See getOne: any non-null plan_context_type row is a sub-surface row and
    // is not editable through the cohort chat message endpoint.
    if (
      !m ||
      m.scope !== 'cohort' ||
      !m.cohort_id ||
      m.deleted_at ||
      m.plan_context_type !== null ||
      m.kind === 'voice'
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    // Reads must be authorised before any author/edit-window check leaks state.
    const cohort = await this.access.findCohort(m.cohort_id);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (m.sender_id !== user.id) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.message.not_author',
      });
    }
    this.safety.assertAllowed(body);
    if (Date.now() - m.created_at.getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.message.edit_window_closed',
      });
    }
    const updated = await this.repo.updateBody(m, body);
    void this.realtime.broadcastCommunityEvent(
      { workspaceId: cohort.workspace_id, cohortId: cohort.id },
      COMMUNITY_BROADCAST_EVENTS.messageUpdated,
      {
        id: updated.id,
        cohortId: updated.cohort_id ?? m.cohort_id,
        updatedAt: updated.updated_at.toISOString(),
      },
      { distinctId: updated.sender_id, channelKind: 'cohort' },
    );
    // FX-1139 (C-2): a live photo keeps its `image` on the edit answer, as on GET.
    return CommunityMessageResponseSchema.parse({ message: this.view(updated, undefined, undefined, await this.imagesOf([updated])) });
  }

  async remove(user: User, messageId: string): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    // See getOne: any non-null plan_context_type row is a sub-surface row and
    // is not deletable through the cohort chat message endpoint. VOICE-BE: nor
    // is a voice message, and it is not editable either: DELETE
    // /community/voice-notes/:id (same id) also erases the recording.
    if (!m || m.scope !== 'cohort' || !m.cohort_id || m.plan_context_type !== null || m.kind === 'voice') {
      throw new NotFoundException(NOT_FOUND);
    }
    const cohort = await this.access.findCohort(m.cohort_id);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const isAuthor = m.sender_id === user.id;
    const isModerator =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(cohort.workspace_id, user.id));
    if (!isAuthor && !isModerator) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.message.not_author',
      });
    }
    if (m.deleted_at) {
      // Idempotent: already deleted is a no-op success.
      return CommunityMessageResponseSchema.parse({ message: this.view(m) });
    }
    if (m.kind === 'image') return this.removeImage(m, isAuthor);
    const deleted = await this.repo.softDelete(m);
    return CommunityMessageResponseSchema.parse({ message: this.view(deleted) });
  }

  /** SC-BE3: delete a photo message and erase its object (the voice erasure path and cron). */
  private async removeImage(m: CommunityMessage, isAuthor: boolean): Promise<CommunityMessageResponse> {
    const { deleted, work } = await this.repo.softDeleteImage(m, isAuthor ? 'author_delete' : 'moderation');
    if (work.length > 0) {
      await this.repo
        .attemptImageErasure(this.images, work, this.logger)
        .catch(() => this.logger.warn('community image erasure left to the cron'));
    }
    return CommunityMessageResponseSchema.parse({ message: this.view(deleted) });
  }
}
