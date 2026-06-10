import { ForbiddenException, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import {
  CommunityCoachInboxRepository,
  MessageWithSender,
  PostWithAuthor,
} from './community-coach-inbox.repository';
import {
  CoachInboxQueryDto,
  CoachInboxResponse,
  CoachInboxResponseSchema,
  InboxItemView,
} from './community-coach-inbox.dto';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const PREVIEW_MAX = 200;

const NOT_COACH = {
  error: 'forbidden',
  code: 'community.inbox.not_coach',
} as const;

// Internal merge shape carrying the sort key (created_at, id) alongside the
// rendered view so the FIFO merge + tiebreak is explicit and testable.
interface RankedItem {
  createdAt: Date;
  id: string;
  view: InboxItemView;
}

/**
 * Coach inbox aggregator — an oldest-first (FIFO) triage queue of unanswered
 * client items across EVERY cohort the caller coaches (owns or co-coaches).
 *
 * Authorization: the caller must coach at least one cohort
 * (coachedCohortIds non-empty) — otherwise 403 not_coach. Every returned item
 * is bounded to those coached cohorts, so the queue can never surface content
 * from a cohort the caller does not coach (cross-tenant non-leak).
 *
 * Sort: created_at ASC, then id ASC (deterministic FIFO tiebreak). Messages and
 * posts are merged into one stream and paginated by an opaque keyset cursor.
 */
@Injectable()
export class CommunityCoachInboxService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly repo: CommunityCoachInboxRepository,
  ) {}

  private parseLimit(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private decodeCursor(
    raw: string | undefined,
  ): { createdAt: Date; id: string } | null {
    if (!raw) return null;
    try {
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      const sep = decoded.lastIndexOf('|');
      if (sep <= 0) return null;
      const createdAt = new Date(decoded.slice(0, sep));
      const id = decoded.slice(sep + 1);
      if (Number.isNaN(createdAt.getTime()) || !id) return null;
      return { createdAt, id };
    } catch {
      return null;
    }
  }

  private encodeCursor(item: { createdAt: Date; id: string }): string {
    return Buffer.from(
      `${item.createdAt.toISOString()}|${item.id}`,
      'utf8',
    ).toString('base64url');
  }

  private preview(body: string | null): string {
    const text = (body ?? '').replace(/\s+/g, ' ').trim();
    return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
  }

  private messageItem(
    m: MessageWithSender,
    cohortName: string,
  ): RankedItem {
    return {
      createdAt: m.created_at,
      id: m.id,
      view: {
        id: m.id,
        type: 'message',
        cohort_id: m.cohort_id as string,
        cohort_name: cohortName,
        author_user_id: m.sender_id,
        author_display_name: m.sender.name,
        preview: this.preview(m.body),
        created_at: m.created_at.toISOString(),
        item_url_path: `/community/cohorts/${m.cohort_id}/messages/${m.id}`,
      },
    };
  }

  private postItem(p: PostWithAuthor, cohortName: string): RankedItem {
    const previewSource = p.body ?? p.title ?? '';
    return {
      createdAt: p.created_at,
      id: p.id,
      view: {
        id: p.id,
        type: 'post',
        cohort_id: p.cohort_id as string,
        cohort_name: cohortName,
        author_user_id: p.author_id,
        author_display_name: p.author.name,
        preview: this.preview(previewSource),
        created_at: p.created_at.toISOString(),
        item_url_path: `/community/cohorts/${p.cohort_id}/posts/${p.id}`,
      },
    };
  }

  /** created_at ASC, then id ASC. */
  private compare(a: RankedItem, b: RankedItem): number {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  private afterCursor(
    item: RankedItem,
    cursor: { createdAt: Date; id: string } | null,
  ): boolean {
    if (!cursor) return true;
    const t = item.createdAt.getTime() - cursor.createdAt.getTime();
    if (t !== 0) return t > 0;
    return item.id > cursor.id;
  }

  async list(
    user: User,
    query: CoachInboxQueryDto,
  ): Promise<CoachInboxResponse> {
    const cohortIds = await this.repo.coachedCohortIds(user.id);
    if (cohortIds.length === 0) {
      // The caller coaches no cohort — they have no inbox to triage.
      throw new ForbiddenException(NOT_COACH);
    }

    const limit = this.parseLimit(query.limit);
    const cursor = this.decodeCursor(query.cursor);

    // Over-fetch each stream up to `limit` past the cursor; the merge + slice
    // below yields the correct first `limit` across both streams. Because each
    // stream is itself keyset-filtered by `after`, the union of the two
    // `limit`-bounded streams always contains the global first `limit` items.
    const [messages, posts] = await Promise.all([
      this.repo.unansweredMessages({ cohortIds, limit, after: cursor }),
      this.repo.unansweredPosts({ cohortIds, limit, after: cursor }),
    ]);

    // Resolve cohort names once for every cohort referenced in this page.
    const cohortNames = await this.resolveCohortNames([
      ...messages.map((m) => m.cohort_id as string),
      ...posts.map((p) => p.cohort_id as string),
    ]);

    const ranked: RankedItem[] = [
      ...messages.map((m) =>
        this.messageItem(m, cohortNames.get(m.cohort_id as string) ?? ''),
      ),
      ...posts.map((p) =>
        this.postItem(p, cohortNames.get(p.cohort_id as string) ?? ''),
      ),
    ]
      .filter((item) => this.afterCursor(item, cursor))
      .sort((a, b) => this.compare(a, b));

    const page = ranked.slice(0, limit);
    const nextCursor =
      ranked.length > limit && page.length === limit
        ? this.encodeCursor(page[page.length - 1])
        : null;

    return CoachInboxResponseSchema.parse({
      items: page.map((r) => r.view),
      next_cursor: nextCursor,
    });
  }

  private async resolveCohortNames(
    cohortIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(cohortIds)];
    const map = new Map<string, string>();
    await Promise.all(
      unique.map(async (id) => {
        const cohort = await this.access.findCohort(id);
        if (cohort) map.set(id, cohort.name);
      }),
    );
    return map;
  }
}
