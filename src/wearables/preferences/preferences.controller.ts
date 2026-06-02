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
import { ApiTags } from '@nestjs/swagger';
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
@Controller('v1/wearables/preferences')
export class PreferencesController {
  constructor(private readonly svc: PreferencesService) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Post()
  @HttpCode(200)
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
