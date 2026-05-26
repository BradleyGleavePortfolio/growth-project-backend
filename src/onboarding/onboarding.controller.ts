/**
 * Coach-facing onboarding-nudge endpoints (R51).
 *
 *   GET  /v1/coaches/me/onboarding/state
 *        → CoachOnboardingState (for the in-app progress strip).
 *   POST /v1/coaches/me/onboarding/opt-out
 *        → marks opted_out_at + cancels future nudges. Idempotent.
 *   GET  /v1/coaches/me/share-templates
 *        → 5 share-link templates (IG bio, story, DM, email sig, QR poster).
 *
 * All routes gated by the global JwtAuthGuard + @Roles('coach','owner').
 * The state read endpoint lazily creates a CoachOnboardingState row so
 * an existing coach who pre-dates this PR has a stable response shape
 * on first visit.  The PII-free metric ("which milestone am I on") is
 * cheap enough to recompute on each call rather than caching.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { OnboardingNudgeService } from './onboarding-nudge.service';

@ApiTags('coach-onboarding')
@Roles('coach', 'owner')
// Generous throttle — the in-app progress strip polls this on coach
// home; tighter cap is unnecessary because the response is read-only
// and the work is two indexed queries.
@Throttle({ default: { ttl: 60_000, limit: 60 } })
@Controller('v1/coaches/me')
export class OnboardingController {
  constructor(private readonly service: OnboardingNudgeService) {}

  // GET /v1/coaches/me/onboarding/state
  @Get('onboarding/state')
  async getState(@Request() req: AuthedRequest) {
    const state = await this.service.getStateForCoach(req.user.id);
    const milestone = await this.service.detectMilestone(req.user.id);
    // Surface the LIVE milestone (re-detected each call) alongside the
    // snapshot stored on the row — the UI uses the live value for the
    // progress strip but ops may want the last persisted snapshot for
    // funnel analytics.
    return {
      coach_id: state.coach_id,
      signup_at: state.signup_at,
      first_client_at: state.first_client_at,
      opted_out_at: state.opted_out_at,
      last_milestone_snapshot: state.last_milestone,
      current_milestone: milestone,
      days_sent: {
        day_1: state.day_1_sent,
        day_2: state.day_2_sent,
        day_3: state.day_3_sent,
        day_5: state.day_5_sent,
        day_7: state.day_7_sent,
      },
    };
  }

  // POST /v1/coaches/me/onboarding/opt-out
  @Post('onboarding/opt-out')
  @HttpCode(HttpStatus.OK)
  async optOut(@Request() req: AuthedRequest) {
    const state = await this.service.optOut(req.user.id);
    return { ok: true, opted_out_at: state.opted_out_at };
  }

  // GET /v1/coaches/me/share-templates
  @Get('share-templates')
  async shareTemplates(@Request() req: AuthedRequest) {
    const templates = await this.service.buildShareTemplatesForCoach(req.user.id);
    // Empty array signals "no share token yet" — the client renders an
    // empty-state CTA pointing at the package builder rather than 404,
    // because the coach IS authorised, they just have no link to share.
    return { templates };
  }
}
