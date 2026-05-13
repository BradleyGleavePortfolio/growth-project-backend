import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
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
@ApiTags('coach-ai')
@Controller('coach/ai')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachAIController {
  constructor(
    private readonly svc: CoachAIService,
    private readonly state: CoachAIStateService,
  ) {}

  // Health / disable-mode discovery. The mobile coach console queries
  // this on app open so it can hide the "Generate" buttons when the
  // engine is off, rather than letting a coach tap a button and see a
  // 503 modal.
  @Get('status')
  status() {
    return this.state.getStatus();
  }

  @Post('workout-program')
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  async generateWorkoutProgram(
    @Request() req: AuthedRequest,
    @Body() body: GenerateWorkoutProgramDto,
  ) {
    return this.svc.generateWorkoutProgram(req.user.id, body);
  }

  @Post('meal-plan')
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  async generateMealPlan(
    @Request() req: AuthedRequest,
    @Body() body: GenerateMealPlanDto,
  ) {
    return this.svc.generateMealPlan(req.user.id, body);
  }

  @Post('client-insight')
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  async generateClientInsight(
    @Request() req: AuthedRequest,
    @Body() body: GenerateClientInsightDto,
  ) {
    return this.svc.generateClientInsight(req.user.id, body);
  }

  @Get('drafts/:draftId')
  async getDraft(@Request() req: AuthedRequest, @Param('draftId') draftId: string) {
    return this.svc.getDraft(req.user.id, draftId);
  }

  @Post('drafts/:draftId/approve')
  async approve(@Request() req: AuthedRequest, @Param('draftId') draftId: string) {
    return this.svc.approveDraft(req.user.id, draftId);
  }

  @Post('drafts/:draftId/edit')
  async edit(
    @Request() req: AuthedRequest,
    @Param('draftId') draftId: string,
    @Body() body: EditDraftDto,
  ) {
    return this.svc.editDraft(req.user.id, draftId, body.patch || {});
  }

  @Post('drafts/:draftId/reject')
  async reject(
    @Request() req: AuthedRequest,
    @Param('draftId') draftId: string,
    @Body() body: RejectDraftDto,
  ) {
    return this.svc.rejectDraft(req.user.id, draftId, body.reason);
  }
}
