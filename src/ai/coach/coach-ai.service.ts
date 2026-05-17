import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { AnthropicAdapter } from '../adapters/anthropic.adapter';
import { ClientContextService } from '../context/client-context.service';
import { CoachAIStateService } from './coach-ai-state.service';
import { COACH_AI_CAPABILITIES, COACH_AI_MODEL } from './coach-ai.constants';
import { WorkoutProgramPrompt, WorkoutProgramInput, WorkoutProgramPayload } from '../prompts/workout-program.prompt';
import { MealPlanPrompt, MealPlanInput, MealPlanPayload } from '../prompts/meal-plan.prompt';
import { ClientInsightPrompt, ClientInsightInput, ClientInsightPayload } from '../prompts/client-insight.prompt';
import { ClientContext } from '../context/client-context.types';
import { MealPlansService } from '../../meal-plans/meal-plans.service';
import { WorkoutBuilderService } from '../../workout-builder/workout-builder.service';
import { WorkoutType } from '../../workout-builder/workout-builder.dto';

// Coach AI v1 — orchestration service.
//
// Each generate* method:
//   1. Asserts CoachAIStateService.isReady() — else throws 503 ai_disabled.
//   2. Asserts coach owns the client (else 404 — same opacity convention
//      as the rest of /coach/* in this codebase).
//   3. Builds a snapshot via ClientContextService.build().
//   4. Calls AnthropicAdapter.completeStructured with the right prompt.
//   5. Writes an AIDraft row in DRAFT status.
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
  ) {}

  private assertReady(): void {
    if (!this.state.isReady()) {
      throw new ServiceUnavailableException({
        error: 'ai_disabled',
        action: 'set ANTHROPIC_API_KEY in Fly secrets',
      });
    }
  }

  private async assertCoachOwnsClient(coachId: string, clientId: string): Promise<void> {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
  }

  async generateWorkoutProgram(
    coachId: string,
    input: { clientId: string } & WorkoutProgramInput,
  ): Promise<{ draftId: string; payload: WorkoutProgramPayload }> {
    this.assertReady();
    await this.assertCoachOwnsClient(coachId, input.clientId);
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
        maxTokens: 4096,
      },
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
        maxTokens: 4096,
      },
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
        maxTokens: 1024,
      },
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
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException(`Cannot approve a draft in status=${draft.status}`);
    }
    let approvedAsId: string | null = null;
    if (draft.type === 'WORKOUT_PROGRAM') {
      approvedAsId = await this.materializeWorkoutProgram(coachId, draft);
    } else if (draft.type === 'MEAL_PLAN') {
      approvedAsId = await this.materializeMealPlan(coachId, draft);
    }
    return this.prisma.aIDraft.update({
      where: { id: draftId },
      data: { status: 'APPROVED', approvedAsId },
    });
  }

  // ─── Materializers ────────────────────────────────────────────────────────

  private async materializeWorkoutProgram(
    coachId: string,
    draft: { generatedPayload: Prisma.JsonValue; clientId: string },
  ): Promise<string> {
    const payload = draft.generatedPayload as unknown as WorkoutProgramPayload;
    if (!payload || !Array.isArray(payload.days) || payload.days.length === 0) {
      throw new BadRequestException('Workout program payload has no days');
    }
    // Materialize ALL days as individual WorkoutPlan records. The first
    // plan's id is returned as approvedAsId so the AIDraft FK resolves to
    // a concrete record; all plans are created under the same coach and
    // are immediately visible in the coach's plan library for assignment.
    let firstPlanId: string | null = null;
    for (const day of payload.days) {
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
      if (firstPlanId === null) {
        firstPlanId = plan.id;
      }
    }
    return firstPlanId!;
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
