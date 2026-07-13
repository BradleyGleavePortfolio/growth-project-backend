import { Body, Controller, HttpCode, Post, Request } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { Roles } from '../common/decorators/roles.decorator';
import { ScoutCompleteDto, ScoutCompleteResult, ScoutProgressDto } from './scout.dto';
import { ScoutService } from './scout.service';
import { errorEnvelopeSchema, rateLimitSchema } from '../common/errors/importer-error-responses';

/**
 * IMPORTER-E — cross-device progress + completion for the tgp-importer Chrome
 * extension (DESIGN.md v0.3 §10 + §2 steps 10-11).
 *
 * Auth: the global JwtAuthGuard (APP_GUARD) verifies the extension bearer token
 * — the same Supabase access token minted by /auth/extension/* (IMPORTER-A
 * #496). The coach identity is `req.user.id`; the payload is routed by TOKEN
 * IDENTITY, never a body field (DESIGN §3, R80).
 *
 * Feature gate (R-DARK-1): FEATURE_SCOUT_INGEST is enforced by the global
 * featureFlagNotFoundMiddleware — while the flag is off (the default) EVERY
 * /api/scout request returns a uniform 404 BEFORE any guard runs, so the
 * surface is indistinguishable from an unmounted route. There is no
 * controller-level feature guard: see
 * src/common/feature-flag/feature-flag-not-found.middleware.ts.
 */
@ApiTags('scout')
@ApiBearerAuth('bearer')
@ApiResponse({
  status: 401,
  description: 'Missing or invalid bearer token.',
  schema: errorEnvelopeSchema(),
})
@ApiResponse({
  status: 403,
  description: 'Caller is not a coach or owner.',
  schema: errorEnvelopeSchema(),
})
@ApiResponse({
  status: 404,
  description: 'Feature disabled (FEATURE_SCOUT_INGEST off — uniform R-DARK-1 404).',
  schema: errorEnvelopeSchema(),
})
@ApiResponse({ status: 429, description: 'Rate limit exceeded.', schema: rateLimitSchema() })
@Controller('scout')
export class ScoutController {
  constructor(private readonly scout: ScoutService) {}

  @ApiOperation({
    summary: 'Mirror an extension crawl progress snapshot to the mobile app',
    description:
      'Accepts the status_snapshot the extension broadcasts on every batch ' +
      'commit and records the latest per (coach, intent). Cheap by design: ' +
      'the snapshot is coalesced in-process and flushed to storage on a timer.',
  })
  @ApiResponse({ status: 204, description: 'Snapshot accepted.' })
  @Post('progress')
  @HttpCode(204)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  postProgress(@Request() req: AuthedRequest, @Body() body: ScoutProgressDto): void {
    this.scout.recordProgress(req.user.id, body);
  }

  @ApiOperation({
    summary: 'Settle an extension import to its terminal state',
    description:
      'Idempotent per (coach, intent): the first call atomically flips the ' +
      'parent ScoutImport row to its terminal state AND appends the completion ' +
      'ledger row in a single transaction (R-STATE-1), then pushes an ' +
      'import.complete notification to the mobile app. Retries after a network ' +
      'flake are acknowledged no-ops — the ledger unique constraint rolls the ' +
      'transaction back, so the state is never re-flipped and the coach is ' +
      'never double-notified.',
  })
  @ApiResponse({ status: 200, description: 'Completion acknowledged.', type: ScoutCompleteResult })
  @Post('ingest/complete')
  @HttpCode(200)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async postComplete(
    @Request() req: AuthedRequest,
    @Body() body: ScoutCompleteDto,
  ): Promise<{ acknowledged: true; intent_id: string }> {
    return this.scout.complete(req.user.id, body);
  }
}
