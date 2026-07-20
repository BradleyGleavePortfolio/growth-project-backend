import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { errorEnvelopeSchema, rateLimitSchema } from '../common/errors/importer-error-responses';
import { ScoutEntitiesQueryDto, ScoutEntitiesResult } from './scout-entities.dto';
import { ScoutEntitiesService } from './scout-entities.service';

@ApiTags('scout')
@ApiBearerAuth('bearer')
@Controller('scout')
export class ScoutEntitiesController {
  constructor(private readonly entities: ScoutEntitiesService) {}

  /**
   * GET /api/scout/reconstruct/entities — IMPORTER-I. Read one settled intent's
   * reconstructed NON-person canonical entities (workouts / client_history) from
   * the generic ScoutReconstructedEntity table, one deterministic bounded page at
   * a time. This is the authoritative bridge the mobile consumer (PR-M4) reads;
   * the clients roster is served separately by IMPORTER-G.
   *
   * Auth mirrors reconstruct/roster: JwtAuthGuard attaches the coach identity and
   * coach_id is taken from the token (never the query/body), so a coach can only
   * read their own entities. @Roles('coach') + RolesGuard restrict the surface.
   *
   * Feature-gated as a subpath of /api/scout/reconstruct: dark unless BOTH
   * FEATURE_SCOUT_INGEST and FEATURE_SCOUT_RECONSTRUCT are exactly 'true'
   * (uniform R-DARK-1 404 before any guard runs). Read-only and idempotent.
   */
  @ApiOperation({
    summary: "Read a settled intent's reconstructed canonical entities for a family",
    description:
      'Returns the reconstructed non-person canonical rows (workouts / ' +
      'client_history) for one settled crawl intent and family, joined to the ' +
      'reconstruction ledger, with honest per-page metadata (page_count + an ' +
      'opaque forward-only cursor) and deterministic bounded pagination. Issues ' +
      'no full-collection total scan and is not a second progress system. ' +
      'Excludes cross-tenant rows and cascade-erased rows; never returns email or ' +
      'billing fields. Returns 404 when the intent is unknown for the caller or ' +
      'when the scout flags are off.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reconstructed entity page.',
    type: ScoutEntitiesResult,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid query (missing/oversized intent_id, unsupported family, out-of-range ' +
      'limit, or malformed/mismatched cursor). Standard HttpExceptionFilter envelope.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid bearer token.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not a coach.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 404,
    description:
      'Uniform not-found: the flags are off (R-DARK-1) OR the intent has no ' +
      'ScoutImport evidence for the calling coach (unknown, cross-tenant, or ' +
      'not-yet-settled). The cases are deliberately indistinguishable — no ' +
      'existence oracle.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded.',
    schema: rateLimitSchema(),
  })
  @Get('reconstruct/entities')
  // Feature gate: /api/scout/reconstruct/* is dark unless BOTH FEATURE_SCOUT_INGEST
  // and FEATURE_SCOUT_RECONSTRUCT are 'true', enforced by the global
  // featureFlagNotFoundMiddleware (R-DARK-1) BEFORE any guard runs. This route is
  // a subpath of the existing /api/scout/reconstruct pattern, so it inherits that
  // gate with no new flag. See src/common/feature-flag/feature-flag-not-found.middleware.ts.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  getEntities(
    @Req() req: AuthedRequest,
    @Query() query: ScoutEntitiesQueryDto,
  ): Promise<ScoutEntitiesResult> {
    return this.entities.getEntities(
      req.user.id,
      query.intent_id,
      query.family,
      query.cursor,
      query.limit,
    );
  }
}
