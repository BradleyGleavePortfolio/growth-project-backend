import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoachAIBudgetService } from '../../../ai-credits/coach-ai-budget.service';
import { AiGatewayConfig } from '../ai-gateway.config';
import { isMwbAiLiveCreateEnabled } from '../mwb-live-create.feature';

/**
 * AIB-4 — server-driven visibility for "Ask AI" in the workout builder
 * (AI_MASTER_BUILDER_PLAN.md section 3, GET /ai/gateway/workout-builder/status).
 *
 * States, checked in this order (read per call, never cached, so the kill
 * switch works without a redeploy):
 *   paused         FEATURE_MWB_AI_LIVE_CREATE is not 'true' (the kill switch).
 *   not_configured the flag is on but neither workout capability resolves to a
 *                  real provider (gateway off, capability not in
 *                  AI_GATEWAY_CAPABILITIES, stub provider or provider key absent).
 *   no_credits     the coach's AI pool for this period is used up (the same
 *                  test the gateway's pre-call budget gate applies).
 *   on             otherwise.
 * The route never calls a provider and never reads client data.
 */
export const WORKOUT_BUILDER_AI_LABEL = 'AI-suggested, coach-approved';
export const WORKOUT_CREATE_CAPABILITY = 'draft.create_workout_plan';
export const WORKOUT_EDIT_CAPABILITY = 'draft.edit_workout_plan';

export type WorkoutBuilderAiState = 'on' | 'paused' | 'no_credits' | 'not_configured';

export interface WorkoutBuilderAiStatus {
  state: WorkoutBuilderAiState;
  create: boolean;
  edit: boolean;
  credits: { remaining_pct: number | null; resets_at: string | null };
  label: typeof WORKOUT_BUILDER_AI_LABEL;
}

@Injectable()
export class WorkoutBuilderStatusService {
  private readonly logger = new Logger(WorkoutBuilderStatusService.name);

  constructor(
    private readonly config: AiGatewayConfig,
    @Optional() private readonly budget?: CoachAIBudgetService,
  ) {}

  async getStatus(coachUserId: string): Promise<WorkoutBuilderAiStatus> {
    const flagOn = isMwbAiLiveCreateEnabled();
    const create = flagOn && this.config.resolve(WORKOUT_CREATE_CAPABILITY).enabled;
    const edit = flagOn && this.config.resolve(WORKOUT_EDIT_CAPABILITY).enabled;
    const credits = await this.readCredits(coachUserId);

    let state: WorkoutBuilderAiState;
    if (!flagOn) state = 'paused';
    else if (!create && !edit) state = 'not_configured';
    else if (credits.exhausted) state = 'no_credits';
    else state = 'on';

    return {
      state,
      create,
      edit,
      credits: { remaining_pct: credits.remaining_pct, resets_at: credits.resets_at },
      label: WORKOUT_BUILDER_AI_LABEL,
    };
  }

  /**
   * Remaining share of the head coach's pool (sub-coaches fold onto the head,
   * as the gateway meters them). A lookup failure leaves the numbers null and
   * the state unchanged: the propose call re-checks the budget before any
   * provider call, so a failed read here can never let a call through.
   */
  private async readCredits(coachUserId: string): Promise<{
    exhausted: boolean;
    remaining_pct: number | null;
    resets_at: string | null;
  }> {
    if (!this.budget) return { exhausted: false, remaining_pct: null, resets_at: null };
    try {
      const headId = await this.budget.resolveHeadCoachId(coachUserId);
      const { budget } = await this.budget.canCharge(headId, 0);
      const total = budget.base_displayed_cents + budget.pack_displayed_cents;
      const used = Math.round(budget.actual_used_cents * budget.value_multiplier);
      const exhausted = budget.actual_used_cents >= budget.total_actual_available_cents;
      const remaining_pct = exhausted || total <= 0
        ? 0
        : Math.max(0, Math.min(100, Math.round(((total - used) / total) * 100)));
      return { exhausted, remaining_pct, resets_at: budget.period_end.toISOString() };
    } catch (err) {
      this.logger.warn(
        { event: 'WORKOUT_BUILDER_STATUS_BUDGET_READ_FAILED', error: (err as Error)?.name },
        'workout builder status: budget read failed; credits reported as null',
      );
      return { exhausted: false, remaining_pct: null, resets_at: null };
    }
  }
}
