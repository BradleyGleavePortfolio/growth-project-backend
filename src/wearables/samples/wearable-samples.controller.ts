import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Request,
  ServiceUnavailableException,
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
import { PrismaService } from '../../prisma.service';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { WearableSamplesService } from './wearable-samples.service';
import { GetSamplesQuerySchema } from './dto/get-samples.query';
import {
  IngestSamplesBodySchema,
  type IngestSamplesBody,
} from './dto/ingest-samples.dto';
import { IngestionService } from '../ingestion/ingestion.service';
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
  constructor(
    private readonly svc: WearableSamplesService,
    private readonly ingestion: IngestionService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Feature-flag gate for the on-device ingest route.
   *
   * `FEATURE_WEARABLES_INGEST_POST` defaults to OFF in production until the
   * mobile smoke test passes (planner rollout note). When the flag is not the
   * literal string 'true', the route is a kill switch: it returns a TYPED 503
   * disabled error (a real, documented degradation contract) rather than a
   * 404, a spinner state, or an uncaught throw. The client reads
   * `code === 'wearables_ingest_disabled'` and shows a real "not available
   * yet" surface (non-spinner empty state, mobile audit requirement).
   */
  private assertIngestEnabled(): void {
    if (process.env.FEATURE_WEARABLES_INGEST_POST?.toLowerCase() !== 'true') {
      throw new ServiceUnavailableException({
        code: 'wearables_ingest_disabled',
        message: 'On-device sample ingest is currently disabled.',
      });
    }
  }

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

  /**
   * P0-0A — `POST /v1/wearables/samples/ingest`.
   *
   * The on-device ingest lane. A mobile client posts a batch of normalized
   * samples; we validate it (Zod, #8), stamp the subject `userId` from the
   * authenticated JWT, and forward to the shared IngestionService.
   *
   * Auth posture: `@Roles('student')` + JwtAuthGuard. The subject user is ALWAYS
   * `req.user.id` — the body cannot name a different subject. Any `userId` in
   * the payload is impossible by construction: the schema is `.strict()` so a
   * `userId` key is rejected outright (unknown field), and even if it slipped
   * through, we overwrite it with the JWT id here. This closes the cross-user
   * write IDOR (#5) at the controller seam — a coach cannot post for a foreign
   * client through this route.
   *
   * Throttle: 20 requests / 60s per user (on-device batches are infrequent).
   *
   * Kill switch: gated by FEATURE_WEARABLES_INGEST_POST. When off, returns a
   * typed 503 (`wearables_ingest_disabled`), not a 404 or a silent stub.
   */
  @Roles('student')
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 60_000, limit: 20 } })
  @Post('ingest')
  @ApiOperation({ summary: 'Ingest normalized on-device wearable samples' })
  @ApiResponse({ status: 201, description: 'Accepted normalized sample batch.' })
  @ApiResponse({
    status: 400,
    description:
      'WEARABLE_SAMPLES_QUERY_INVALID — malformed batch (empty, over the 2000 ' +
      'cap, bad enum, bad date order, or unknown field).',
  })
  @ApiResponse({
    status: 503,
    description:
      'wearables_ingest_disabled — FEATURE_WEARABLES_INGEST_POST is off on ' +
      'this environment (kill switch).',
  })
  async ingestSamples(
    @Request() req: AuthedRequest,
    @Body() rawBody: unknown,
  ): Promise<{ inserted: number; skipped: number }> {
    this.assertIngestEnabled();
    const parsed = parseOrThrow(IngestSamplesBodySchema, rawBody);

    // CONNECTION OWNERSHIP / PROVIDER GATE (request-specific authz).
    //
    // The body carries a client-controlled `connectionId` per sample. Before
    // any write side effect we MUST prove every distinct connection (a) belongs
    // to the authenticated user, (b) matches the sample's declared provider,
    // and (c) is not in a disconnected lifecycle state. Without this a student
    // could post samples against another user's connection (cross-user write
    // IDOR, #5) or smuggle a provider that does not match the link.
    //
    // This lives at the controller seam — NOT in IngestionService — because
    // that service is shared with the trusted cloud/webhook lanes, which run
    // under service_role with no end-user identity to scope by.
    await this.assertConnectionsOwnedByUser(parsed, req.user.id);

    // Stamp the subject from the JWT — the body NEVER names the subject user
    // (#5 IDOR). Normalize the optional pointers to explicit null so the
    // NormalizedSample shape the IngestionService consumes is exact.
    const samples = parsed.map((sample) => ({
      ...sample,
      userId: req.user.id,
      sourceTz: sample.sourceTz ?? null,
      sourceRecordId: sample.sourceRecordId ?? null,
      rawRef: sample.rawRef ?? null,
    }));
    return this.ingestion.ingest(samples);
  }

  /**
   * Verify every submitted connection belongs to `userId`, matches the
   * sample's provider, and is live. Throws a TYPED 403 on the FIRST failure.
   *
   * Enumeration-safe: the thrown error never names the offending UUID, and a
   * connection that does not exist is treated exactly like a foreign one (a
   * generic 403, never a 404) so a caller cannot probe which UUIDs exist.
   * Runs as a SINGLE batched query (distinct ids), no per-sample round trip.
   */
  private async assertConnectionsOwnedByUser(
    parsed: IngestSamplesBody,
    userId: string,
  ): Promise<void> {
    const distinctIds = [...new Set(parsed.map((s) => s.connectionId))];

    const owned = await this.prisma.wearableConnection.findMany({
      where: { id: { in: distinctIds }, user_id: userId },
      select: { id: true, provider: true, status: true },
    });

    const byId = new Map(owned.map((c) => [c.id, c] as const));

    const ok = parsed.every((sample) => {
      const conn = byId.get(sample.connectionId);
      if (!conn) return false; // missing OR owned by another user
      if (conn.provider !== sample.provider) return false; // provider mismatch
      if (DISCONNECTED_CONNECTION_STATUSES.has(conn.status)) return false;
      return true;
    });

    if (!ok) {
      throw new ForbiddenException({
        code: 'wearables_connection_forbidden',
        message: 'connection does not belong to user or provider mismatch',
      });
    }
  }
}

/**
 * Connection lifecycle states that are NOT writable from the on-device ingest
 * lane. The model defaults to `connected`; a provider outage / unlink moves it
 * to one of these (see prisma/schema.prisma WearableConnection.status). A
 * sample arriving for a disconnected link is rejected at the controller seam.
 */
const DISCONNECTED_CONNECTION_STATUSES = new Set<string>([
  'disconnected',
  'expired',
  'error',
]);

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
