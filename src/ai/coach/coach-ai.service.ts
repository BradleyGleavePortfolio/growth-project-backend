import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AnthropicAdapter } from '../adapters/anthropic.adapter';
import { ClientContextService } from '../context/client-context.service';
import { CoachAIStateService } from './coach-ai-state.service';
import { clientDataSubject } from '../../ai-egress/ai-egress.types';
import { COACH_AI_CAPABILITIES, COACH_AI_MODEL } from './coach-ai.constants';
import { WorkoutProgramPrompt, WorkoutProgramInput, WorkoutProgramPayload } from '../prompts/workout-program.prompt';
import { MealPlanPrompt, MealPlanInput, MealPlanPayload } from '../prompts/meal-plan.prompt';
import { ClientInsightPrompt, ClientInsightInput, ClientInsightPayload } from '../prompts/client-insight.prompt';
import { ClientContext } from '../context/client-context.types';
import { MealPlansService } from '../../meal-plans/meal-plans.service';
import { WorkoutBuilderService } from '../../workout-builder/workout-builder.service';
import { WorkoutType } from '../../workout-builder/workout-builder.dto';
import { CoachAIBudgetService } from '../../ai-credits/coach-ai-budget.service';
import { CoachAiBudgetExhaustedException } from '../../ai-credits/budget-exhausted.exception';
import {
  COACH_AI_BUDGET_EXHAUSTED_CODE,
  COACH_AI_METERED_CAPABILITIES,
} from '../../ai-credits/ai-credits.constants';
import { resolveRecipientTimeZone } from '../../notifications/recipient-timezone';
import { aiProgramStartIso } from './ai-program-start';

// Coach AI v1 — orchestration service.
//
// Each generate* method:
//   1. Asserts CoachAIStateService.isReady() — else throws 503 ai_disabled.
//   2. Asserts coach owns the client (else 404 — same opacity convention
//      as the rest of /coach/* in this codebase).
//   3. Builds a snapshot via ClientContextService.build().
//   4. Refuses with 402 COACH_AI_BUDGET_EXHAUSTED when the coach AI pool
//      (head coach's pool for a sub-coach) is used up (B-AIB1-125).
//   5. Calls AnthropicAdapter.completeStructured with the right prompt and
//      debits the call's cost from the pool.
//   6. Writes an AIDraft row in DRAFT status.
//
// Approval flow materializes downstream rows: WORKOUT_PROGRAM -> a
// WorkoutPlan + WorkoutPlanExercise[]; MEAL_PLAN -> MealPlan; INSIGHT ->
// no-op (status just flips to APPROVED so the coach console can mark
// the insight as "shared with client").

@Injectable()
export class CoachAIService {
  private readonly logger = new Logger(CoachAIService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: CoachAIStateService,
    private readonly anthropic: AnthropicAdapter,
    private readonly ctxSvc: ClientContextService,
    private readonly mealPlans: MealPlansService,
    private readonly workouts: WorkoutBuilderService,
    // B-AIB1-125 — coach AI credit pool. @Optional() so unit tests that build
    // the service without it keep compiling; AiCreditsModule is @Global, so
    // production DI always provides it.
    @Optional() private readonly budget?: CoachAIBudgetService,
  ) {}

