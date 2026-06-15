import { Controller, Get, Request } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import type { AppRole } from '../common/decorators/roles.decorator';
import {
  FeatureFlagsResponseSchema,
  type FeatureFlagsResponseDto,
} from './feature-flags.dto';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagsTelemetry } from './feature-flags.telemetry';

/**
 * D5 = B+γ — server-evaluated feature flags for the mobile client.
 *
 * GET /me/feature-flags returns a map of flag-key → boolean evaluated
 * SERVER-SIDE for the authenticated caller, plus the evaluation timestamp.
 * Unblocks the mobile `useFeatureFlags()` hook (PR #251 R81 rebuild, F2): the
 * app reads these values at boot + on foreground instead of carrying its own
 * Expo-env flag copies that drift from the server gate.
 *
 * Auth: JwtAuthGuard is registered globally as APP_GUARD (Phase 10), so no
 * explicit @UseGuards is needed — the verified user is on `req.user`. No
 * @Roles gate on the route itself: every authenticated user may read THEIR
 * flag map; role-sensitive flags (coach_community_wearable_prompts) are
 * resolved to OFF for non-coach callers inside FeatureFlagsService.
 *
 * Throttle: per-user 60/min — frequent foreground polling is expected from
 * mobile, but a single client should not hammer the endpoint. UserThrottlerGuard
 * keys the bucket by user, so this is a per-user budget.
 *
 * Pure read, O(1): a fixed set of process.env reads + one allowlist membership
 * check. No DB access, no N+1. Flag reads are not audited (no state mutation).
 */
@ApiTags('users')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@Controller('me/feature-flags')
export class FeatureFlagsController {
  constructor(
    private readonly featureFlags: FeatureFlagsService,
    private readonly telemetry: FeatureFlagsTelemetry,
  ) {}

  @ApiOperation({
    summary: 'Get server-evaluated feature flags for the authenticated user',
    description:
      'Returns { flags: Record<string, boolean>, evaluated_at: ISO8601 }. ' +
      'Flags are evaluated server-side from environment gates for the ' +
      "caller's userId and role. The mobile client reads this at boot and on " +
      'app foreground (TanStack Query) as the source of truth.',
  })
  @ApiResponse({
    status: 200,
    description: 'The evaluated flag map plus the evaluation timestamp.',
  })
  @Get()
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  getFeatureFlags(@Request() req: AuthedRequest): FeatureFlagsResponseDto {
    const role = req.user.role as AppRole;
    const flags = this.featureFlags.evaluate({
      userId: req.user.id,
      role,
    });

    this.telemetry.evaluated(req.user.id, {
      role,
      flag_count: Object.keys(flags).length,
    });

    return FeatureFlagsResponseSchema.parse({
      flags,
      evaluated_at: new Date().toISOString(),
    });
  }
}
