// B-AIB2-126 — AI workout builder generator. Gates in order: flag 503 -> role -> tenancy 404 -> lock token 409 ->
// capability configured 503 -> gateway (roster, box-2 consent 403, budget 403, meter) -> validator -> one repair -> 422.
import {
  BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { z } from 'zod';
import { PrismaService } from '../../../prisma.service';
import { SubCoachScopeService } from '../../../sub-coach/sub-coach-scope.service';
import { computeLockToken } from '../../../workout-builder/lock-token.helper';
import { SEED_EXERCISES } from '../../../exercise-library/seed-catalog';
import { AiGatewayService } from '../ai-gateway.service';
import { AiGatewayConfig } from '../ai-gateway.config';
import { isMwbAiLiveCreateEnabled } from '../mwb-live-create.feature';
import { CREATE_WORKOUT_PLAN_CAPABILITY } from '../materialisers/create-workout-plan.materialiser';
import { EDIT_WORKOUT_PLAN_CAPABILITY } from '../materialisers/edit-workout-plan.materialiser';
import { PlanSnapshot, emptyPlanSnapshot, snapshotFromRevisionJson } from '../materialisers/__shared/workout-diff.types';
import { InjuryArea, TRAINING_BOUNDS, contraindicatedAreas, isInjuryArea, stripMedicalClaims } from './training-safety.constants';
import { LibraryExercise, ValidatedChange, validateProposedChanges } from './workout-diff.validator';
import { loadWeekOtherSetsByMuscle, weeklySetsCap } from './week-limits';
import {
  WorkoutClientContext, buildWorkoutBuilderSystemPrompt, buildWorkoutBuilderUserMessage, parseModelOutput, stubProposal,
} from './workout-builder-prompt';
import { WorkoutBuilderStatusService } from './workout-builder-status.service';
import type { ProposeBodySchema } from './workout-builder-ai.controller';

export type ProposeInput = z.infer<typeof ProposeBodySchema>;
type Dropped = Array<{ reason: string }>;
type Outcome = { summary: string; changes: ValidatedChange[]; dropped: Dropped };
export type ProposeResult = Outcome & { draft_id: string | null; context_used: string[]; screening_flag: boolean; credits_remaining_pct: number | null };

export const LIBRARY: ReadonlyMap<string, LibraryExercise> = new Map(
  SEED_EXERCISES.map((e) => [e.id, { id: e.id, name: e.name, category: e.bodyPart, muscle: e.target, thumbnail_url: e.gifUrl || null }]),
);
// Section 4: max_tokens per mode; never a temperature (the Anthropic adapter sends none).
const MAX_TOKENS = { create: 8_000, edit: 6_000, explain: 1_500 } as const;
class NoSafeProposal extends Error {
  constructor(readonly dropped: Dropped) { super('AI_NO_SAFE_PROPOSAL'); }
}

function sameToken(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class WorkoutBuilderAiService {
  constructor(
    private readonly prisma: PrismaService, private readonly gateway: AiGatewayService, private readonly config: AiGatewayConfig,
    private readonly subCoachScope: SubCoachScopeService, private readonly status: WorkoutBuilderStatusService,
  ) {}

  async propose(requester: { id: string; role: string }, input: ProposeInput, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<ProposeResult> {
    if (!isMwbAiLiveCreateEnabled()) {
      throw new ServiceUnavailableException({ code: 'AI_PAUSED', message: 'Ask AI is paused for maintenance. Your workouts are unchanged.' });
    }
    if (requester.role !== 'coach' && requester.role !== 'owner') throw new NotFoundException();
    const tenantCoachId = requester.role === 'coach' ? (await this.subCoachScope.getHeadCoachIdForSubCoach(requester.id)) ?? requester.id : null;
    if (input.client_id && requester.role !== 'owner' && !(await this.subCoachScope.canAccessClient(requester.id, input.client_id))) {
      throw new NotFoundException({ code: 'client_not_found', message: 'Client not found.' });
    }
    let [baseline, baseRevisionIndex, planCoachId]: [PlanSnapshot, number, string | null] = [emptyPlanSnapshot(), 0, null];
    let weekOther: Map<string, number> | null = null;
    if (input.plan_id) {
      const select = { id: true, coach_id: true, version: true, head_revision_id: true, archived_at: true, program_id: true, week_index: true };
      const plan = await this.prisma.workoutPlan.findUnique({ where: { id: input.plan_id }, select });
      if (!plan || plan.archived_at || (requester.role !== 'owner' && plan.coach_id !== tenantCoachId)) {
        throw new NotFoundException({ code: 'plan_not_found', message: 'Workout not found.' });
      }
      planCoachId = plan.coach_id;
      const stale = () => new ConflictException({ code: 'REVISION_STALE', message: 'This workout changed on another screen. Reload it and ask again.' });
      if (!plan.head_revision_id) throw stale();
      // No lock_token (the builder has not autosaved yet) = no stale check; the materialiser re-checks the base revision on apply.
      if (input.lock_token && !sameToken(computeLockToken(plan.id, plan.version, plan.head_revision_id), input.lock_token)) throw stale();
      const head = await this.prisma.workoutPlanRevision.findUnique({
        where: { id: plan.head_revision_id }, select: { revision_index: true, exercises_json: true, plan_meta_json: true },
      });
      if (!head) throw stale();
      baseline = snapshotFromRevisionJson(head.exercises_json, head.plan_meta_json);
      baseRevisionIndex = head.revision_index;
      if (plan.program_id && plan.week_index != null) {
        weekOther = await loadWeekOtherSetsByMuscle(this.prisma, { planId: plan.id, coachId: plan.coach_id, programId: plan.program_id, weekIndex: plan.week_index });
      }
    } else if (input.mode === 'edit' || !input.client_id) {
      throw new BadRequestException({ code: 'PLAN_REQUIRED', message: 'Open a workout first, or choose a client to build a new one for.' });
    }
    const capability = input.plan_id ? EDIT_WORKOUT_PLAN_CAPABILITY : CREATE_WORKOUT_PLAN_CAPABILITY;
    if (!this.config.resolve(capability).capabilityAllowed) {
      throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'Ask AI is not available yet. Your workouts are unchanged.' });
    }
    const client = input.client_id ? await this.loadClientContext(input.client_id) : null;
    const injuries: InjuryArea[] = [...new Set([...(client?.injuries ?? []), ...(input.injury_area ? [input.injury_area] : [])])];
    const screeningFlag = client?.screening_flag ?? false;
    const promptLibrary = [...LIBRARY.values()].filter((e) => contraindicatedAreas(e, injuries).length === 0);
    const explain = input.quick_action === 'explain';
    const promptClient = client ? { ...client, injuries } : injuries.length ? { ...NO_CLIENT, injuries } : null;
    const systemPrompt = buildWorkoutBuilderSystemPrompt({ mode: input.mode, quickAction: input.quick_action, library: promptLibrary, client: promptClient });
    let [lastDropped, outcome, draftId]: [Dropped, Outcome | null, string | null] = [[], null, null];
    for (let attempt = 0; attempt < 2 && !outcome; attempt++) {
      const first = buildWorkoutBuilderUserMessage(input.instruction, baseline);
      const userMessage = attempt === 0
        ? first : JSON.stringify({ previous_attempt_rejected: lastDropped.map((d) => d.reason).slice(0, 20), retry: JSON.parse(first) });
      const box: { validated: Outcome | null } = { validated: null };
      try {
        const result = await this.gateway.invoke({
          capability, requester, subjectUserId: input.client_id, tenantCoachId: tenantCoachId ?? planCoachId ?? undefined, userMessage, systemPrompt,
          maxTokens: explain ? MAX_TOKENS.explain : MAX_TOKENS[input.mode], ip: meta.ip ?? null, userAgent: meta.userAgent ?? null,
          resolveProposedAction: async (response, { providerFailed }) => {
            const isStub = response.provider === 'stub' && !providerFailed;
            if (providerFailed || !response.enabled) {
              if (!isStub || process.env.NODE_ENV === 'production') {
                throw new ServiceUnavailableException({ code: 'AI_NOT_CONFIGURED', message: 'Ask AI could not reach the model. Your workouts are unchanged. Try again in a minute.' });
              }
            }
            const output = isStub ? stubProposal(baseline, promptLibrary) : parseModelOutput(response.text);
            if (!output) throw new NoSafeProposal([{ reason: 'The reply was not a workout change.' }]);
            const summary = stripMedicalClaims(output.summary, TRAINING_BOUNDS.summaryMax) ||
              (explain ? 'No summary available for this workout.' : 'Suggested changes for this workout.');
            if (explain) {
              box.validated = { summary, changes: [], dropped: [] };
              return null;
            }
            const v = validateProposedChanges({
              baseline, rawChanges: output.changes, library: LIBRARY, injuries, instruction: input.instruction, screeningFlag, quickAction: input.quick_action,
              weekly: weekOther ? { otherSetsByMuscle: weekOther, cap: weeklySetsCap(client) } : undefined,
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
        code: 'AI_NO_SAFE_PROPOSAL', message: 'No safe change found for that request. Try: swap squats for a knee-friendly option.', dropped: lastDropped.slice(0, 20),
      });
    }

    const creditsCoach = tenantCoachId ?? planCoachId;
    const credits = creditsCoach ? (await this.status.getStatus(creditsCoach)).credits.remaining_pct : null;
    return { draft_id: draftId, ...outcome, context_used: contextUsed(client, injuries), screening_flag: screeningFlag, credits_remaining_pct: credits };
  }

  private async loadClientContext(clientId: string): Promise<WorkoutClientContext> {
    const select = { goal_type: true, workout_experience: true, equipment_access: true, workout_days_per_week: true, injuries: true };
    const [profile, intake] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { user_id: clientId }, select }),
      this.prisma.clientOnboardingIntake.findUnique({ where: { client_id: clientId }, select: { screening_any_yes: true } }),
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
}

const NO_CLIENT: WorkoutClientContext = { goal: null, experience: null, equipment: [], days_per_week: null, injuries: [], screening_flag: false };

export function contextUsed(client: WorkoutClientContext | null, injuries: readonly InjuryArea[]): string[] {
  const used: Array<[string, unknown]> = [
    ['exercise_library', true], ['current_workout', true], ['goal', client?.goal], ['experience', client?.experience],
    ['equipment', client?.equipment.length], ['schedule', client?.days_per_week], ['health_screening', client?.screening_flag], ['injuries', injuries.length],
  ];
  return used.filter(([, v]) => !!v).map(([k]) => k);
}
