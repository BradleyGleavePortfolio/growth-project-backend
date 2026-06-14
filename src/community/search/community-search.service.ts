import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CommunityAccessService } from '../community-access.service';
import { COMMUNITY_TELEMETRY_EVENTS } from '../community-events';
import { CommunitySearchRepository } from './community-search.repository';
import {
  type SearchQuery,
  type SearchResponse,
  type SearchResultRow,
  SearchResponseSchema,
  resolveConfiguredPageSize,
} from './community-search.dto';

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.search.forbidden',
} as const;

interface DecodedCursor {
  rank: number;
  createdAt: Date;
  id: string;
}

/**
 * v3-4 community search (read surface).
 *
 * A member searches posts / classroom lessons / voice-note transcripts / events
 * across a workspace; results respect ALL existing visibility rules (workspace
 * membership, cohort membership, role allowlist, soft-delete) — enforced
 * DB-side in the repository so a hidden row can never become a cursor token
 * (the same doctrine the challenges leaderboard uses). The response carries
 * ids + a PII-stripped, body-free excerpt only — NEVER a body, transcript, or
 * any wearable metric value (brief §audit guarantees).
 *
 * TENANCY: the app runs as service_role (BYPASSRLS); a non-member of the
 * workspace is rejected 403 BEFORE any search runs (existence of the term is
 * never leaked). The migration RLS policies are defence-in-depth.
 */
@Injectable()
export class CommunitySearchService {
  private readonly logger = new Logger(CommunitySearchService.name);

  constructor(
    private readonly repo: CommunitySearchRepository,
    private readonly access: CommunityAccessService,
    private readonly analytics: AnalyticsService,
  ) {}

  async search(
    user: Pick<User, 'id' | 'role'>,
    workspaceId: string,
    query: SearchQuery,
  ): Promise<SearchResponse> {
    const startedAt = Date.now();

    // (1) Workspace membership gate FIRST — reject non-members before any
    // search executes so a cross-tenant term never even runs.
    const canAccess = await this.access.canAccessWorkspace(workspaceId, user);
    if (!canAccess) {
      throw new ForbiddenException(FORBIDDEN);
    }

    const isCoach =
      user.role === 'owner' ||
      (await this.access.isWorkspaceCoach(workspaceId, user.id));

    // A non-coach's visible cohorts (plus the workspace hall, cohort_id NULL)
    // are resolved here and pushed DB-side — never post-filtered.
    const accessibleCohortIds = isCoach
      ? []
      : (await this.access.listAccessibleCohortIds(workspaceId, user.id)).filter(
          (c): c is string => c !== null,
        );

    // If the caller asked to filter by a specific cohort they cannot see,
    // short-circuit to empty rather than leak that the cohort exists.
    if (
      query.cohortId &&
      !isCoach &&
      !accessibleCohortIds.includes(query.cohortId)
    ) {
      return this.emptyResponse(query.q, startedAt);
    }

    // Page size: the explicit ?limit (already Zod-capped at SEARCH_PAGE_SIZE_MAX)
    // when supplied, else the configured default (also clamped to the max).
    const pageSize = query.limit ?? resolveConfiguredPageSize();

    const cursor = query.cursor
      ? this.decodeCursor(query.cursor)
      : undefined;

    const rows = await this.repo.search({
      workspaceId,
      role: user.role,
      isCoach,
      accessibleCohortIds,
      term: query.q,
      kind: query.kind,
      cohortId: query.cohortId,
      limit: pageSize + 1, // fetch one extra to compute nextCursor
      cursor,
    });

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    const results: SearchResultRow[] = pageRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      targetId: r.target_id,
      cohortId: r.cohort_id,
      authorId: r.author_id,
      excerpt: r.excerpt,
      createdAt: r.created_at.toISOString(),
    }));

    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor({
            rank: pageRows[pageRows.length - 1]!.rank,
            createdAt: pageRows[pageRows.length - 1]!.created_at,
            id: pageRows[pageRows.length - 1]!.id,
          })
        : null;

    const tookMs = Date.now() - startedAt;

    // Telemetry — PII-stripped: never the raw term, only its length + result
    // count + latency. The pinned event-name test pins this string (R78).
    if (process.env.FEATURE_COMMUNITY_TELEMETRY === 'true') {
      this.analytics.capture(user.id, COMMUNITY_TELEMETRY_EVENTS.searchQueryIssued, {
        workspace_id: workspaceId,
        term_length: query.q.length,
        kind: query.kind ?? null,
        result_count: results.length,
        took_ms: tookMs,
      });
    }

    // Structured log — counts + metadata ONLY, never the term or row text.
    this.logger.log({
      event: 'community_search_query',
      workspace_id: workspaceId,
      user_id: user.id,
      term_length: query.q.length,
      kind: query.kind ?? null,
      result_count: results.length,
      took_ms: tookMs,
    });

    return SearchResponseSchema.parse({
      version: 1,
      query: query.q,
      results,
      nextCursor,
      tookMs,
    });
  }

  private emptyResponse(term: string, startedAt: number): SearchResponse {
    return SearchResponseSchema.parse({
      version: 1,
      query: term,
      results: [],
      nextCursor: null,
      tookMs: Date.now() - startedAt,
    });
  }

  /** Encode the keyset cursor as base64url(rank|createdAtIso|id). */
  private encodeCursor(c: DecodedCursor): string {
    const raw = `${c.rank}|${c.createdAt.toISOString()}|${c.id}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  /** Decode + validate a cursor; an unparseable cursor degrades to page 1. */
  private decodeCursor(cursor: string): DecodedCursor | undefined {
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const [rankStr, createdAtIso, id] = raw.split('|');
      const rank = Number(rankStr);
      const createdAt = new Date(createdAtIso ?? '');
      if (!Number.isFinite(rank) || Number.isNaN(createdAt.getTime()) || !id) {
        return undefined;
      }
      return { rank, createdAt, id };
    } catch {
      return undefined;
    }
  }
}