  /**
   * B-AIB1-125 — the same pre-call gate AiGatewayService.invoke runs: refuse
   * when the pool is already at or over its ceiling (402 with the structured
   * body the mobile hard-pause modal reads). Returns the pool owner id to
   * debit after the call, or null when the capability is not metered.
   */
  private async assertBudget(coachId: string, capability: string): Promise<string | null> {
    if (!this.budget || !COACH_AI_METERED_CAPABILITIES.has(capability)) return null;
    const budgetCoachId = await this.budget.resolveHeadCoachId(coachId);
    const pre = await this.budget.canCharge(budgetCoachId, 0);
    if (pre.budget.actual_used_cents < pre.budget.total_actual_available_cents) {
      return budgetCoachId;
    }
    const dto = await this.budget.getBudgetDto(budgetCoachId);
    // CoachAiSection shows `message` verbatim, so it is product copy here:
    // specific, and no purchase wording (the iOS app sells no AI credits).
    throw new CoachAiBudgetExhaustedException({
      code: COACH_AI_BUDGET_EXHAUSTED_CODE,
      message:
        'AI credits for this period are used up, so nothing was generated. Credits renew at the start of the next period.',
      pack_options_cents: dto.pack_options_cents,
      custom_pack_bounds_cents: dto.custom_pack_bounds_cents,
      budget: {
        period_end: dto.period_end,
        base_displayed_cents: dto.base_displayed_cents,
        pack_displayed_cents: dto.pack_displayed_cents,
        used_displayed_cents: dto.used_displayed_cents,
        remaining_displayed_cents: dto.remaining_displayed_cents,
      },
    });
  }

