import { Body, Controller, HttpCode, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachGuard } from '../auth/coach.guard';
import { THROTTLER_NAMES } from '../throttler/throttler.config';
import { ExtensionPairService } from './extension-pair.service';
import {
  PAIR_INIT_400_CODES,
  PAIR_REDEEM_400_CODES,
  PAIR_REDEEM_410_CODES,
  PairInitDto,
  PairInitResult,
  PairRedeemDto,
  PairRedeemResult,
  PairStatusDto,
  PairStatusResult,
} from './extension-pair.dto';
import {
  envelopeWithCode,
  errorEnvelopeSchema,
  rateLimitSchema,
} from '../common/errors/importer-error-responses';

// Per-IP redeem cap (brute-force brake over the 10^6 code space). Default 10/
// min/IP, env-tunable + clamped.
function redeemPerMin(): number {
  const raw = process.env.PAIR_REDEEM_PER_MIN;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(n, 1), 120);
}
const PAIR_REDEEM_PER_MIN = redeemPerMin();

// Mounts under the global `/api` prefix → /api/extension/pair/*.
//
// Feature gate: FEATURE_EXTENSION_PAIRING is enforced by the global
// featureFlagNotFoundMiddleware (R-DARK-1) BEFORE any guard runs. Flag off ⇒
// uniform 404 at the edge, indistinguishable from an unmounted route. See
// src/common/feature-flag/feature-flag-not-found.middleware.ts and
// docs/DESIGN.md v0.3 §2/§4.
@ApiTags('extension-pair')
@Controller('extension/pair')
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
  @ApiResponse({ status: 201, description: 'Pairing code minted.', type: PairInitResult })
  @ApiResponse({
    status: 400,
    description:
      'Rejected init. Standard HttpExceptionFilter envelope. Two sources: the ' +
      'domain path sets `code: "code_mint_failed"` when the mint-retry budget is ' +
      'exhausted; a malformed body (chosen_platform failing the slug/length rules) ' +
      'is rejected by the global ValidationPipe with NO `code` and `message` as a ' +
      'string ARRAY of constraint violations. `code` is therefore optional here and ' +
      'pinned to `code_mint_failed` only when present.',
    schema: envelopeWithCode(PAIR_INIT_400_CODES, { required: false }),
  })
  @ApiResponse({
    status: 403,
    description: 'Caller is not a coach.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 404,
    description: 'Pairing feature disabled (uniform R-DARK-1 404).',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded. This route carries no explicit @Throttle, so it is ' +
      'governed by the global authenticated default (UserThrottlerGuard, keyed by ' +
      'user id). Documented for parity with the other throttled importer routes.',
    schema: rateLimitSchema(),
  })
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
  @ApiResponse({ status: 200, description: 'Pairing code status.', type: PairStatusResult })
  @ApiResponse({
    status: 403,
    description: 'Caller is not a coach.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 404,
    description: 'Pairing feature disabled (uniform R-DARK-1 404).',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded. Like init, status carries no explicit @Throttle and is ' +
      'governed by the global authenticated default (UserThrottlerGuard, keyed by ' +
      'user id). Documented for parity with the other throttled importer routes.',
    schema: rateLimitSchema(),
  })
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
  @ApiResponse({ status: 200, description: 'Token pair issued.', type: PairRedeemResult })
  @ApiResponse({
    status: 400,
    description:
      'Rejected pairing code. Standard HttpExceptionFilter envelope. Two sources: ' +
      'the domain path sets `code: "invalid"` with a string `message`; a malformed ' +
      'body (not 6 digits) is rejected by the global ValidationPipe with NO `code` ' +
      'and `message` as a string ARRAY of constraint violations. `code` is therefore ' +
      'optional here and pinned to `invalid` only when present.',
    schema: envelopeWithCode(PAIR_REDEEM_400_CODES, { required: false }),
  })
  @ApiResponse({
    status: 410,
    description:
      'Code expired, already used, or locked. Standard envelope with a required ' +
      '`code` from the redeem 410 enum.',
    schema: envelopeWithCode(PAIR_REDEEM_410_CODES),
  })
  @ApiResponse({
    status: 404,
    description: 'Pairing feature disabled (uniform R-DARK-1 404).',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (per-IP redeem throttle).',
    schema: rateLimitSchema(),
  })
  @Public()
  @Post('redeem')
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: PAIR_REDEEM_PER_MIN } })
  @HttpCode(HttpStatus.OK)
  async redeem(@Body() body: PairRedeemDto): Promise<PairRedeemResult> {
    return this.pair.redeem(body.code);
  }
}
