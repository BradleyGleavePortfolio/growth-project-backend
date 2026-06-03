import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { WearableInsightsService } from '../insights/wearable-insights.service';
import { PreferencesService } from './preferences.service';
import {
  DeletePreferenceParamSchema,
  DeletePreferenceQuerySchema,
  PreferenceResponse,
  PreferenceResponseDto,
  PreferenceResponseSchema,
  UpsertPreferenceSchema,
} from './dto/upsert-preference.dto';

/**
 * PR-HK-3a / HK-6b — `POST /v1/wearables/preferences` + `DELETE …/:metric`.
 *
 * Auth: JwtAuthGuard + `@Roles('student','coach')`. The write subject defaults
 * to the caller (`req.user.id`). HK-6b adds an OPTIONAL coach-on-behalf-of
 * target — `target_user_id` in the POST body, or the `?target_user_id=…`
 * query param on DELETE. When that target is absent or equals the caller, the
 * caller writes their OWN row (the original PR-HK-3a behavior, no IDOR
 * surface). When it differs, the caller is authorized against the coach→client
 * assignment relation BEFORE any write (#5 IDOR): students are always 403
 * (`WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN`); coaches must own the target
 * client (delegated to `WearableInsightsService.assertCoachOwnsClient`, the
 * established `user.coach_id` precedent); owners bypass (platform admin,
 * consistent with the insights service). The service then writes the resolved
 * effective row and logs `actor_user_id` (caller) distinctly from
 * `subject_user_id` (row owner) for an auditable on-behalf trail (#34).
 *
 * Throttling: the global `@Throttle(DEFAULT)` bucket is keyed by the CALLER
 * (UserThrottlerGuard keys authenticated routes by `req.user.id`, not by the
 * effective subject — see throttler.config.ts). A coach repeatedly writing one
 * client's row therefore spends the coach's own per-minute budget and cannot
 * amplify per-client write rates beyond the global limit. Caller-keyed is the
 * correct key; no override is needed.
 */
@ApiTags('wearables-preferences')
@ApiBearerAuth()
@Controller('v1/wearables/preferences')
export class PreferencesController {
  constructor(
    private readonly svc: PreferencesService,
    private readonly insights: WearableInsightsService,
  ) {}

