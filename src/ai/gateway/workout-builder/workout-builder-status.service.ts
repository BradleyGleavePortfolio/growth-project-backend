import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoachAIBudgetService } from '../../../ai-credits/coach-ai-budget.service';
import { AiGatewayConfig } from '../ai-gateway.config';
import { isMwbAiLiveCreateEnabled } from '../mwb-live-create.feature';

/**
 * AIB-4 — GET /ai/gateway/workout-builder/status (AI_MASTER_BUILDER_PLAN.md
 * section 3). Read per call, so the kill switch works without a redeploy:
 *   paused         FEATURE_MWB_AI_LIVE_CREATE is not 'true' (the kill switch);
 *   not_configured flag on, but neither workout capability resolves to a real
 *                  provider (gateway off, not allow-listed, stub, key absent);
 *   no_credits     the head coach's AI pool is used up (the gateway's own test);
 *   on             otherwise.
 * Never calls a provider and never reads client data.
 */
export const WORKOUT_BUILDER_AI_LABEL = 'AI-suggested, coach-approved';

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
    const create = flagOn && this.config.resolve('draft.create_workout_plan').enabled;
    const edit = flagOn && this.config.resolve('draft.edit_workout_plan').enabled;
    const { exhausted, ...credits } = await this.readCredits(coachUserId);
    const state: WorkoutBuilderAiState = !flagOn
      ? 'paused'
      : !create && !edit
        ? 'not_configured'
        : exhausted
          ? 'no_credits'
          : 'on';
    return { state, create, edit, credits, label: WORKOUT_BUILDER_AI_LABEL };
  }

  /**
   * A failed read leaves the numbers null and the state unchanged: the propose
   * call re-checks the budget before any provider call, so it cannot let one through.
   */
  private async readCredits(
    coachUserId: string,
  ): Promise<{ exhausted: boolean; remaining_pct: number | null; resets_at: string | null }> {
    if (!this.budget) return { exhausted: false, remaining_pct: null, resets_at: null };
    try {
      const { budget } = await this.budget.canCharge(await this.budget.resolveHeadCoachId(coachUserId), 0);
      const total = budget.base_displayed_cents + budget.pack_displayed_cents;
      const used = Math.round(budget.actual_used_cents * budget.value_multiplier);
      const exhausted = budget.actual_used_cents >= budget.total_actual_available_cents;
      const remaining_pct =
        exhausted || total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((total - used) / total) * 100)));
      return { exhausted, remaining_pct, resets_at: budget.period_end.toISOString() };
    } catch (err) {
      this.logger.warn(
        { event: 'WORKOUT_BUILDER_STATUS_BUDGET_READ_FAILED', error: err instanceof Error ? err.name : 'unknown' },
        'workout builder status: budget read failed; credits reported as null',
      );
      return { exhausted: false, remaining_pct: null, resets_at: null };
    }
  }
}
