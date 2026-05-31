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
import { WearableMetricBucket } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { WearableInsightsService } from './wearable-insights.service';
import { CoachInsight, ClientInsight } from './insight-output.schema';

// PR-HK-4 — read-only insight endpoints (no UI; the panels land in 5a/5b).
//
//   GET /v1/wearables/insights/coach?clientId=&bucket=   (coach-auth)
//   GET /v1/wearables/insights/client?bucket=            (user-auth)
//
// Strict dual-role projection (audit criteria #5):
//   - The coach endpoint NEVER returns the client-side schema, and the
//     coach-only fields (hypothesis, suggested_message_draft) are produced
//     only by the coach path.
//   - The client endpoint NEVER returns the coach-side schema.
// The service already returns the correct typed payload per audience; the
// controller adds the authorization boundary (coach-owns-client) and the
// Zod-validated query params, and is split into two handlers so the two
// response shapes can never cross.

// Both buckets, validated from the query string. The mobile clients send
// the enum value verbatim.
const BucketSchema = z.nativeEnum(WearableMetricBucket);

const CoachQuerySchema = z.object({
  clientId: z.string().uuid({ message: 'clientId must be a UUID' }),
  bucket: BucketSchema,
});

const ClientQuerySchema = z.object({
  bucket: BucketSchema,
});

@ApiTags('wearables-insights')
@Controller('v1/wearables/insights')
export class WearableInsightsController {
  constructor(private readonly svc: WearableInsightsService) {}

  // Coach-side insight for a specific client + bucket. Gated by
  // JwtAuthGuard + CoachGuard (coach/owner only). The service additionally
  // re-checks coach-owns-client so a coach cannot read another coach's
  // client (IDOR defence). Throttled to keep LLM cost bounded.
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 30 } })
  @Get('coach')
  async getCoachInsight(
    @Request() req: AuthedRequest,
    @Query() rawQuery: unknown,
  ): Promise<CoachInsight> {
    const { clientId, bucket } = parseOrThrow(CoachQuerySchema, rawQuery);
    await this.svc.assertCoachOwnsClient(req.user.id, clientId, req.user.role);
    return this.svc.generateForCoach(req.user.id, clientId, bucket);
  }

  // Client-side self-coaching insight for the authenticated user + bucket.
  // Gated by JwtAuthGuard only (any authenticated user reads their OWN
  // insight — subjectUserId is always req.user.id, so there is no IDOR
  // surface). Throttled per user.
  @UseGuards(JwtAuthGuard)
  @Throttle({ [THROTTLER_NAMES.DEFAULT]: { ttl: 3_600_000, limit: 60 } })
  @Get('client')
  async getClientInsight(
    @Request() req: AuthedRequest,
    @Query() rawQuery: unknown,
  ): Promise<ClientInsight> {
    const { bucket } = parseOrThrow(ClientQuerySchema, rawQuery);
    return this.svc.generateForClient(req.user.id, bucket);
  }
}

// Zod-parse a query object, converting a ZodError into a 400 with the
// field-level issues (mirrors the gateway's AI_DRAFT_PAYLOAD_INVALID shape).
function parseOrThrow<T>(schema: z.ZodSchema<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException({
      error: 'WEARABLE_INSIGHT_QUERY_INVALID',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
