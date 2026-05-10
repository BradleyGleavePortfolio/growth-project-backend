import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CoachOnboardingService } from './coach-onboarding.service';

// Phase 6D — coach-scoped onboarding wizard endpoints. Mounted on
// /coach/onboarding so the coach mobile / web client can poll progress and
// drive the 6-step wizard. Auth: JwtAuthGuard + CoachGuard. CoachGuard's
// OWNER bypass means an OWNER can read/write their own coach onboarding row
// when they hold a coach seat — but each coach only ever sees their own row
// (the service queries by req.user.id with no path param).
@ApiTags('coach-onboarding')
@Controller('coach/onboarding')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachOnboardingController {
  constructor(private readonly onboarding: CoachOnboardingService) {}

  // GET /coach/onboarding — current progress. 404 if the wizard has not
  // been started yet (the coach was promoted before auto-start landed, or
  // COACH_ONBOARDING_AUTO_START=false). The mobile client maps 404 → "show
  // start screen" which POSTs /start.
  @Get()
  async get(@Request() req: AuthedRequest) {
    return this.onboarding.getProgress(req.user.id);
  }

  // POST /coach/onboarding/start — idempotent. Used by the wizard splash
  // screen and as a fallback when a coach pre-dates the auto-start hook.
  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Request() req: AuthedRequest) {
    return this.onboarding.startWizard(req.user.id);
  }

  // POST /coach/onboarding/steps/:stepNumber — advance the wizard. Body is
  // the per-step blob the coach just submitted (e.g. business name + bio for
  // step 1). The service enforces sequential ordering and freezes the row
  // once completed_at is set.
  @Post('steps/:stepNumber')
  @HttpCode(HttpStatus.OK)
  async advance(
    @Request() req: AuthedRequest,
    @Param('stepNumber', ParseIntPipe) stepNumber: number,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.onboarding.advanceStep(req.user.id, {
      step: stepNumber,
      data: body,
    });
  }

  // POST /coach/onboarding/complete — terminal call. The wizard must already
  // be on step 6 (confirm) — the service rejects otherwise.
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Request() req: AuthedRequest) {
    return this.onboarding.completeWizard(req.user.id);
  }
}
