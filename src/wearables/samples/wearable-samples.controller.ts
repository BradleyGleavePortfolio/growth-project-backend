import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WearableMetricBucket, WearableMetricType } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { WearableSamplesService } from './wearable-samples.service';
import { GetSamplesQuerySchema } from './dto/get-samples.query';
import {
  SamplesResponse,
  SamplesResponseSchema,
} from './dto/sample-response.schema';
import { SamplesResponseDto } from './dto/sample-response.dto';

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
@ApiBearerAuth()
@Controller('v1/wearables/samples')
export class WearableSamplesController {
  constructor(private readonly svc: WearableSamplesService) {}

  @Roles('student', 'coach', 'owner')
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 60 } })
  @Get()
  @ApiOperation({
    summary: 'Read normalized wearable samples for a bucket',
    description:
      'Returns the H&F / S&R samples series + per-provider freshness for the ' +
      'authenticated user (or, when `clientId` is supplied, a coach-owned ' +
      'client). Window is capped at 90 days.',
  })
  @ApiQuery({
    name: 'bucket',
    enum: WearableMetricBucket,
    required: true,
    description: 'UX bucket to read (HEALTH_FITNESS | SLEEP_RECOVERY).',
  })
  @ApiQuery({
    name: 'metric',
    enum: WearableMetricType,
    required: false,
    description:
      'Single metric to read; must belong to `bucket`. Omit to read every ' +
      'metric in the bucket.',
  })
  @ApiQuery({
    name: 'from',
    type: String,
    required: true,
    description: 'ISO-8601 window start (inclusive).',
  })
  @ApiQuery({
    name: 'to',
    type: String,
    required: true,
    description: 'ISO-8601 window end (exclusive). `to - from` must be <= 90d.',
  })
  @ApiQuery({
    name: 'clientId',
    type: String,
    required: false,
    description:
      'UUID of a coached client to read on their behalf (coach/owner only).',
  })
  @ApiQuery({
    name: 'granularity',
    enum: ['raw', 'hour', 'day'],
    required: false,
    description: 'Aggregation granularity. Defaults to `raw` (no buckets).',
  })
  @ApiQuery({
    name: 'preferredOnly',
    enum: ['true', 'false'],
    required: false,
    description:
      'When true (default) returns the read-precedence provider only; when ' +
      'false returns every provider (compare-sources mode).',
  })
  @ApiOkResponse({
    type: SamplesResponseDto,
    description: 'Samples + freshness envelope (version 1).',
  })
  @ApiResponse({
    status: 400,
    description:
      'WEARABLE_SAMPLES_QUERY_INVALID — malformed query (bad enum, window > 90d, ' +
      'from > to, unknown key, or metric not in bucket).',
  })
  @ApiResponse({
    status: 403,
    description:
      'WEARABLE_SAMPLES_FORBIDDEN — coach is not assigned to the requested client.',
  })
  @ApiResponse({
    status: 503,
    description:
      'WEARABLE_SAMPLES_DEGRADED — the wearable data store did not respond in time.',
  })
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
