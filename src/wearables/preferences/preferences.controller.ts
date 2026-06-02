import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WearableMetricType, WearableProvider } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { PreferencesService } from './preferences.service';
import {
  DeletePreferenceParamSchema,
  PreferenceResponse,
  PreferenceResponseSchema,
  UpsertPreferenceSchema,
} from './dto/upsert-preference.dto';

/**
 * PR-HK-3a — `POST /v1/wearables/preferences` + `DELETE …/:metric`.
 *
 * Auth: JwtAuthGuard ONLY. The subject is always `req.user.id`, so a user can
 * only ever write/delete their OWN preference — there is no IDOR surface (#5).
 * Throttled per user to keep the write path bounded.
 */
@ApiTags('wearables-preferences')
@ApiBearerAuth()
@Controller('v1/wearables/preferences')
export class PreferencesController {
  constructor(private readonly svc: PreferencesService) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the read-precedence provider override for a metric',
    description:
      "Idempotent upsert of the authenticated user's (metric -> " +
      'preferred_provider) override. The subject is always the caller — there ' +
      'is no cross-user write surface.',
  })
  @ApiBody({
    description: 'The metric + preferred provider to pin.',
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
      },
    },
  })
  @ApiResponse({ status: 200, description: 'The persisted override (metric, provider, updated_at).' })
  @ApiResponse({
    status: 400,
    description:
      'WEARABLE_PREFERENCE_PAYLOAD_INVALID — unknown key, or invalid metric/provider enum.',
  })
  async upsert(
    @Request() req: AuthedRequest,
    @Body() rawBody: unknown,
  ): Promise<PreferenceResponse> {
    const body = parseOrThrow(UpsertPreferenceSchema, rawBody);
    const payload = await this.svc.upsert(req.user.id, body);
    return PreferenceResponseSchema.parse(payload);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Delete(':metric')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove the read-precedence override for a metric',
    description:
      'Idempotent: removing an already-absent override still returns 204. ' +
      'Subsequent reads fall back to the recency policy.',
  })
  @ApiParam({
    name: 'metric',
    enum: WearableMetricType,
    description: 'The metric whose override to remove.',
  })
  @ApiResponse({ status: 204, description: 'Override removed (or already absent — idempotent).' })
  @ApiResponse({
    status: 400,
    description: 'WEARABLE_PREFERENCE_PAYLOAD_INVALID — the :metric segment is not a valid enum.',
  })
  async remove(
    @Request() req: AuthedRequest,
    @Param() rawParam: unknown,
  ): Promise<void> {
    const { metric } = parseOrThrow(DeletePreferenceParamSchema, rawParam);
    await this.svc.remove(req.user.id, metric);
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
