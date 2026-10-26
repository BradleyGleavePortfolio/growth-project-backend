import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CommunitySearchKind } from '@prisma/client';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma.service';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySearchEnabledGuard } from './community-search-flag.guard';
import { CommunitySearchService } from './community-search.service';
import { SearchIndexerService } from './search-indexer.service';
import {
  ReindexTargetSchema,
  SearchQuerySchema,
} from './community-search.dto';

// SPACE-404-CLASS (operator ruling 6353734516 on b#1137): the same 404 the
// search route gives a workspace the caller cannot read.
const REINDEX_NOT_FOUND = { error: 'not_found', code: 'community.search.not_found' } as const;

/**
 * v3-4 community search (read surface) + an OWNER/coach reindex hook.
 *
 * Guard layering mirrors the v3-3 voice controller. The search GET carries the
 * master CommunityFeatureFlagGuard PLUS the slice CommunitySearchEnabledGuard
 * (FEATURE_COMMUNITY_SEARCH, default off). Membership / cohort / role / soft-
 * delete visibility is enforced in the SERVICE + repository (DB-side), not by
 * @Roles alone, because students must reach the search route for their own
 * cohorts. The admin reindex POST is coach/owner-only (idempotent at the DB
 * layer via the unique key): only that workspace's coach or the platform owner
 * may use it, and the stored target decides the workspace, space and author.
 * Anything else answers the search 404 before any target lookup or write.
 */
@ApiTags('community')
@Controller('community')
export class CommunitySearchController {
  constructor(
    private readonly search: CommunitySearchService,
    private readonly indexer: SearchIndexerService,
    private readonly access: CommunityAccessService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Search (master + slice flag guard) ───────────────────────────────────

  @Get('workspaces/:workspaceId/search')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunitySearchEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    },
  })
  async query(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Query() rawQuery: unknown,
  ) {
    const query = parseOrThrow(SearchQuerySchema, rawQuery);
    return this.search.search(req.user, workspaceId, query);
  }

  // ── Admin reindex (coach/owner only, flag-gated) ──────────────────────────

  @Post('workspaces/:workspaceId/search/reindex')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunitySearchEnabledGuard,
  )
  @Roles('coach', 'owner')
  @HttpCode(202)
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    },
  })
  async reindex(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() rawBody: unknown,
  ) {
    const body = parseOrThrow(ReindexTargetSchema, rawBody);
    // Authority first: a caller who does not run this workspace learns
    // nothing about it or about the target.
    const user = req.user;
    const runsWorkspace =
      user.role === 'owner' || (await this.access.isWorkspaceCoach(workspaceId, user.id));
    if (!runsWorkspace) throw new NotFoundException(REINDEX_NOT_FOUND);
    // The stored target, not the body, binds the row. A missing target, one in
    // another workspace or outside a space, or a body that disagrees with it
    // about the space or author answers the same 404.
    const source = await findReindexSource(this.prisma, body.kind, body.targetId);
    if (
      !source ||
      source.workspaceId !== workspaceId ||
      (body.cohortId != null && body.cohortId !== source.cohortId) ||
      (body.authorId != null && body.authorId !== source.authorId)
    ) {
      throw new NotFoundException(REINDEX_NOT_FOUND);
    }
    if (body.remove) {
      await this.indexer.remove(
        workspaceId,
        body.kind,
        body.targetId,
      );
      return { accepted: true, removed: true };
    }
    const result = await this.indexer.index({
      workspaceId,
      cohortId: source.cohortId,
      kind: body.kind,
      targetId: body.targetId,
      authorId: source.authorId,
      title: body.title ?? null,
      tags: body.tags,
      transcript: body.transcript ?? null,
      // A deleted target stays out of search; a reindex never revives it.
      softDeletedAt: source.deletedAt,
    });
    return { accepted: true, created: result.created };
  }
}

interface ReindexSource {
  workspaceId: string;
  cohortId: string | null;
  authorId: string;
  deletedAt: Date | null;
}

/**
 * The stored target a reindex may describe, or null when there is none. A
 * direct-message voice note is not inside a space, so it is never indexable.
 */
async function findReindexSource(
  prisma: PrismaService,
  kind: CommunitySearchKind,
  id: string,
): Promise<ReindexSource | null> {
  switch (kind) {
    case CommunitySearchKind.post: {
      const row = await prisma.communityPost.findUnique({
        where: { id },
        select: { workspace_id: true, cohort_id: true, author_id: true, deleted_at: true },
      });
      return row && source(row.workspace_id, row.cohort_id, row.author_id, row.deleted_at);
    }
    case CommunitySearchKind.classroom_lesson: {
      const row = await prisma.communityClassroomPost.findUnique({
        where: { id },
        select: { workspace_id: true, cohort_id: true, coach_id: true, soft_deleted_at: true },
      });
      return row && source(row.workspace_id, row.cohort_id, row.coach_id, row.soft_deleted_at);
    }
    case CommunitySearchKind.voice_note_transcript: {
      const row = await prisma.communityVoiceNote.findUnique({
        where: { id },
        select: {
          workspace_id: true,
          cohort_id: true,
          conversation_id: true,
          author_id: true,
          soft_deleted_at: true,
        },
      });
      if (!row || row.conversation_id !== null) return null;
      return source(row.workspace_id, row.cohort_id, row.author_id, row.soft_deleted_at);
    }
    case CommunitySearchKind.event: {
      const row = await prisma.communityEvent.findUnique({
        where: { id },
        select: { workspace_id: true, cohort_id: true, created_by_id: true },
      });
      return row && source(row.workspace_id, row.cohort_id, row.created_by_id, null);
    }
    default:
      return null;
  }
}

function source(
  workspaceId: string,
  cohortId: string | null,
  authorId: string,
  deletedAt: Date | null,
): ReindexSource {
  return { workspaceId, cohortId, authorId, deletedAt };
}

/**
 * Zod-parse a query/body object, converting a ZodError into a 400 with the
 * field-level issues. Mirrors the wearable-samples controller helper; the
 * locked contract code for a community search validation failure is
 * COMMUNITY_SEARCH_QUERY_INVALID.
 */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'COMMUNITY_SEARCH_QUERY_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
