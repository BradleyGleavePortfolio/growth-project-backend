// AIB-NAMES-127 — the AI workout builder knows the exercises in a workout built from search results (ExerciseDB ids, not
// seed ids): the model sees each row's name and muscle, and the injury screen and the per-workout / per-week set caps
// classify those rows by name and muscle. A row whose details do not load is flagged to the coach, never passed silently.
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma.service';
import { AiGatewayService } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import type { AiProviderResponse } from '../src/ai/gateway/providers/ai-provider.types';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ExerciseLibraryService } from '../src/exercise-library/exercise-library.service';
import type { Exercise } from '../src/exercise-library/exercise.entity';
import { ProposeInput, WorkoutBuilderAiService } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';
import { WorkoutBuilderStatusService } from '../src/ai/gateway/workout-builder/workout-builder-status.service';

const PLAN = '11111111-1111-4111-8111-111111111111';
const COACH = 'coach-1';
const coach = { id: COACH, role: 'coach' };
const cell = { weight_lbs: null, rest_seconds: 90, superset_group_id: null, notes: null };
const row = (client_ref: string, exercise_external_id: string, order: number, sets: number, reps = 8) =>
  ({ ...cell, client_ref, exercise_external_id, order, sets, reps_or_duration_seconds: reps });

const catalog = (id: string, name: string, target: string, bodyPart = 'upper legs'): Exercise =>
  ({ id, name, bodyPart, target, equipment: 'barbell', secondaryMuscles: [], instructions: [], gifUrl: '' });
const SQUAT = catalog('0043', 'barbell full squat', 'glutes');
const THRUST = catalog('3236', 'barbell glute bridge', 'glutes');
const BY_ID: Record<string, Exercise> = { [SQUAT.id]: SQUAT, [THRUST.id]: THRUST };

type Invoke = { userMessage: string; resolveProposedAction?: (r: AiProviderResponse, m: { providerFailed: boolean }) => Promise<unknown> };