  @Roles('student', 'coach')
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the read-precedence provider override for a metric',
    description:
      "Idempotent upsert of a user's (metric -> preferred_provider) override. " +
      'By default the subject is the caller. A coach may set the override on ' +
      "behalf of an assigned client by passing that client's `target_user_id`; " +
      'the caller is authorized against the coach->client assignment relation ' +
      'first (students cannot write another user, coaches must own the client, ' +
      'owners bypass).',
  })
  @ApiBody({
    description:
      'The metric + preferred provider to pin. Optionally `target_user_id` to ' +
      'set the override on behalf of an assigned client (coach/owner only).',
    schema: {
      type: 'object',
      required: ['metric', 'preferred_provider'],
      additionalProperties: false,
      properties: {
        metric: { type: 'string', enum: Object.values(WearableMetricType) },
        preferred_provider: {
          type: 'string',
          enum: Object.values(WearableProvider),
        },
        target_user_id: {
          type: 'string',
          format: 'uuid',
          description:
            "Optional. The assigned client's user id for a coach-on-behalf " +
            'write. Absent or equal to the caller = self-write.',
        },
      },
    },
  })
  @ApiOkResponse({
    type: PreferenceResponseDto,
    description: 'The persisted override (metric, provider, updated_at).',
  })
  @ApiResponse({
    status: 400,
    description:
      'WEARABLE_PREFERENCE_PAYLOAD_INVALID — unknown key, invalid metric/provider enum, or malformed target_user_id.',
  })
  @ApiResponse({
    status: 403,
    description:
      'WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN — the caller may not write the ' +
      'requested target_user_id (student writing another user, or coach not ' +
      'assigned to that client).',
  })
  async upsert(
    @Request() req: AuthedRequest,
    @Body() rawBody: unknown,
  ): Promise<PreferenceResponse> {
    const body = parseOrThrow(UpsertPreferenceSchema, rawBody);
    const effectiveUserId = await this.resolveEffectiveUserId(
      req,
      body.target_user_id,
    );
    const payload = await this.svc.upsert(effectiveUserId, req.user.id, body);
    return PreferenceResponseSchema.parse(payload);
  }

  @Roles('student', 'coach')
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Delete(':metric')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove the read-precedence override for a metric',
    description:
      'Idempotent: removing an already-absent override still returns 204. ' +
      'Subsequent reads fall back to the recency policy. A coach may remove an ' +
      "assigned client's override via the optional `target_user_id` query " +
      'param (same authorization rule as the upsert).',
  })
  @ApiParam({
    name: 'metric',
    enum: WearableMetricType,
    description: 'The metric whose override to remove.',
  })
  @ApiQuery({
    name: 'target_user_id',
    required: false,
    type: 'string',
    format: 'uuid',
    description:
      "Optional. The assigned client's user id for a coach-on-behalf delete. " +
      'Absent or equal to the caller = self-delete.',
  })
  @ApiNoContentResponse({
    description: 'Override removed (or already absent — idempotent).',
  })
  @ApiResponse({
    status: 400,
    description:
      'WEARABLE_PREFERENCE_PAYLOAD_INVALID — the :metric segment is not a valid enum, or target_user_id is malformed.',
  })
  @ApiResponse({
    status: 403,
    description:
      'WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN — the caller may not delete the ' +
      'requested target_user_id (student deleting another user, or coach not ' +
      'assigned to that client).',
  })
  async remove(
    @Request() req: AuthedRequest,
    @Param() rawParam: unknown,
    @Query() rawQuery: unknown,
  ): Promise<void> {
    const { metric } = parseOrThrow(DeletePreferenceParamSchema, rawParam);
    const { target_user_id } = parseOrThrow(
      DeletePreferenceQuerySchema,
      rawQuery,
    );
    const effectiveUserId = await this.resolveEffectiveUserId(
      req,
      target_user_id,
    );
    await this.svc.remove(effectiveUserId, req.user.id, metric);
  }

  /**
   * HK-6b coach-on-behalf authorization (mirrors
   * `WearableInsightsService.assertCoachOwnsClient`). Resolves the row owner
   * the caller is allowed to write/delete:
   *  - `target_user_id` absent or equal to the caller -> the caller's own id
   *    (self-write; no cross-user surface).
   *  - present and different:
   *    - student -> 403 WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN (never).
   *    - owner -> allowed (platform admin bypass).
   *    - coach -> must own the target client (assertCoachOwnsClient throws
   *      403 if not assigned).
   *
   * The 403 body carries ONLY the requested `target_user_id` — never the
   * caller's id (#12 PII).
   */
  private async resolveEffectiveUserId(
    req: AuthedRequest,
    targetUserId: string | undefined,
  ): Promise<string> {
    const callerId = req.user.id;
    if (!targetUserId || targetUserId === callerId) {
      return callerId;
    }
    const role = req.user.role;
    if (role === 'student') {
      throw new ForbiddenException({
        error: 'WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN',
        target_user_id: targetUserId,
      });
    }
    // coach (must own the client) or owner (bypass). assertCoachOwnsClient
    // throws ForbiddenException('Client is not assigned to this coach') for an
    // unassigned coach; surface it as the locked cross-user error code so the
    // client sees a single, stable contract.
    try {
      await this.insights.assertCoachOwnsClient(callerId, targetUserId, role);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        // Authorization denied (unassigned coach) — remap to the stable
        // HK-6b 403 contract so the body is identical regardless of whether
        // the caller is a student writing to a peer or a coach without the
        // assignment.
        throw new ForbiddenException({
          error: 'WEARABLE_PREFERENCE_CROSS_USER_FORBIDDEN',
          target_user_id: targetUserId,
        });
      }
      // Anything else (DB connection failure, programmer error, etc.)
      // propagates as its real type so it surfaces as an honest 5xx, not a
      // misleading 403 (#36 silent-failure regression).
      throw err;
    }
    return targetUserId;
  }
}

/**
 * Zod-parse with a typed 400 carrying the field-level issues. Locked error
 * code WEARABLE_PREFERENCE_PAYLOAD_INVALID (auditor-gated).
 */
function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'WEARABLE_PREFERENCE_PAYLOAD_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
