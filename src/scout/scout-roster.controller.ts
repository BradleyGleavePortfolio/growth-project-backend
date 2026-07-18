import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { errorEnvelopeSchema, rateLimitSchema } from '../common/errors/importer-error-responses';
import { ScoutRosterQueryDto, ScoutRosterResult } from './scout-roster.dto';
import { ScoutRosterService } from './scout-roster.service';

@ApiTags('scout')
@ApiBearerAuth('bearer')
@Controller('scout')
export class ScoutRosterController {
  constructor(private readonly roster: ScoutRosterService) {}

  /**
   * GET /api/scout/reconstruct/roster — IMPORTER-G. Read one settled intent's
   * reconstructed invite-pending roster (canonical Person rows joined to the
   * ScoutReconstructionLedger) plus honest ledger-derived accounting. This is
   * the authoritative bridge mobile PR-M3 consumes.
   *
   * Auth mirrors reconstruct: JwtAuthGuard attaches the coach identity and
   * coach_id is taken from the token (never the query/body), so a coach can only
   * read their own roster. @Roles('coach') + RolesGuard restrict the surface.
   *
   * Feature-gated as a subpath of /api/scout/reconstruct: dark unless BOTH
   * FEATURE_SCOUT_INGEST and FEATURE_SCOUT_RECONSTRUCT are exactly 'true'
   * (uniform R-DARK-1 404 before any guard runs). Read-only and idempotent.
   */
  @ApiOperation({
    summary: "Read a settled intent's reconstructed invite-pending roster",
    description:
      'Returns the invite-pending roster Person records reconstructed from one ' +
      'settled crawl intent, joined to the reconstruction ledger, with honest ' +
      'accounting { staged, reconstructed, skipped, failed } and deterministic, ' +
      'bounded cursor pagination. Excludes deleted and cross-tenant rows; never ' +
      'returns email or billing fields. Returns 404 when the intent is unknown ' +
      'for the caller or when the scout flags are off.',
  })
  @ApiResponse({ status: 200, description: 'Reconstructed roster page.', type: ScoutRosterResult })
  @ApiResponse({
    status: 400,
    description:
      'Invalid query (missing/oversized intent_id, out-of-range limit, or malformed ' +
      'cursor). Standard HttpExceptionFilter envelope.',
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
      'ScoutImport evidence for the calling coach (unknown or cross-tenant). The ' +
      'two are deliberately indistinguishable — no existence oracle.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded.',
    schema: rateLimitSchema(),
  })
  @Get('reconstruct/roster')
  // Feature gate: /api/scout/reconstruct/* is dark unless BOTH FEATURE_SCOUT_INGEST
  // and FEATURE_SCOUT_RECONSTRUCT are 'true', enforced by the global
  // featureFlagNotFoundMiddleware (R-DARK-1) BEFORE any guard runs. See
  // src/common/feature-flag/feature-flag-not-found.middleware.ts.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  getRoster(
    @Req() req: AuthedRequest,
    @Query() query: ScoutRosterQueryDto,
  ): Promise<ScoutRosterResult> {
    return this.roster.getRoster(req.user.id, query.intent_id, query.cursor, query.limit);
  }
}
