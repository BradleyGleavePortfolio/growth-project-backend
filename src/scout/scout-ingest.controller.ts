import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ScoutIngestDto, ScoutIngestResult } from './scout-ingest.dto';
import { ScoutIngestService } from './scout-ingest.service';

@ApiTags('scout')
@ApiBearerAuth('bearer')
@Controller('scout')
export class ScoutIngestController {
  constructor(private readonly scout: ScoutIngestService) {}

  /**
   * POST /api/scout/ingest — receiver for the tgp-importer extension's
   * autonomous crawl envelope.
   *
   * Auth: the extension bearer token (issued by /auth/extension/*) is verified
   * by JwtAuthGuard, which attaches the coach's User as req.user. coach_id is
   * therefore taken from the token identity — there is deliberately NO
   * body-level account field. @Roles('coach') + RolesGuard restricts the
   * surface to coach (owner inherits via the RolesGuard hierarchy bypass).
   *
   * Feature-gated behind FEATURE_SCOUT_INGEST (off by default). Coach-level
   * rate limit via the global user-id throttler bucket plus an explicit cap so
   * a runaway crawler cannot flood ingest, sized generously enough not to block
   * a healthy batch cadence.
   *
   * Returns 202 Accepted with { received, deduped }.
   */
  @ApiOperation({
    summary: 'Ingest a batch of crawled entities',
    description:
      'Receives the extension crawl envelope { intent_id, entity_type, entities[] }. ' +
      'Idempotent on (coach_id, intent_id, sourceId). Returns 202 { received, deduped }. ' +
      'Returns 404 when FEATURE_SCOUT_INGEST is off.',
  })
  @ApiResponse({ status: 202, description: 'Batch accepted.', type: ScoutIngestResult })
  @ApiResponse({ status: 400, description: 'Validation failed or batch oversized.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @ApiResponse({ status: 403, description: 'Caller is not a coach.' })
  @ApiResponse({ status: 404, description: 'Feature disabled (FEATURE_SCOUT_INGEST off).' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Post('ingest')
  // Feature gate: FEATURE_SCOUT_INGEST is enforced by the global
  // featureFlagNotFoundMiddleware (R-DARK-1) BEFORE any guard runs. See
  // src/common/feature-flag/feature-flag-not-found.middleware.ts.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @HttpCode(202)
  ingest(@Req() req: AuthedRequest, @Body() dto: ScoutIngestDto): Promise<ScoutIngestResult> {
    return this.scout.ingest(req.user.id, dto);
  }
}
