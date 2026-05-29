import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { RequiresTier } from '../../billing/requires-tier.decorator';
import { SubscriptionGuard } from '../../billing/subscription.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../../throttler/throttler.config';
import { CoachAIService } from './coach-ai.service';
import { CoachAIStateService } from './coach-ai-state.service';
import {
  EditDraftDto,
  GenerateClientInsightDto,
  GenerateMealPlanDto,
  GenerateWorkoutProgramDto,
  RejectDraftDto,
} from './coach-ai.dto';

// Coach AI v1 — coach-only generation surface. Mounted at /coach/ai/*.
// Every route is gated by JwtAuthGuard + CoachGuard. Throttles are tight
// because each generation call costs real money on Anthropic; the boot
// gate (CoachAIStateService) returns 503 ai_disabled when the engine is
// off so a missing/invalid ANTHROPIC_API_KEY does not silently consume
// the rate-limit budget.
//
// Hybrid pricing (spec §5): Coach AI is a Pro feature. @RequiresTier('pro')
// is applied at the class level so every handler inherits it. Free coaches
// receive 403 TIER_UPGRADE_REQUIRED in enforce mode.
@ApiTags('coach-ai')
@Controller('coach/ai')
@RequiresTier('pro')
@UseGuards(JwtAuthGuard, CoachGuard, SubscriptionGuard)
export class CoachAIController {
  constructor(
    private readonly svc: CoachAIService,
    private readonly state: CoachAIStateService,
  ) {}

  // Health / disable-mode discovery. The mobile coach console queries
  // this on app open so it can hide the "Generate" buttons when the
  // engine is off, rather than letting a coach tap a button and see a
  // 503 modal.
  // Audit: coach-only surface — `/coach/ai/status` is meaningless to
  // students (they never see a "Generate" button). Owners listed for
  // self-documenting parity with the rest of /coach/ai/*; RolesGuard
  // auto-bypasses for OWNER anyway.
  @Roles('coach', 'owner')
  @Get('status')
  status() {
    return this.state.getStatus();
  }

  // Audit: only coaches generate AI workout programs for their own
  // clients. The service-layer assertCoachOwnsClient(coachId, clientId)
  // prevents cross-tenant generation; students never invoke generation.
  @Roles('coach', 'owner')
  @Post('workout-program')
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 5 } })
  async generateWorkoutProgram(
    @Request() req: AuthedRequest,
    @Body() body: GenerateWorkoutProgramDto,
  ) {
    return this.svc.generateWorkoutProgram(req.user.id, body);
  }

  // Audit: coach-only generation surface; assertCoachOwnsClient guards
  // the clientId against IDOR. Students cannot generate meal plans for
  // themselves or anyone else through this path.
  @Roles('coach', 'owner')
  @Post('meal-plan')
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 5 } })
  async generateMealPlan(
    @Request() req: AuthedRequest,
    @Body() body: GenerateMealPlanDto,
  ) {
    return this.svc.generateMealPlan(req.user.id, body);
  }

  // Audit: coach-only — insight is the coach's interpretation of a
  // client's data, never the client's self-service. Same coach-owns-
  // client check applies before any Anthropic spend.
  @Roles('coach', 'owner')
  @Post('client-insight')
  @Throttle({ [THROTTLER_NAMES.COACH_AI_GENERATION]: { ttl: 3_600_000, limit: 10 } })
  async generateClientInsight(
    @Request() req: AuthedRequest,
    @Body() body: GenerateClientInsightDto,
  ) {
    return this.svc.generateClientInsight(req.user.id, body);
  }

  // List pending drafts (status=DRAFT) for the coach with optional client filter.
  // Mobile uses this to surface the "pending AI drafts" inbox and to poll for
  // drafts that completed after the mobile 120-second axios timeout fired.
  // Audit: service WHERE-clause scopes by `coachId = req.user.id` so the
  // inbox can only ever show the requesting coach's own drafts.
  @Roles('coach', 'owner')
  @Get('drafts')
  async listDrafts(
    @Request() req: AuthedRequest,
    @Query('clientId') clientId?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 50, 200)) : 50;
    return this.svc.listDrafts(req.user.id, { clientId, limit: limitNum });
  }

  // Audit: service re-checks `draft.coachId !== req.user.id` and collapses
  // missing/foreign-owned into a single 404 (QA P0-A2) so a coach cannot
  // probe other coaches' draft IDs. Coach-only by intent.
  @Roles('coach', 'owner')
  @Get('drafts/:draftId')
  async getDraft(@Request() req: AuthedRequest, @Param('draftId') draftId: string) {
    return this.svc.getDraft(req.user.id, draftId);
  }

  // Audit: write op on a draft; service calls getDraft(coachId, draftId)
  // first, so foreign-owned drafts 404 before any approval-side materialize
  // (WorkoutPlan / MealPlan create under req.user.id) runs.
  @Roles('coach', 'owner')
  @Post('drafts/:draftId/approve')
  async approve(@Request() req: AuthedRequest, @Param('draftId') draftId: string) {
    return this.svc.approveDraft(req.user.id, draftId);
  }

  // Audit: write op on a draft; service calls getDraft(coachId, draftId)
  // first so only the owning coach can edit a draft's generated payload.
  @Roles('coach', 'owner')
  @Post('drafts/:draftId/edit')
  async edit(
    @Request() req: AuthedRequest,
    @Param('draftId') draftId: string,
    @Body() body: EditDraftDto,
  ) {
    return this.svc.editDraft(req.user.id, draftId, body.patch || {});
  }

  // Audit: write op on a draft; service calls getDraft(coachId, draftId)
  // first so only the owning coach can reject (set status=REJECTED on)
  // a draft.
  @Roles('coach', 'owner')
  @Post('drafts/:draftId/reject')
  async reject(
    @Request() req: AuthedRequest,
    @Param('draftId') draftId: string,
    @Body() body: RejectDraftDto,
  ) {
    return this.svc.rejectDraft(req.user.id, draftId, body.reason);
  }
}
