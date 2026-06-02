import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { WearableSamplesService } from './wearable-samples.service';
import { GetSamplesQuerySchema } from './dto/get-samples.query';
import {
  SamplesResponse,
  SamplesResponseSchema,
} from './dto/sample-response.schema';

/**
 * PR-HK-3a — `GET /v1/wearables/samples`.
 *
 * Auth posture:
 *  - JwtAuthGuard always — any authenticated user reads their OWN data.
 *  - When `clientId` is present the request is a COACH read; the service
 *    re-checks coach-owns-client via assertCoachOwnsClient as its first action
 *    (#5 IDOR) and returns 403 on a foreign client. We deliberately do NOT
 *    stack CoachGuard at the decorator level here: a plain user supplying a
 *    `clientId` they do not own must get a 403 from the ownership check, and a
 *    user reading their OWN data (no clientId) must not be blocked. The
 *    ownership assertion is the single authoritative gate (no fail-open).
 *
 * Throttle: 60 requests / 60s per user (LOCK).
 */
@ApiTags('wearables-samples')
@Controller('v1/wearables/samples')
export class WearableSamplesController {
  constructor(private readonly svc: WearableSamplesService) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Get()
  async getSamples(
    @Request() req: AuthedRequest,
    @Query() rawQuery: unknown,
  ): Promise<SamplesResponse> {
    const query = parseOrThrow(GetSamplesQuerySchema, rawQuery);
    const payload = await this.svc.getSeries(req.user.id, req.user.role, query);
    // Validate the wire response against the LOCKED contract before it leaves
    // the process — a contract-violating shape can never reach the client.
    return SamplesResponseSchema.parse(payload);
  }
}

/**
 * Zod-parse a query object, converting a ZodError into a 400 with the
 * field-level issues. The error code is the locked
 * WEARABLE_SAMPLES_QUERY_INVALID contract value (auditor-gated).
 */
function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'WEARABLE_SAMPLES_QUERY_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
