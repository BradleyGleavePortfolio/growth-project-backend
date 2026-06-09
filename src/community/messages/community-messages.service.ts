import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import {
  COMMENT_CONTEXT_TYPE,
  CommunityMessagesRepository,
} from './community-messages.repository';
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
  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityMessagesRepository,
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

  async send(
    user: User,
    cohortId: string,
    body: string,
  ): Promise<CommunityMessageResponse> {
    const cohort = await this.access.findCohort(cohortId);
    // Treat a missing cohort and an unauthorised cohort identically (404).
    if (!cohort || !(await this.access.canAccessCohort(cohort, user))) {
      throw new NotFoundException(NOT_FOUND);
    }
    const created = await this.repo.createCohortMessage({
      workspaceId: cohort.workspace_id,
      cohortId: cohort.id,
      senderId: user.id,
      body,
    });
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