  /**
   * B-AIB1-125 — debit the provider call's actual cost (the adapter's own
   * token pricing). The call already happened, so a failed write is logged,
   * never thrown at the coach (same posture as the gateway).
   */
  private async recordSpend(
    budgetCoachId: string | null,
    capability: string,
    clientId: string,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> {
    if (!this.budget || !budgetCoachId) return;
    const actualCostCents = AnthropicAdapter.computeCostCents(tokensIn, tokensOut);
    try {
      await this.budget.recordUsage({
        coachId: budgetCoachId,
        actualCostCents,
        capability,
        contextId: clientId,
      });
    } catch (err) {
      // Error name only: exception text can carry personal data
      // (test/privacy/no-pii-in-logs.spec.ts).
      this.logger.error(
        `Budget recordUsage failed for capability=${capability} (err=${err instanceof Error ? err.name : 'unknown'})`,
      );
    }
  }

  private assertReady(): void {
    if (!this.state.isReady()) {
      throw new ServiceUnavailableException({
        error: 'ai_disabled',
        action: 'set ANTHROPIC_API_KEY in Fly secrets',
      });
    }
  }

  /**
   * MWB-1 (§7.2): widen the AI-path client gate from head-coach-only to
   * head-coach OR open sub-coach, so a sub-coach can drive AI generation for
   * clients delegated to them — identical scope to the human assign path.
   * Delegates to WorkoutBuilderService.assertCanAccessClient (the single
   * source of truth) but preserves the /coach/* opacity convention: any
   * access failure (Forbidden or missing) surfaces as 404 'Client not found'
   * rather than leaking whether the client exists.
   */
  private async assertCoachOwnsClient(coachId: string, clientId: string): Promise<void> {
    try {
      await this.workouts.assertCanAccessClient(coachId, clientId);
    } catch {
      throw new NotFoundException('Client not found');
    }
  }

  async generateWorkoutProgram(
    coachId: string,
    input: { clientId: string } & WorkoutProgramInput,
  ): Promise<{ draftId: string; payload: WorkoutProgramPayload }> {
    this.assertReady();
    await this.assertCoachOwnsClient(coachId, input.clientId);
    const budgetCoachId = await this.assertBudget(coachId, COACH_AI_CAPABILITIES.WORKOUT_PROGRAM);
    const ctx = await this.ctxSvc.build(input.clientId);
    const prompt = WorkoutProgramPrompt;
    const result = await this.anthropic.completeStructured<WorkoutProgramPayload>(
      {
        system: prompt.system,
        user: prompt.buildUser(ctx, {
          weeks: input.weeks,
          daysPerWeek: input.daysPerWeek,
          focus: input.focus,
          notes: input.notes,
        }),
      },
      prompt.validate,
      {
        capability: COACH_AI_CAPABILITIES.WORKOUT_PROGRAM,
        coachId,
        clientId: input.clientId,
        // R2b — the client's live box-2 grant is required (after the
        // ownership check above, so the refusal is no cross-tenant oracle).
        dataSubject: clientDataSubject(input.clientId, 'coach'),
        surface: 'coach_ai.workout_program',
        maxTokens: 4096,
      },
    );
    await this.recordSpend(
      budgetCoachId,
      COACH_AI_CAPABILITIES.WORKOUT_PROGRAM,
      input.clientId,
      result.tokensIn,
      result.tokensOut,
    );
    const draft = await this.persistDraft(
      coachId,
      input.clientId,
      'WORKOUT_PROGRAM',
      ctx,
      result.modelUsed,
      prompt.version,
      result.data as unknown as Prisma.InputJsonValue,
      result.tokensIn,
      result.tokensOut,
    );
    return { draftId: draft.id, payload: result.data };
  }

  async generateMealPlan(
    coachId: string,
    input: { clientId: string } & MealPlanInput,
  ): Promise<{ draftId: string; payload: MealPlanPayload }> {
    this.assertReady();
    await this.assertCoachOwnsClient(coachId, input.clientId);
    const budgetCoachId = await this.assertBudget(coachId, COACH_AI_CAPABILITIES.MEAL_PLAN);
    const ctx = await this.ctxSvc.build(input.clientId);
    const prompt = MealPlanPrompt;
    const result = await this.anthropic.completeStructured<MealPlanPayload>(
      {
        system: prompt.system,
        user: prompt.buildUser(ctx, { days: input.days, notes: input.notes }),
      },
      prompt.validate,
      {
        capability: COACH_AI_CAPABILITIES.MEAL_PLAN,
        coachId,
        clientId: input.clientId,
        // R2b — the client's live box-2 grant is required (after the
        // ownership check above, so the refusal is no cross-tenant oracle).
        dataSubject: clientDataSubject(input.clientId, 'coach'),
        surface: 'coach_ai.meal_plan',
        maxTokens: 4096,
      },
    );
    await this.recordSpend(
      budgetCoachId,
      COACH_AI_CAPABILITIES.MEAL_PLAN,
      input.clientId,
      result.tokensIn,
      result.tokensOut,
    );
    // Soft check (warn-only at draft time): each day's totals should be
    // within ±10% of prescribed.calories / prescribed.protein_g. The
    // approval flow re-checks before materializing, so a non-compliant
    // draft stays inspectable in DRAFT status.
    this.warnIfMacrosOutOfTolerance(result.data, ctx);
    const draft = await this.persistDraft(
      coachId,
      input.clientId,
      'MEAL_PLAN',
      ctx,
      result.modelUsed,
      prompt.version,
      result.data as unknown as Prisma.InputJsonValue,
      result.tokensIn,
      result.tokensOut,
    );
    return { draftId: draft.id, payload: result.data };
  }

  async generateClientInsight(
    coachId: string,
    input: { clientId: string } & ClientInsightInput,
  ): Promise<{ draftId: string; payload: ClientInsightPayload }> {
    this.assertReady();
    await this.assertCoachOwnsClient(coachId, input.clientId);
    const budgetCoachId = await this.assertBudget(coachId, COACH_AI_CAPABILITIES.INSIGHT);
    const ctx = await this.ctxSvc.build(input.clientId);
    const prompt = ClientInsightPrompt;
    const result = await this.anthropic.completeStructured<ClientInsightPayload>(
      {
        system: prompt.system,
        user: prompt.buildUser(ctx, { windowDays: input.windowDays ?? 7 }),
      },
      prompt.validate,
      {
        capability: COACH_AI_CAPABILITIES.INSIGHT,
        coachId,
        clientId: input.clientId,
        // R2b — the client's live box-2 grant is required (after the
        // ownership check above, so the refusal is no cross-tenant oracle).
        dataSubject: clientDataSubject(input.clientId, 'coach'),
        surface: 'coach_ai.insight',
        maxTokens: 1024,
      },
    );
    await this.recordSpend(
      budgetCoachId,
      COACH_AI_CAPABILITIES.INSIGHT,
      input.clientId,
      result.tokensIn,
      result.tokensOut,
    );
    const draft = await this.persistDraft(
      coachId,
      input.clientId,
      'INSIGHT',
      ctx,
      result.modelUsed,
      prompt.version,
      result.data as unknown as Prisma.InputJsonValue,
      result.tokensIn,
      result.tokensOut,
    );
    return { draftId: draft.id, payload: result.data };
  }

  // List DRAFT-status AIDraft rows for this coach, optionally filtered to a
  // single client. Used by the mobile "pending AI drafts" inbox and the
  // post-timeout poll so coaches can recover orphaned drafts when the 120-
  // second mobile timeout fires before the backend finishes generating.
  async listDrafts(
    coachId: string,
    opts: { clientId?: string; limit?: number } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.aIDraft.findMany({
      where: {
        coachId,
        status: 'DRAFT',
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        type: true,
        clientId: true,
        status: true,
        modelUsed: true,
        tokensIn: true,
        tokensOut: true,
        costCents: true,
        createdAt: true,
      },
    });
  }

  async getDraft(coachId: string, draftId: string) {
    const draft = await this.prisma.aIDraft.findUnique({ where: { id: draftId } });
    // Collapse missing vs foreign-owned into a single 404. Returning 403 for
    // foreign-owned IDs let a coach probe which draft IDs exist; the IDs
    // themselves don't carry payload but they were the basis for follow-on
    // recon. See QA P0-A2.
    if (!draft || draft.coachId !== coachId) {
      throw new NotFoundException('Draft not found');
    }
    return draft;
  }

  async editDraft(coachId: string, draftId: string, patch: Record<string, unknown>) {
    const draft = await this.getDraft(coachId, draftId);
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException(`Cannot edit a draft in status=${draft.status}`);
    }
    const merged = {
      ...(typeof draft.generatedPayload === 'object' && draft.generatedPayload !== null
        ? (draft.generatedPayload as Record<string, unknown>)
        : {}),
      ...patch,
    };
    return this.prisma.aIDraft.update({
      where: { id: draftId },
      data: { generatedPayload: merged as unknown as Prisma.InputJsonValue },
    });
  }

