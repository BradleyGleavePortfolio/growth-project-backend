import { Body, Controller, HttpCode, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { Roles } from '../common/decorators/roles.decorator';
import { ScoutFeatureFlagGuard } from './scout-feature-flag.guard';
import { ScoutCompleteDto, ScoutProgressDto } from './scout.dto';
import { ScoutService } from './scout.service';

/**
 * IMPORTER-E — cross-device progress + completion for the tgp-importer Chrome
 * extension (DESIGN.md v0.3 §10 + §2 steps 10-11).
 *
 * Auth: the global JwtAuthGuard (APP_GUARD) verifies the extension bearer token
 * — the same Supabase access token minted by /auth/extension/* (IMPORTER-A
 * #496). The coach identity is `req.user.id`; the payload is routed by TOKEN
 * IDENTITY, never a body field (DESIGN §3, R80).
 *
 * Feature gate: ScoutFeatureFlagGuard returns 404 on every route while
 * FEATURE_SCOUT_INGEST is off (the default) — the surface ships dark behind the
 * same flag as Lane 3's ingest endpoint (IMPORTER-B).
 */
@ApiTags('scout')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@ApiResponse({ status: 404, description: 'Feature disabled.' })
@UseGuards(ScoutFeatureFlagGuard)
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
      'Idempotent per (coach, intent): the first call settles the import and ' +
      'pushes an import.complete notification to the mobile app; retries after ' +
      'a network flake are acknowledged no-ops so the coach is never ' +
      'double-notified.',
  })
  @ApiResponse({ status: 200, description: 'Completion acknowledged.' })
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
