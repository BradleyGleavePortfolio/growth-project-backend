import { Body, Controller, HttpCode, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachGuard } from '../auth/coach.guard';
import { THROTTLER_NAMES } from '../throttler/throttler.config';
import { ExtensionPairingFeatureFlagGuard } from './extension-pair-feature-flag.guard';
import { ExtensionPairService } from './extension-pair.service';
import { PairInitDto, PairRedeemDto, PairStatusDto } from './extension-pair.dto';
import type { PairInitResult, PairRedeemResult, PairStatusResult } from './extension-pair.dto';

// Per-IP redeem cap (brute-force brake over the 10^6 code space). Default 10/
// min/IP, env-tunable + clamped.
function redeemPerMin(): number {
  const raw = process.env.PAIR_REDEEM_PER_MIN;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(n, 1), 120);
}
const PAIR_REDEEM_PER_MIN = redeemPerMin();

// Mounts under the global `/api` prefix → /api/extension/pair/*. Every route is
// gated by ExtensionPairingFeatureFlagGuard: off (default) ⇒ 404, hiding the
// surface entirely. See docs/DESIGN.md v0.3 §2/§4.
//
// TODO(#503): remove ExtensionPairingFeatureFlagGuard after #503 (R-DARK-1
// middleware) merges — the middleware then owns the flag-off 404 gate.
@ApiTags('extension-pair')
@Controller('extension/pair')
@UseGuards(ExtensionPairingFeatureFlagGuard)
export class ExtensionPairController {
  constructor(private readonly pair: ExtensionPairService) {}

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Mint a pairing code (mobile app → extension bridge)',
    description:
      'Mobile-authenticated coach mints a 6-digit code bound to their account ' +
      '+ chosen source platform. Returns { pairing_code, expires_at }. ' +
      'Returns 404 when FEATURE_EXTENSION_PAIRING is off.',
  })
  @ApiResponse({ status: 201, description: 'Pairing code minted.' })
  @ApiResponse({ status: 403, description: 'Caller is not a coach.' })
  @ApiResponse({ status: 404, description: 'Pairing feature disabled.' })
  @Post('init')
  @Roles('coach', 'owner')
  @UseGuards(CoachGuard)
  async init(@Request() req: AuthedRequest, @Body() body: PairInitDto): Promise<PairInitResult> {
    return this.pair.init(req.user.id, body.chosen_platform);
  }

  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Poll a pairing code status',
    description:
      'Mobile-authenticated coach polls their OWN code. The code travels in the ' +
      'POST body (never a query string, which would leak into logs/history/APM). ' +
      'Returns { status: pending | paired | expired }. A code the caller did not ' +
      "mint reads as `expired` (never confirms another coach's code). " +
      'Returns 404 when FEATURE_EXTENSION_PAIRING is off.',
  })
  @ApiResponse({ status: 200, description: 'Pairing code status.' })
  @ApiResponse({ status: 403, description: 'Caller is not a coach.' })
  @ApiResponse({ status: 404, description: 'Pairing feature disabled.' })
  @Post('status')
  @Roles('coach', 'owner')
  @UseGuards(CoachGuard)
  @HttpCode(HttpStatus.OK)
  async status(
    @Request() req: AuthedRequest,
    @Body() body: PairStatusDto,
  ): Promise<PairStatusResult> {
    return this.pair.status(req.user.id, body.code);
  }

  @ApiOperation({
    summary: 'Redeem a pairing code (extension bootstrap)',
    description:
      'UNAUTHENTICATED. The extension exchanges a 6-digit code for a ' +
      'coach-bound Supabase token pair + chosen_platform. Single-use: a ' +
      'second redeem of the same code returns 410 already_used. Expired → 410 ' +
      'expired; unknown/malformed → 400 invalid. After too many failed attempts ' +
      'a code is hard-locked → 410 locked. Rate-limited per IP. ' +
      'Returns 404 when FEATURE_EXTENSION_PAIRING is off.',
  })
  @ApiResponse({ status: 200, description: 'Token pair issued.' })
  @ApiResponse({ status: 400, description: 'Invalid pairing code.' })
  @ApiResponse({ status: 410, description: 'Code expired, already used, or locked.' })
  @ApiResponse({ status: 404, description: 'Pairing feature disabled.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  @Public()
  @Post('redeem')
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: PAIR_REDEEM_PER_MIN } })
  @HttpCode(HttpStatus.OK)
  async redeem(@Body() body: PairRedeemDto): Promise<PairRedeemResult> {
    return this.pair.redeem(body.code);
  }
}
