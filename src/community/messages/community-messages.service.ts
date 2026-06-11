import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import {
  COMMUNITY_BROADCAST_EVENTS,
} from '../community-events';
import {
  COMMENT_CONTEXT_TYPE,
  CommunityMessagesRepository,
} from './community-messages.repository';
import {
  PlanContextService,
  planTagsEnabled,
} from '../plan-context/plan-context.service';
import {
  PlanContextTag,
  PlanContextTagSchema,
} from '../plan-context/plan-context.dto';
import {
  CommunityMessageListResponse,
  CommunityMessageListResponseSchema,
  CommunityMessageResponse,
  CommunityMessageResponseSchema,
  CommunityMessageView,
} from '../dto/community-message.dto';

const EDIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.message.not_found',
} as const;

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
  ) {}

  private view(m: CommunityMessage): CommunityMessageView {
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
      this.logger.log(
        `dropping plan_context on send reason=flag_off_drop sender=${user.id}`,
      );
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
  ): Promise<CommunityMessageResponse> {
    const cohort = await this.access.findCohort(cohortId);
    // Treat a missing cohort and an unauthorised cohort identically (404).
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    // v2-1: validate + authorize any attached plan-context tag BEFORE the write
    // (flag-off drops it; malformed → 422; missing entity → 422; foreign → 403).
    const planContext = await this.resolveIncomingPlanContext(
      user,
      planContextRaw,
    );
    const created = await this.repo.createCohortMessage({
      workspaceId: cohort.workspace_id,
      cohortId: cohort.id,
      senderId: user.id,
      body,
      planContext,
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
    // v1-4 post-write tail: best-effort realtime ping (IDs only). The cohort
    // shard is derived from the WRITE RESULT's cohort_id (never request
    // params) so a foreign cohortId cannot mis-route the broadcast (#5 IDOR).
    // void-prefixed fire-and-forget — never blocks or fails the write (#24).
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.cohort(
        created.cohort_id ?? cohort.id,
        this.realtime.cohortShard(created.cohort_id ?? cohort.id),
      ),
      COMMUNITY_BROADCAST_EVENTS.messageCreated,
      {
        id: created.id,
        cohortId: created.cohort_id ?? cohort.id,
        authorId: created.sender_id,
        createdAt: created.created_at.toISOString(),
      },
      { distinctId: created.sender_id, channelKind: 'cohort' },
    );
    return CommunityMessageResponseSchema.parse({ message: this.view(created) });
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
    const next =
      rows.length === limit ? rows[rows.length - 1].created_at.toISOString() : null;
    return CommunityMessageListResponseSchema.parse({
      messages: rows.map((m) => this.view(m)),
      next_before: next,
    });
  }

  async getOne(
    user: User,
    messageId: string,
  ): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    if (
      !m ||
      m.scope !== 'cohort' ||
      !m.cohort_id ||
      m.plan_context_type === COMMENT_CONTEXT_TYPE
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    const cohort = await this.access.findCohort(m.cohort_id);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    return CommunityMessageResponseSchema.parse({ message: this.view(m) });
  }

  async edit(
    user: User,
    messageId: string,
    body: string,
  ): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    if (
      !m ||
      m.scope !== 'cohort' ||
      !m.cohort_id ||
      m.deleted_at ||
      m.plan_context_type === COMMENT_CONTEXT_TYPE
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
    if (Date.now() - m.created_at.getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException({
        error: 'forbidden',
        code: 'community.message.edit_window_closed',
      });
    }
    const updated = await this.repo.updateBody(m, body);
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.cohort(
        updated.cohort_id ?? m.cohort_id,
        this.realtime.cohortShard(updated.cohort_id ?? m.cohort_id),
      ),
      COMMUNITY_BROADCAST_EVENTS.messageUpdated,
      {
        id: updated.id,
        cohortId: updated.cohort_id ?? m.cohort_id,
        updatedAt: updated.updated_at.toISOString(),
      },
      { distinctId: updated.sender_id, channelKind: 'cohort' },
    );
    return CommunityMessageResponseSchema.parse({ message: this.view(updated) });
  }

  async remove(
    user: User,
    messageId: string,
  ): Promise<CommunityMessageResponse> {
    const m = await this.repo.findById(messageId);
    if (
      !m ||
      m.scope !== 'cohort' ||
      !m.cohort_id ||
      m.plan_context_type === COMMENT_CONTEXT_TYPE
    ) {
      throw new NotFoundException(NOT_FOUND);
    }
    const cohort = await this.access.findCohort(m.cohort_id);
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const isAuthor = m.sender_id === user.id;
    const isModerator =
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(cohort.workspace_id, user.id));
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
    const deleted = await this.repo.softDelete(m);
    return CommunityMessageResponseSchema.parse({ message: this.view(deleted) });
  }
}
