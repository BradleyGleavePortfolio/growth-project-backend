// AIB-INJ-128 — when a coach sets an injury area, injury-risky seed exercises leave the LIBRARY the model may ADD from.
// A row already in the workout (a squat for a knee) must still reach the model by name and muscle, so "swap squats for
// something knee-friendly" works. The LIBRARY stays filtered; without an injury the user turn is byte-identical.
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import type { AiProviderResponse } from '../src/ai/gateway/providers/ai-provider.types';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ExerciseLibraryService } from '../src/exercise-library/exercise-library.service';
import { ProposeInput, WorkoutBuilderAiService } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';
import { WorkoutBuilderStatusService } from '../src/ai/gateway/workout-builder/workout-builder-status.service';
import { buildWorkoutBuilderUserMessage } from '../src/ai/gateway/workout-builder/workout-builder-prompt';
import { snapshotFromRevisionJson } from '../src/ai/gateway/materialisers/__shared/workout-diff.types';

const PLAN = '11111111-1111-4111-8111-111111111111';
const COACH = 'coach-1';
const META = { name: 'Legs', type: 'strength' };
const coach = { id: COACH, role: 'coach' };
const row = (client_ref: string, exercise_external_id: string, order: number) =>
  ({ weight_lbs: null, rest_seconds: 90, superset_group_id: null, notes: null, client_ref, exercise_external_id, order, sets: 3, reps_or_duration_seconds: 8 });

type Invoke = { userMessage: string; systemPrompt: string; resolveProposedAction?: (r: AiProviderResponse, m: { providerFailed: boolean }) => Promise<unknown> };

async function build(rows: unknown[]) {
  const lookup = jest.fn(async () => { throw new Error('not found'); });
  const sent: Invoke[] = [];
  const invoke = jest.fn(async (req: Invoke) => {
    sent.push(req);
    const changes = [{ op: { kind: 'update_exercise', client_ref: 'r2', rest_seconds: 120 }, reason: 'More rest.' }];
    const text = JSON.stringify({ summary: 'Suggested changes.', changes });
    const response: AiProviderResponse = { provider: 'anthropic', model: 'm', text, enabled: true, promptTokenEstimate: 1, responseTokenEstimate: 1 };
    await req.resolveProposedAction?.(response, { providerFailed: false });
    return { approvalDraftId: 'draft-1' };
  });
  const prisma = {
    workoutPlan: {
      findUnique: jest.fn(async () => ({ id: PLAN, coach_id: COACH, version: 1, head_revision_id: 'rev-1', archived_at: null, program_id: null, week_index: null })),
      findMany: jest.fn(async () => []),
    },
    workoutPlanRevision: {
      findUnique: jest.fn(async () => ({ revision_index: 1, exercises_json: rows, plan_meta_json: META })),
      findMany: jest.fn(async () => []),
    },
    workoutPlanExercise: { findMany: jest.fn(async () => []) },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkoutBuilderAiService,
      { provide: PrismaService, useValue: prisma },
      { provide: AiGatewayService, useValue: { invoke } },
      { provide: AiGatewayConfig, useValue: { resolve: () => ({ capabilityAllowed: true }) } },
      { provide: SubCoachScopeService, useValue: { getHeadCoachIdForSubCoach: async () => null, canAccessClient: async () => true } },
      { provide: WorkoutBuilderStatusService, useValue: { getStatus: async () => ({ credits: { remaining_pct: 50 } }) } },
      { provide: ExerciseLibraryService, useValue: { getExerciseById: lookup } },
    ],
  }).compile();
  return { svc: moduleRef.get(WorkoutBuilderAiService), sent, lookup };
}

const edit = (over: Partial<ProposeInput> = {}): ProposeInput =>
  ({ mode: 'edit', plan_id: PLAN, instruction: 'Swap squats for something knee-friendly', ...over });
const rowsOf = (req: Invoke) => (JSON.parse(req.userMessage) as { workout: { rows: Array<Record<string, unknown>> } }).workout.rows;
const ROWS = [row('r1', 'seed:legs-001', 0), row('r2', 'seed:push-001', 1)];

describe('AI builder sees injury-filtered exercises already in the workout (AIB-INJ-128)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, FEATURE_MWB_AI_LIVE_CREATE: 'true', NODE_ENV: 'test' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('a seed squat in the workout reaches the model by name and muscle when the coach sets a knee injury', async () => {
    const { svc, sent, lookup } = await build(ROWS);
    await svc.propose(coach, edit({ injury_area: 'knee' }));
    const [squat, bench] = rowsOf(sent[0]);
    expect(squat).toEqual({
      client_ref: 'r1', exercise_external_id: 'seed:legs-001', sets: 3, reps_or_duration_seconds: 8, weight_lbs: null, rest_seconds: 90,
      name: 'Back Squat', muscle: 'quads',
    });
    // The bench press is still in LIBRARY, so its row is sent exactly as before.
    expect(Object.keys(bench)).toEqual(['client_ref', 'exercise_external_id', 'sets', 'reps_or_duration_seconds', 'weight_lbs', 'rest_seconds']);
    // Seed rows never need a catalog read.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('the exercises the model may add stay filtered: the squat is not in LIBRARY', async () => {
    const { svc, sent } = await build(ROWS);
    await svc.propose(coach, edit({ injury_area: 'knee' }));
    const library = sent[0].systemPrompt.split('\n').find((l) => l.startsWith('LIBRARY'));
    expect(library).toContain('seed:push-001 | Barbell Bench Press');
    expect(library).not.toContain('seed:legs-001');
  });

  it('without an injury the user turn is byte-identical to before (seed rows as ids only)', async () => {
    const { svc, sent } = await build(ROWS);
    await svc.propose(coach, edit());
    const before = snapshotFromRevisionJson(ROWS, META);
    expect(sent[0].userMessage).toBe(buildWorkoutBuilderUserMessage('Swap squats for something knee-friendly', before));
    expect(rowsOf(sent[0]).every((r) => !('name' in r))).toBe(true);
  });
});
