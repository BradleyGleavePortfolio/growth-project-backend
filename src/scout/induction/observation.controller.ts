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
import { checkObservationBodySize } from './parse';
import {
  observationBodyRejected,
  parseObservationEnvelope,
  ScoutRunDeclarationDto,
  ScoutRunDeclarationResult,
  ScoutRunObservationDto,
  ScoutRunObservationResult,
} from './observation.dto';
import { ObservationService } from './observation.service';

/** The express request with the raw body `main.ts` captures (`rawBody: true`). */
export type ObservationRequest = AuthedRequest & { rawBody?: Buffer };

/**
 * S10-B — the two induction routes of a server-owned run (docs/decisions/2026-09-26-s10-induction.md
 * D-S10-4 "Routes"): `POST /api/scout/runs/declaration` and `POST /api/scout/runs/observation`.
 *
 * Same posture as ScoutRunController (`run.controller.ts`): the global JwtAuthGuard verifies the
 * extension bearer token, the coach is `req.user.id` (never a body field), `@Roles('coach',
 * 'owner')`, 30/min, and FEATURE_SCOUT_INGEST off yields the uniform R-DARK-1 404 before any guard
 * runs (the `/api/scout` prefix gate). Both write under `FOR NO KEY UPDATE` on the run row, open
 * `mode='server'` runs only. Registration in ScoutModule is S10-C's (D-S10-7); until then the
 * routes are not mounted.
 */
@ApiTags('scout')
@ApiBearerAuth('bearer')
@ApiResponse({
  status: 400,
  description:
    'Malformed body (global ValidationPipe: whitelist + forbidNonWhitelisted, or the S10 ' +
    'envelope/evidence grammar, or a body over 32 KiB). Standard HttpExceptionFilter envelope; no row is written.',
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
@ApiResponse({
  status: 404,
  description:
    'Uniform not-found: FEATURE_SCOUT_INGEST off (R-DARK-1) OR the intent is unknown to the ' +
    'calling coach. Deliberately indistinguishable — no existence oracle.',
  schema: errorEnvelopeSchema(),
})
@ApiResponse({ status: 429, description: 'Rate limit exceeded.', schema: rateLimitSchema() })
@Controller('scout')
export class ObservationController {
  constructor(private readonly observations: ObservationService) {}

  @ApiOperation({
    summary: 'Declare the run’s authorized platforms and expected account scopes',
    description:
      'Before the run’s first staged row: records the immutable authorized platform set and, per ' +
      'platform, the expected account scope set (sha256 digests), in one transaction under the run ' +
      'lock, and returns the run’s ONE server-generated 32-byte challenge. An exact replay (order ' +
      'ignored) returns the original challenge and writes nothing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Declared (or exact replay).',
    type: ScoutRunDeclarationResult,
  })
  @ApiResponse({
    status: 409,
    description:
      'Refused. `code` is `declaration_conflict` (a different set is already declared), ' +
      '`declaration_after_ingest` (first declaration after a staged row or claim), or a run ' +
      'lifecycle code: `run_not_started`, `run_fenced`, `run_terminal`, `legacy_run`.',
    schema: envelopeWithCode([
      'declaration_conflict',
      'declaration_after_ingest',
      'run_not_started',
      'run_fenced',
      'run_terminal',
      'legacy_run',
    ]),
  })
  @Post('runs/declaration')
  @HttpCode(200)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  postDeclaration(
    @Request() req: AuthedRequest,
    @Body() body: ScoutRunDeclarationDto,
  ): Promise<ScoutRunDeclarationResult> {
    return this.observations.declare(req.user.id, body.intent_id, body.platforms);
  }

  @ApiOperation({
    summary: 'Upload source-signed observation evidence for a declared run',
    description:
      'Only after a declaration and before the claim. Stores one validated ObservationEvidenceV1 ' +
      'per (platform, scope, family), bound to the epoch read under the run lock. The server ' +
      'records the evidence; it proves nothing until the settle-time evaluator verifies it. An ' +
      'identical replay writes nothing. The body is at most 32 KiB.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stored (or identical replay).',
    type: ScoutRunObservationResult,
  })
  @ApiResponse({
    status: 409,
    description:
      'Refused (nothing stored). `code` is `declaration_missing`, `observation_conflict` (a ' +
      'different evidence is stored for the unit), `observation_after_claim`, ' +
      '`observation_not_declared` (undeclared platform/scope, no induction manifest, or a family ' +
      'outside it), or a run lifecycle code: `run_not_started`, `run_fenced`, `run_terminal`, `legacy_run`.',
    schema: envelopeWithCode([
      'declaration_missing',
      'observation_conflict',
      'observation_after_claim',
      'observation_not_declared',
      'run_not_started',
      'run_fenced',
      'run_terminal',
      'legacy_run',
    ]),
  })
  @Post('runs/observation')
  @HttpCode(200)
  @Roles('coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  postObservation(
    @Request() req: ObservationRequest,
    @Body() body: ScoutRunObservationDto,
  ): Promise<ScoutRunObservationResult> {
    // R21 "body > 32 KiB": the exact received bytes, never a re-serialisation. A request without
    // the captured raw body is refused (fail closed), never measured some other way.
    const size = checkObservationBodySize(Buffer.isBuffer(req.rawBody) ? req.rawBody.length : -1);
    if (!size.ok) return Promise.reject(observationBodyRejected(size.reason));
    const envelope = parseObservationEnvelope(body);
    if (!envelope.ok) return Promise.reject(observationBodyRejected(envelope.reason));
    return this.observations.observe(req.user.id, envelope.intent_id, envelope.observations);
  }
}