  async rejectDraft(coachId: string, draftId: string, reason: string) {
    const draft = await this.getDraft(coachId, draftId);
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException(`Cannot reject a draft in status=${draft.status}`);
    }
    return this.prisma.aIDraft.update({
      where: { id: draftId },
      data: { status: 'REJECTED', rejectionReason: reason },
    });
  }

  async approveDraft(coachId: string, draftId: string) {
    const draft = await this.getDraft(coachId, draftId);
    if (draft.type === 'WORKOUT_PROGRAM') {
      return this.approveWorkoutProgram(coachId, draft);
    }
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException(`Cannot approve a draft in status=${draft.status}`);
    }
    let approvedAsId: string | null = null;
    if (draft.type === 'MEAL_PLAN') {
      approvedAsId = await this.materializeMealPlan(coachId, draft);
    }
    return this.prisma.aIDraft.update({
      where: { id: draftId },
      data: { status: 'APPROVED', approvedAsId },
    });
  }

  /**
   * B-AIASSIGN-125: "Approve & assign" puts every AI day on the client's
   * calendar. Plans are created in the coach library, then ONE transaction
   * writes one ClientWorkoutAssignment + snapshot per plan (offset
   * (week-1)*7 + (day-1) days from the start date) and stamps the draft
   * APPROVED with approvedAsId, so approvedAsId set <=> assignments exist.
   * One push to the client after commit. A double tap is fenced by a
   * conditional DRAFT -> APPROVED claim: the second request replays the
   * finished result instead of assigning the program twice.
   */
  private async approveWorkoutProgram(
    coachId: string,
    draft: Awaited<ReturnType<CoachAIService['getDraft']>>,
  ) {
    const dayCount = this.workoutProgramDays(draft).days.length;
    if (draft.status !== 'DRAFT') return this.replayWorkoutApproval(coachId, draft.id, dayCount);
    // The client may have left this coach since the draft was generated.
    await this.assertCoachOwnsClient(coachId, draft.clientId);

    const claim = await this.prisma.aIDraft.updateMany({
      where: { id: draft.id, coachId, status: 'DRAFT' },
      data: { status: 'APPROVED' },
    });
    if (claim.count === 0) return this.replayWorkoutApproval(coachId, draft.id, dayCount);

    try {
      const plans = await this.materializeWorkoutProgram(coachId, draft);
      const startDate = aiProgramStartIso(
        new Date(),
        await resolveRecipientTimeZone(this.prisma, draft.clientId),
        (draft.generatedPayload as { start_date?: unknown } | null)?.start_date,
      );
      const { approved, assignments } = await this.prisma.$transaction(async (tx) => {
        const rows = await this.workouts.writePlanAssignmentsInTx(
          tx,
          coachId,
          draft.clientId,
          plans,
          startDate,
        );
        const updated = await tx.aIDraft.update({
          where: { id: draft.id },
          data: { status: 'APPROVED', approvedAsId: plans[0].id },
        });
        return { approved: updated, assignments: rows };
      });
      this.workouts.notifyProgramAssigned(draft.clientId, assignments[0].id, plans[0].id);
      return { ...approved, assigned_count: assignments.length };
    } catch (err) {
      // Release the claim so the coach can approve again after a failure.
      await this.prisma.aIDraft
        .updateMany({
          where: { id: draft.id, status: 'APPROVED', approvedAsId: null },
          data: { status: 'DRAFT' },
        })
        .catch((releaseErr: unknown) =>
          this.logger.warn(`approve claim release failed for draft ${draft.id}: ${String(releaseErr)}`),
        );
      throw err;
    }
  }

  private async replayWorkoutApproval(coachId: string, draftId: string, dayCount: number) {
    const current = await this.getDraft(coachId, draftId);
    if (current.status === 'APPROVED' && current.approvedAsId) {
      return { ...current, assigned_count: dayCount };
    }
    if (current.status === 'APPROVED') {
      throw new ConflictException('This program is already being assigned.');
    }
    throw new BadRequestException(`Cannot approve a draft in status=${current.status}`);
  }

  private workoutProgramDays(draft: { generatedPayload: Prisma.JsonValue }) {
    const payload = draft.generatedPayload as unknown as WorkoutProgramPayload;
    if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
      throw new BadRequestException('Workout program payload has no days');
    }
    return { payload, days: payload.days };
  }

  // ─── Materializers ────────────────────────────────────────────────────────

  private async materializeWorkoutProgram(
    coachId: string,
    draft: { generatedPayload: Prisma.JsonValue; clientId: string },
  ): Promise<Array<{ id: string; week_index: number; day_index: number }>> {
    const { payload, days } = this.workoutProgramDays(draft);
    // Materialize ALL days as individual WorkoutPlan records under the coach
    // (visible in the coach's plan library). The caller assigns them to the
    // client; the first plan's id becomes the draft's approvedAsId.
    const created: Array<{ id: string; week_index: number; day_index: number }> = [];
    for (const day of days) {
      const dayLabel = `W${day.week}D${day.day}`;
      const planName = (
        `${payload.summary?.slice(0, 40) || 'AI program'} – ${day.name || dayLabel}`
      ).slice(0, 100);
      const plan = await this.workouts.createPlan(coachId, {
        name: planName,
        type: (day.type as WorkoutType) || WorkoutType.strength,
        duration_estimate_minutes: day.duration_estimate_minutes,
      });
      if (day.exercises.length) {
        await this.workouts.setExercises(
          coachId,
          plan.id,
          day.exercises.map((row) => ({
            exercise_external_id: row.exercise_external_id,
            order: row.order,
            sets: row.sets,
            reps_or_duration_seconds: row.reps_or_duration_seconds,
            weight_lbs: row.weight_lbs ?? undefined,
            rest_seconds: row.rest_seconds ?? undefined,
            superset_group_id: row.superset_group_id ?? undefined,
            notes: row.notes ?? undefined,
          })),
        );
      }
      created.push({
        id: plan.id,
        week_index: Math.max(0, Math.trunc(Number(day.week) || 1) - 1),
        day_index: Math.max(0, Math.trunc(Number(day.day) || 1) - 1),
      });
    }
    return created;
  }

  private async materializeMealPlan(
    coachId: string,
    draft: { generatedPayload: Prisma.JsonValue; clientId: string },
  ): Promise<string> {
    const payload = draft.generatedPayload as unknown as MealPlanPayload;
    if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
      throw new BadRequestException('Meal plan payload has no days');
    }
    // Build the legacy flat items[] so existing clients that read only
    // MealPlan.items continue to work without a mobile-side change.
    const items = payload.days.flatMap((day) =>
      day.meals.flatMap((meal) =>
        meal.items.map((it) => ({
          name: `${it.name} (${it.serving})`.slice(0, 80),
          calories: Math.round(it.calories),
          protein: Math.round(it.protein_g),
          notes: undefined as string | undefined,
          time_of_day: `Day ${day.day} – ${meal.slot}`.slice(0, 40),
        })),
      ),
    );
    // Also store the full per-day structure in MealPlan.days so mobile
    // can render meals grouped by day (H2 fix). The shape mirrors
    // MealPlanDay from the prompt: { day, meals[{ slot, items[] }], daily_totals }.
    const created = await this.mealPlans.createForClient(coachId, draft.clientId, {
      title: (payload.summary?.slice(0, 60) || 'AI-generated meal plan'),
      notes: payload.coach_notes ?? undefined,
      items: items.length
        ? items
        : [{ name: 'AI meal plan (no items materialized)' }],
      days: payload.days,
    });
    return created.id;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async persistDraft(
    coachId: string,
    clientId: string,
    type: 'WORKOUT_PROGRAM' | 'MEAL_PLAN' | 'INSIGHT',
    ctx: ClientContext,
    modelUsed: string,
    promptVersion: string,
    payload: Prisma.InputJsonValue,
    tokensIn: number,
    tokensOut: number,
  ) {
    const costCents = AnthropicAdapter.computeCostCents(tokensIn, tokensOut);
    return this.prisma.aIDraft.create({
      data: {
        coachId,
        clientId,
        type,
        inputContext: ctx as unknown as Prisma.InputJsonValue,
        modelUsed: modelUsed || COACH_AI_MODEL,
        promptVersion,
        generatedPayload: payload,
        tokensIn,
        tokensOut,
        costCents,
      },
    });
  }

  private warnIfMacrosOutOfTolerance(payload: MealPlanPayload, ctx: ClientContext): void {
    const target = ctx.prescribed.calories;
    const protein = ctx.prescribed.protein_g;
    if (target == null && protein == null) return;
    for (const day of payload.days) {
      if (target != null) {
        const drift = Math.abs(day.daily_totals.calories - target) / target;
        if (drift > 0.1) {
          this.logger.warn(
            `meal plan drift: day ${day.day} calories=${day.daily_totals.calories} target=${target} (${Math.round(drift * 100)}%)`,
          );
        }
      }
      if (protein != null) {
        const drift = Math.abs(day.daily_totals.protein_g - protein) / protein;
        if (drift > 0.1) {
          this.logger.warn(
            `meal plan drift: day ${day.day} protein_g=${day.daily_totals.protein_g} target=${protein} (${Math.round(drift * 100)}%)`,
          );
        }
      }
    }
  }

  // For the weekly cron — list active clients of a coach. Active = has
  // a coach_id pointing at this coach and is not deletion-pending.
  async listActiveClientsForCoach(coachId: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        role: 'student',
        deletion_scheduled_at: null,
        deleted_at: null,
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async listActiveCoachIds(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: 'coach', deletion_scheduled_at: null, deleted_at: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
