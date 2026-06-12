import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { AiTriageFeatureFlagGuard } from './ai-triage-flag.guard';
import { AiTriageService } from './ai-triage.service';
import {
  TriageResponse,
  TriageResponseSchema,
} from './triage-output.schema';

/**
 * v2-4 community AI inbox-triage endpoint.
 *
 *   GET /community/ai-triage   (coach/owner-auth)
 *
 * Read-only generation: returns the requesting coach's unanswered community
 * inbox sorted into the five fixed triage categories, each summarised item
 * carrying the source message/post id it was derived from. There is NO write
 * surface here — triage classifies, it never replies or posts (the
 * "no autonomous send" invariant is structural; see ai-triage.service.ts).
 *
 * Guard chain (mirrors the v2-2 ack controller exactly):
 *   JwtAuthGuard          — authenticates; populates req.user.
 *   RolesGuard            — gates to coach/owner; a client JWT gets 403.
 *   CommunityFeatureFlagGuard — community master switch (503 when off).
 *   AiTriageFeatureFlagGuard  — v2-4 kill switch: byte-identical 404 when
 *                               FEATURE_COMMUNITY_AI_TRIAGE is off. With the
 *                               flag off, NO AI code runs and the human inbox
 *                               (GET /community/me/coach-inbox) is untouched.
 *
 * The service additionally re-checks coach scope (coachedCohortIds non-empty →
 * else 403), so a coach with no coached cohorts cannot generate triage even
 * with the right role. Throttled on the shared COACH_AI_GENERATION bucket to
 * bound LLM cost per coach (30/hour).
 */
@ApiTags('community')
@Controller('community/ai-triage')
export class AiTriageController {
  constructor(private readonly triage: AiTriageService) {}

  @Get()
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    AiTriageFeatureFlagGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 30 },
  })
  async getTriage(@Request() req: AuthedRequest): Promise<TriageResponse> {
    const payload = await this.triage.generateForCoach(req.user);
    // Validate the wire response against the locked contract before it leaves
    // the process (defence in depth — the service already builds it via the
    // same schema, but a contract-violating shape can never reach a client).
    return TriageResponseSchema.parse(payload);
  }
}
