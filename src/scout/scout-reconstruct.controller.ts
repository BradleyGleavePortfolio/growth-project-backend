import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { errorEnvelopeSchema, rateLimitSchema } from '../common/errors/importer-error-responses';
import { ScoutReconstructDto, ScoutReconstructResult } from './scout-reconstruct.dto';
import { ScoutReconstructService } from './scout-reconstruct.service';

@ApiTags('scout')
@ApiBearerAuth('bearer')
@Controller('scout')
export class ScoutReconstructController {
  constructor(private readonly reconstruct: ScoutReconstructService) {}

  /**
   * POST /api/scout/reconstruct — IMPORTER-F. Reconstruct one settled crawl
   * intent's staged `clients` into invite-pending, non-login, tenant-owned
   * roster Person records (D2, Op 59).
   *
   * Auth mirrors ingest: JwtAuthGuard attaches the coach identity and coach_id
   * is taken from the token (never the body), so a coach can only reconstruct
   * their own staged rows. @Roles('coach') + RolesGuard restrict the surface.
   *
   * Post-settle only: an intent whose ScoutImport has not reached a terminal
   * status is rejected 409 (reconstructing a live crawl would race arriving
   * ingest). Idempotent: a replay mints no new rows and returns identical
   * ledger-derived counts. Feature-gated behind FEATURE_SCOUT_RECONSTRUCT (off
   * by default → uniform R-DARK-1 404 before any guard runs).
   *
   * Returns 200 with { intent_id, staged, reconstructed, skipped, failed }
   * where staged === reconstructed + skipped + failed.
   */
  @ApiOperation({
    summary: 'Reconstruct a settled intent’s staged entities into canonical records',
    description:
      'Reconstructs the staged entities of one settled crawl intent for the given `entity_type` ' +
      'family (defaults to `clients`, which mints invite-pending roster Person records; ' +
      '`workouts`/`client_history` mint canonical reconstructed-entity records). Idempotent on ' +
      '(coach_id, intent_id, entity_type, source_id). Returns 200 { staged, reconstructed, ' +
      'skipped, failed }. Returns 400 for an unsupported family, 409 when the intent has not ' +
      'settled, and 404 when FEATURE_SCOUT_RECONSTRUCT is off.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reconstruction pass complete.',
    type: ScoutReconstructResult,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed. Standard HttpExceptionFilter envelope.',
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
    description: 'Feature disabled (FEATURE_SCOUT_RECONSTRUCT off — uniform R-DARK-1 404).',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description: 'Intent has not settled; reconstruction is post-settle only.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded.',
    schema: rateLimitSchema(),
  })
  @Post('reconstruct')
  // Feature gate: FEATURE_SCOUT_RECONSTRUCT is enforced by the global
  // featureFlagNotFoundMiddleware (R-DARK-1) BEFORE any guard runs. See
  // src/common/feature-flag/feature-flag-not-found.middleware.ts.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('coach')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(200)
  run(
    @Req() req: AuthedRequest,
    @Body() dto: ScoutReconstructDto,
  ): Promise<ScoutReconstructResult> {
    return this.reconstruct.reconstruct(req.user.id, dto.intent_id, dto.entity_type);
  }
}
