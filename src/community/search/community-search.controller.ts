import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySearchEnabledGuard } from './community-search-flag.guard';
import { CommunitySearchService } from './community-search.service';
import { SearchIndexerService } from './search-indexer.service';
import {
  ReindexTargetSchema,
  SearchQuerySchema,
} from './community-search.dto';

/**
 * v3-4 community search (read surface) + an OWNER/coach reindex hook.
 *
 * Guard layering mirrors the v3-3 voice controller. The search GET carries the
 * master CommunityFeatureFlagGuard PLUS the slice CommunitySearchEnabledGuard
 * (FEATURE_COMMUNITY_SEARCH, default off). Membership / cohort / role / soft-
 * delete visibility is enforced in the SERVICE + repository (DB-side), not by
 * @Roles alone, because students must reach the search route for their own
 * cohorts. The admin reindex POST is coach/owner-only (idempotent at the DB
 * layer via the unique key).
 */
@ApiTags('community')
@Controller('community')
export class CommunitySearchController {
  constructor(
    private readonly search: CommunitySearchService,
    private readonly indexer: SearchIndexerService,
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
    @Request() _req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() rawBody: unknown,
  ) {
    const body = parseOrThrow(ReindexTargetSchema, rawBody);
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
      cohortId: body.cohortId ?? null,
      kind: body.kind,
      targetId: body.targetId,
      authorId: body.authorId ?? null,
      title: body.title ?? null,
      tags: body.tags,
      transcript: body.transcript ?? null,
    });
    return { accepted: true, created: result.created };
  }
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