async function build(opts: { rows: unknown[]; changes: unknown[]; lookup?: jest.Mock; program?: boolean; weekRows?: unknown[] }) {
  const lookup = opts.lookup ?? jest.fn(async (id: string) => {
    if (!BY_ID[id]) throw new Error('not found');
    return BY_ID[id];
  });
  const sent: string[] = [];
  const invoke = jest.fn(async (req: Invoke) => {
    sent.push(req.userMessage);
    const text = JSON.stringify({ summary: 'Suggested changes.', changes: opts.changes });
    const response: AiProviderResponse = { provider: 'anthropic', model: 'm', text, enabled: true, promptTokenEstimate: 1, responseTokenEstimate: 1 };
    await req.resolveProposedAction?.(response, { providerFailed: false });
    return { approvalDraftId: 'draft-1' };
  });
  const prisma = {
    workoutPlan: {
      findUnique: jest.fn(async () => ({
        id: PLAN, coach_id: COACH, version: 1, head_revision_id: 'rev-1', archived_at: null,
        program_id: opts.program ? 'prog-1' : null, week_index: opts.program ? 0 : null,
      })),
      findMany: jest.fn(async () => (opts.program ? [{ id: 'day-2', head_revision_id: 'rev-d2' }] : [])),
    },
    workoutPlanRevision: {
      findUnique: jest.fn(async () => ({ revision_index: 1, exercises_json: opts.rows, plan_meta_json: { name: 'Legs', type: 'strength' } })),
      findMany: jest.fn(async () => (opts.weekRows ? [{ exercises_json: opts.weekRows, plan_meta_json: { name: 'Legs B', type: 'strength' } }] : [])),
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
  return { svc: moduleRef.get(WorkoutBuilderAiService), lookup, sent };
}

const update = (client_ref: string, over: Record<string, unknown>) => ({ op: { kind: 'update_exercise', client_ref, ...over }, reason: 'Progress.' });
const edit = (over: Partial<ProposeInput> = {}): ProposeInput => ({ mode: 'edit', plan_id: PLAN, instruction: 'Progress this workout', ...over });
const sentRows = (sent: string[]) => (JSON.parse(sent[0]) as { workout: { rows: Array<Record<string, unknown>> } }).workout.rows;

describe('AI workout builder on rows from exercise search (AIB-NAMES-127)', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, FEATURE_MWB_AI_LIVE_CREATE: 'true', NODE_ENV: 'test' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('the model sees the name and muscle of a search-result row; a seed row is sent exactly as before', async () => {
    const { svc, sent } = await build({ rows: [row('r1', 'seed:push-001', 0, 3), row('r2', '0043', 1, 3)], changes: [update('r1', { rest_seconds: 120 })] });
    await svc.propose(coach, edit({ instruction: 'Swap squats for something knee-friendly' }));
    const [seedRow, searchRow] = sentRows(sent);
    expect(seedRow).toEqual({ client_ref: 'r1', exercise_external_id: 'seed:push-001', sets: 3, reps_or_duration_seconds: 8, weight_lbs: null, rest_seconds: 90 });
    expect(searchRow).toMatchObject({ client_ref: 'r2', exercise_external_id: '0043', name: 'Barbell full squat', muscle: 'glutes' });
  });

  it('caps the catalog name per row so the prompt cannot grow with long names', async () => {
    const long = catalog('9999', `barbell squat ${'x'.repeat(300)}`, 'quads');
    const lookup = jest.fn(async () => long);
    const { svc, sent } = await build({ rows: [row('r1', '9999', 0, 3)], changes: [update('r1', { rest_seconds: 120 })], lookup });
    await svc.propose(coach, edit());
    const name = sentRows(sent)[0].name;
    expect(typeof name).toBe('string');
    expect(String(name).length).toBeLessThanOrEqual(80);
  });

  it('a progression on a search-result squat is injury-screened by its name (knee)', async () => {
    const { svc } = await build({
      rows: [row('r1', 'seed:push-001', 0, 3), row('r2', '0043', 1, 3)],
      changes: [update('r2', { sets: 4 }), update('r1', { reps_or_duration_seconds: 9 })],
    });
    const res = await svc.propose(coach, edit({ injury_area: 'knee', quick_action: 'progress' }));
    expect(res.dropped).toEqual([{ reason: 'Barbell full squat loads the knee. The client reported knee issues.' }]);
    expect(res.changes.map((c) => c.op)).toEqual([expect.objectContaining({ client_ref: 'r1' })]);
  });

  it('the change card names the search-result exercise', async () => {
    const { svc } = await build({ rows: [row('r2', '0043', 0, 3)], changes: [update('r2', { rest_seconds: 120 })] });
    const res = await svc.propose(coach, edit());
    expect(res.changes[0].exercise).toMatchObject({ id: '0043', name: 'Barbell full squat' });
  });

  it('a row whose details do not load is flagged to the coach, not silently passed', async () => {
    const lookup = jest.fn(async () => { throw new Error('catalog unavailable'); });
    const { svc } = await build({ rows: [row('r2', '0043', 0, 3)], changes: [update('r2', { sets: 4 })], lookup });
    const res = await svc.propose(coach, edit({ injury_area: 'knee', quick_action: 'progress' }));
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].warnings).toEqual(['The exercise details did not load, so it was not checked for the knee. Check it suits the client.']);
  });

  it('the per-workout muscle cap counts search-result rows', async () => {
    const { svc } = await build({
      rows: [row('r1', '0043', 0, 6), row('r2', '3236', 1, 6), row('r3', 'seed:push-001', 2, 3)],
      changes: [update('r2', { sets: 7 }), update('r3', { rest_seconds: 120 })],
    });
    const res = await svc.propose(coach, edit({ instruction: 'More glute work' }));
    expect(res.dropped).toEqual([{ reason: 'More than 12 hard sets for one muscle in a workout.' }]);
    expect(res.changes.map((c) => c.op)).toEqual([expect.objectContaining({ client_ref: 'r3' })]);
  });

  it("the program-week cap counts search-result rows on the week's other days", async () => {
    const { svc, lookup } = await build({
      program: true,
      rows: [row('r1', '0043', 0, 3), row('r2', 'seed:push-001', 1, 3)],
      weekRows: [row('x1', '0043', 0, 10), row('x2', '3236', 1, 10)],
      changes: [update('r1', { sets: 5 }), update('r2', { rest_seconds: 120 })],
    });
    const res = await svc.propose(coach, edit({ instruction: 'More squat volume' }));
    // glutes: this day 3 + other day 20 = 23; 5 sets would make 25, over the general weekly cap of 24.
    expect(res.dropped).toEqual([{ reason: 'More than 24 hard sets for one muscle in this program week.' }]);
    expect(res.changes.map((c) => c.op)).toEqual([expect.objectContaining({ client_ref: 'r2' })]);
    expect(lookup.mock.calls.map(([id]) => id).sort()).toEqual(['0043', '3236']);
  });

  it('a seed-only workout makes no catalog read', async () => {
    const { svc, lookup, sent } = await build({ rows: [row('r1', 'seed:legs-001', 0, 3)], changes: [update('r1', { rest_seconds: 120 })] });
    await svc.propose(coach, edit());
    expect(lookup).not.toHaveBeenCalled();
    expect(Object.keys(sentRows(sent)[0])).toEqual(['client_ref', 'exercise_external_id', 'sets', 'reps_or_duration_seconds', 'weight_lbs', 'rest_seconds']);
  });
});
