/**
 * B-AIB2-126 — AI workout builder generator (plan sections 2-4).
 *
 * `propose` asks the model for a structured diff of one workout, validates it
 * server-side (workout-diff.validator.ts) and stores it as a pending
 * AiActionDraft through the gateway. Nothing reaches a client until the coach
 * applies it (PATCH /ai/gateway/drafts/:id, optionally with
 * accepted_change_ids). Order of gates: flag (503 before anything) -> role ->
 * tenancy (404) -> lock token (409) -> capability configured (503) -> gateway
 * (roster + box-2 consent 403 + budget 403 before the provider call).
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma.service';
import { SubCoachScopeService } from '../../../sub-coach/sub-coach-scope.service';
import { CoachAIBudgetService } from '../../../ai-credits/coach-ai-budget.service';
import { computeLockToken } from '../../../workout-builder/lock-token.helper';
import { SEED_EXERCISES } from '../../../exercise-library/seed-catalog';
import { AiGatewayService } from '../ai-gateway.service';
import { AiGatewayConfig } from '../ai-gateway.config';
import { isMwbAiLiveCreateEnabled } from '../mwb-live-create.feature';
import { CREATE_WORKOUT_PLAN_CAPABILITY } from '../materialisers/create-workout-plan.materialiser';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from '../materialisers/edit-workout-plan.materialiser';
import {
  PlanSnapshot,
  emptyPlanSnapshot,
  snapshotFromRevisionJson,
} from '../materialisers/__shared/workout-diff.types';
import { InjuryArea, TRAINING_BOUNDS, contraindicatedAreas, isInjuryArea, stripMedicalClaims } from './training-safety.constants';
import {
  LibraryExercise,
  QuickAction,
  ValidatedChange,
  validateProposedChanges,
} from './workout-diff.validator';
import {
  WorkoutClientContext,
  buildWorkoutBuilderSystemPrompt,
  buildWorkoutBuilderUserMessage,
  parseModelOutput,
  stubProposal,
} from './workout-builder-prompt';

export interface ProposeInput {
  mode: 'create' | 'edit';
  plan_id?: string;
  lock_token?: string;
  client_id?: string;
  instruction: string;
  quick_action?: QuickAction;
  injury_area?: InjuryArea;
}

export interface ProposeResult {
  draft_id: string | null;
  summary: string;
  changes: ValidatedChange[];
  dropped: Array<{ reason: string }>;
  context_used: string[];
  screening_flag: boolean;
  credits_remaining_pct: number | null;
}

export const LIBRARY: ReadonlyMap<string, LibraryExercise> = new Map(
  SEED_EXERCISES.map((e) => [
    e.id,
    { id: e.id, name: e.name, category: e.bodyPart, muscle: e.target, thumbnail_url: e.gifUrl || null },
  ]),
);

type Outcome = { summary: string; changes: ValidatedChange[]; dropped: Array<{ reason: string }> };

const MAX_TOKENS = { create: 8_000, edit: 6_000, explain: 1_500 } as const;

/** Internal: the validator kept nothing usable. Carries reasons for the repair turn. */
class NoSafeProposal extends Error {
  constructor(readonly dropped: Array<{ reason: string }>) {
    super('AI_NO_SAFE_PROPOSAL');
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class WorkoutBuilderAiService {
  private readonly logger = new Logger(WorkoutBuilderAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly config: AiGatewayConfig,
    private readonly subCoachScope: SubCoachScopeService,
    @Optional() private readonly budget?: CoachAIBudgetService,
  ) {}

  async propose(
    requester: { id: string; role: string },
    input: ProposeInput,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<ProposeResult> {
    // SAFE 9 — kill switch, read per call, before any read, provider call or draft.
    if (!isMwbAiLiveCreateEnabled()) {
      throw new ServiceUnavailableException({
        code: 'AI_PAUSED',
        message: 'Ask AI is paused for maintenance. Your workouts are unchanged.',
      });
    }
    if (requester.role !== 'coach' && requester.role !== 'owner') {
      throw new NotFoundException();
    }
    const tenantCoachId =
      requester.role === 'coach'
        ? (await this.subCoachScope.getHeadCoachIdForSubCoach(requester.id)) ?? requester.id
        : null;

    // SAFE 3 — tenancy. Another coach's client or plan is an opaque 404.
    if (input.client_id && requester.role !== 'owner') {
      const ok = await this.subCoachScope.canAccessClient(requester.id, input.client_id);
      if (!ok) throw new NotFoundException({ code: 'client_not_found', message: 'Client not found.' });
    }

    let baseline: PlanSnapshot = emptyPlanSnapshot();
    let baseRevisionIndex = 0;
    let planCoachId: string | null = null;
    if (input.plan_id) {
      const plan = await this.prisma.workoutPlan.findUnique({
        where: { id: input.plan_id },
        select: { id: true, coach_id: true, version: true, head_revision_id: true, archived_at: true },
      });
      if (!plan || plan.archived_at || (requester.role !== 'owner' && plan.coach_id !== tenantCoachId)) {
        throw new NotFoundException({ code: 'plan_not_found', message: 'Workout not found.' });
      }
      planCoachId = plan.coach_id;
      const stale = () =>
        new ConflictException({
          code: 'REVISION_STALE',
          message: 'This workout changed on another screen. Reload it and ask again.',
        });
      if (!plan.head_revision_id) throw stale();
      if (input.lock_token) {
        const expected = computeLockToken(plan.id, plan.version, plan.head_revision_id);
        if (!sameToken(expected, input.lock_token)) throw stale();
      }
      const head = await this.prisma.workoutPlanRevision.findUnique({
        where: { id: plan.head_revision_id },
        select: { revision_index: true, exercises_json: true, plan_meta_json: true },
      });
      if (!head) throw stale();
      baseline = snapshotFromRevisionJson(head.exercises_json, head.plan_meta_json);
      baseRevisionIndex = head.revision_index;
    } else if (input.mode === 'edit' || !input.client_id) {
      throw new BadRequestException({
        code: 'PLAN_REQUIRED',
        message: 'Open a workout first, or choose a client to build a new one for.',
      });
    }

    const capability = input.plan_id ? EDIT_WORKOUT_PLAN_CAPABILITY : CREATE_WORKOUT_PLAN_CAPABILITY;
    if (!this.config.resolve(capability).capabilityAllowed) {
      throw new ServiceUnavailableException({
        code: 'AI_NOT_CONFIGURED',
        message: 'Ask AI is not available yet. Your workouts are unchanged.',
      });
    }

    const client = input.client_id ? await this.loadClientContext(input.client_id) : null;
    const injuries: InjuryArea[] = [...new Set([...(client?.injuries ?? []), ...(input.injury_area ? [input.injury_area] : [])])];
    const screeningFlag = client?.screening_flag ?? false;
    const promptLibrary = [...LIBRARY.values()].filter(
      (e) => contraindicatedAreas(e, injuries).length === 0,
    );
    const explain = input.quick_action === 'explain';
    const systemPrompt = buildWorkoutBuilderSystemPrompt({
      mode: input.mode,
      quickAction: input.quick_action,
      library: promptLibrary,
      client: client ? { ...client, injuries } : injuries.length ? emptyClient(injuries) : null,
    });

    let lastDropped: Array<{ reason: string }> = [];
    let outcome: Outcome | null = null;
    let draftId: string | null = null;
    for (let attempt = 0; attempt < 2 && !outcome; attempt++) {
      const userMessage =
        attempt === 0
          ? buildWorkoutBuilderUserMessage(input.instruction, baseline)
          : JSON.stringify({
              previous_attempt_rejected: lastDropped.map((d) => d.reason).slice(0, 20),
              retry: JSON.parse(buildWorkoutBuilderUserMessage(input.instruction, baseline)),
            });
      const box: { validated: Outcome | null } = { validated: null };
      try {
        const result = await this.gateway.invoke({
          capability,
          requester,
          subjectUserId: input.client_id,
          tenantCoachId: tenantCoachId ?? planCoachId ?? undefined,
          userMessage,
          systemPrompt,
          maxTokens: explain ? MAX_TOKENS.explain : MAX_TOKENS[input.mode],
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          resolveProposedAction: async (response, { providerFailed }) => {
            const isStub = response.provider === 'stub' && !providerFailed;
            if (providerFailed || !response.enabled) {
              if (!isStub || process.env.NODE_ENV === 'production') {
                throw new ServiceUnavailableException({
                  code: 'AI_NOT_CONFIGURED',
                  message: 'Ask AI could not reach the model. Your workouts are unchanged. Try again in a minute.',
                });
              }
            }
            const output = isStub ? stubProposal(baseline, promptLibrary) : parseModelOutput(response.text);
            if (!output) throw new NoSafeProposal([{ reason: 'The reply was not a workout change.' }]);
            const summary =
              stripMedicalClaims(output.summary, TRAINING_BOUNDS.summaryMax) ||
              (explain ? 'No summary available for this workout.' : 'Suggested changes for this workout.');
            if (explain) {
              box.validated = { summary, changes: [], dropped: [] };
              return null;
            }
            const v = validateProposedChanges({
              baseline,
              rawChanges: output.changes,
              library: LIBRARY,
              injuries,
              instruction: input.instruction,
              screeningFlag,
              quickAction: input.quick_action,
            });
            if (v.changes.length === 0) throw new NoSafeProposal(v.dropped);
            box.validated = { summary, changes: v.changes, dropped: v.dropped };
            const diff = v.changes.map((c) => c.op);
            return input.plan_id
              ? { capability, target_plan_id: input.plan_id, base_revision_index: baseRevisionIndex, diff }
              : { capability, target_client_id: input.client_id, diff };
          },
        });
        draftId = result.approvalDraftId;
        outcome = box.validated;
      } catch (e) {
        if (!(e instanceof NoSafeProposal)) throw e;
        lastDropped = e.dropped;
      }
    }
    if (!outcome) {
      throw new UnprocessableEntityException({
        code: 'AI_NO_SAFE_PROPOSAL',
        message: 'No safe change found for that request. Try: swap squats for a knee-friendly option.',
        dropped: lastDropped.slice(0, 20),
      });
    }

    return {
      draft_id: draftId,
      summary: outcome.summary,
      changes: outcome.changes,
      dropped: outcome.dropped,
      context_used: contextUsed(client, injuries),
      screening_flag: screeningFlag,
      credits_remaining_pct: await this.remainingPct(tenantCoachId ?? planCoachId),
    };
  }

  /** SAFE 2 — enums and numbers only; no name, email, phone, body metrics, snacks or messages. */
  private async loadClientContext(clientId: string): Promise<WorkoutClientContext> {
    const [profile, intake] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { user_id: clientId },
        select: { goal_type: true, workout_experience: true, equipment_access: true, workout_days_per_week: true, injuries: true },
      }),
      this.prisma.clientOnboardingIntake.findUnique({
        where: { client_id: clientId },
        select: { screening_any_yes: true },
      }),
    ]);
    return {
      goal: profile?.goal_type ?? null,
      experience: profile?.workout_experience ?? null,
      equipment: (profile?.equipment_access ?? []).slice(0, 12).map((s) => s.slice(0, 40)),
      days_per_week: profile?.workout_days_per_week ?? null,
      injuries: (profile?.injuries ?? []).filter(isInjuryArea),
      screening_flag: intake?.screening_any_yes === true,
    };
  }

  private async remainingPct(coachId: string | null): Promise<number | null> {
    if (!this.budget || !coachId) return null;
    try {
      const dto = await this.budget.getBudgetDto(await this.budget.resolveHeadCoachId(coachId));
      const total = dto.total_displayed_cents;
      return total > 0 ? Math.max(0, Math.min(100, Math.round((dto.remaining_displayed_cents / total) * 100))) : 0;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`credits_remaining_pct unavailable: ${(err as Error).message}`);
      return null;
    }
  }
}

function emptyClient(injuries: InjuryArea[]): WorkoutClientContext {
  return { goal: null, experience: null, equipment: [], days_per_week: null, injuries, screening_flag: false };
}

/** Truthful list of what the model was given (drives the mobile context row). */
export function contextUsed(client: WorkoutClientContext | null, injuries: readonly InjuryArea[]): string[] {
  const used = ['exercise_library', 'current_workout'];
  if (client) {
    if (client.goal) used.push('goal');
    if (client.experience) used.push('experience');
    if (client.equipment.length) used.push('equipment');
    if (client.days_per_week) used.push('schedule');
    if (client.screening_flag) used.push('health_screening');
  }
  if (injuries.length) used.push('injuries');
  return used;
}
