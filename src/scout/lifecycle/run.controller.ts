import { Body, Controller, HttpCode, Post, Request } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  envelopeWithCode,
  errorEnvelopeSchema,
  rateLimitSchema,
} from '../../common/errors/importer-error-responses';
import {
  ScoutRunCancelDto,
  ScoutRunCancelResult,
  ScoutRunStartDto,
  ScoutRunStartResult,
} from './lifecycle.dto';
import { ScoutLifecycleService } from './lifecycle.service';

/**
 * S7-L2 — the two lifecycle routes of a server-owned import run (decision §6):
 * `POST /api/scout/runs/start` and `POST /api/scout/runs/cancel`.
 *
 * Same auth, tenancy and dark-route posture as ScoutController: the global JwtAuthGuard
 * verifies the extension bearer token, the coach is `req.user.id` (never a body field), and
 * FEATURE_SCOUT_INGEST off yields the uniform R-DARK-1 404 before any guard runs. There is no
 * new feature flag or activation (§8 L1); the routes are dark with the rest of /api/scout.
 */
@ApiTags('scout')
@ApiBearerAuth('bearer')
@ApiResponse({
  status: 400,
  description:
    'Malformed body (global ValidationPipe: whitelist + forbidNonWhitelisted). ' +
    'Standard HttpExceptionFilter envelope; `message` is a string ARRAY of ' +
    'per-field constraint violations when present.',
  schema: errorEnvelopeSchema(),
})
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
@ApiResponse({ status: 429, description: 'Rate limit exceeded.', schema: rateLimitSchema() })
@Controller('scout')
export class ScoutRunController {
  constructor(private readonly lifecycle: ScoutLifecycleService) {}

  @ApiOperation({
    summary: 'Start the server-owned run for a paired setup intent',
    description:
      'Creates the ONE run row for `import_intent_id` with a server-owned clock: ' +
      '`accepted_start_at` is now and `deadline_at` is now + SCOUT_RUN_DEADLINE_MS ' +
      '(default five minutes), both written once and never updated. Idempotent: a repeat Start ' +
      'for an open run returns the same body. The intent must be owned by the calling coach, ' +
      'paired and not superseded; a run already in a terminal state is not restarted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Run started (or already open).',
    type: ScoutRunStartResult,
  })
  @ApiResponse({
    status: 404,
    description:
      'Uniform not-found: FEATURE_SCOUT_INGEST off (R-DARK-1) OR the intent is unknown to the ' +
      'calling coach. Deliberately indistinguishable — no existence oracle.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description:
      'Lifecycle conflict. `code` is one of `intent_not_paired` (pairing incomplete), ' +
      '`intent_superseded` (a newer setup replaced this intent), `run_terminal` (the run already ' +
      'settled; an open run past its deadline is fenced `timed_out` first and answered the same ' +
      'way) or `legacy_run` (the intent names a client-minted legacy run).',
    schema: envelopeWithCode([
      'intent_not_paired',
      'intent_superseded',
      'run_terminal',
      'legacy_run',
    ]),
  })
  @Post('runs/start')
  @HttpCode(200)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  postStart(
    @Request() req: AuthedRequest,
    @Body() body: ScoutRunStartDto,
  ): Promise<ScoutRunStartResult> {
    return this.lifecycle.start(req.user.id, body.import_intent_id);
  }

  @ApiOperation({
    summary: 'Cancel an open server-owned run',
    description:
      'Fences the run (`fence_reason = cancelled`, epoch + 1) and writes the terminal `cancelled` ' +
      'in one transaction; every in-flight writer on the run is refused from then on. Idempotent: ' +
      'a repeat cancel of a cancelled run returns the same body.',
  })
  @ApiResponse({
    status: 200,
    description: 'Run cancelled (or already cancelled).',
    type: ScoutRunCancelResult,
  })
  @ApiResponse({
    status: 404,
    description:
      'Uniform not-found: FEATURE_SCOUT_INGEST off (R-DARK-1) OR no run exists for this intent ' +
      'and the calling coach.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description:
      'Lifecycle conflict. `code` is `run_terminal` (another terminal already holds; an open run ' +
      'past its deadline is fenced `timed_out` first) or `legacy_run` (the server does not own ' +
      'client-minted legacy runs and cannot cancel them).',
    schema: envelopeWithCode(['run_terminal', 'legacy_run']),
  })
  @Post('runs/cancel')
  @HttpCode(200)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  postCancel(
    @Request() req: AuthedRequest,
    @Body() body: ScoutRunCancelDto,
  ): Promise<ScoutRunCancelResult> {
    return this.lifecycle.cancel(req.user.id, body.intent_id);
  }
}
