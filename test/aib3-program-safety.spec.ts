// B-AIB3-126 — substitutions, hard bounds and minimisation on the per-client program generator, the minimised gateway block
// for the workout capabilities, and the box-2 consent gate (unchanged, asserted).
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { PrivateContextService } from '../src/ai/gateway/private-context.service';
import { AiConsentRequiredException } from '../src/ai-egress/ai-consent-required.exception';
import { clientDataSubject, type AiDataSubject, type AiEgressSurface } from '../src/ai-egress/ai-egress.types';
import type { WorkoutContextService, WorkoutContextV2 } from '../src/ai/context/workout-context.service';
import { substituteFor, toInjuryAreas } from '../src/ai/gateway/workout-builder/training-substitutions';
import { egressWithGrants, fakeOf } from './ai-egress/ai-egress.fakes';

describe('B-AIB3-126 — substitution table', () => {
  it.each<[string[], string, string]>([
    [['knee'], 'Barbell Back Squat', 'Hip Thrust'],
    [['knee'], 'Leg Extension', 'Leg Curl'],
    [['knee', 'ankle_foot'], 'Burpee', 'Stationary Bike'],
    [['lower_back'], 'Deadlift', 'Hip Thrust'],
    [['shoulder'], 'Overhead Press', 'Incline Dumbbell Press'],
    [['shoulder'], 'Dip', 'Triceps Pushdown'],
    [['elbow_wrist'], 'Barbell Curl', 'Dumbbell Hammer Curl'],
    [['ankle_foot'], 'Treadmill Run', 'Stationary Bike'],
  ])('%j: %s -> %s', (areas, from, to) => {
    expect(substituteFor({ id: 'x', name: from }, toInjuryAreas(areas))?.name).toBe(to);
  });

  it('a swap never lands on a movement that loads another listed area; `other` never auto-swaps', () => {
    expect(substituteFor({ id: 'x', name: 'Back Squat' }, ['knee', 'lower_back', 'hip'])?.name).toBe('Hip Thrust');
    expect(substituteFor({ id: 'x', name: 'Back Squat' }, ['other'])).toBeNull();
  });
});

const CTX = {
  identity: { first_name: 'Jane', age_years: 35, sex: 'female' },
  profile: {
    goal_type: 'muscle_gain', activity_level: 'moderate', workout_experience: 'beginner', has_gym_membership: true,
    workout_days_per_week: 3, equipment_access: ['dumbbells'], preferred_training_time: 'AM', injuries: ['left knee'],
    preferred_snacks: ['greek yogurt'], bio: 'Mum of two', current_weight_lbs: 150, height_cm: 165,
  },
  recent_workout_assignments: [{ date: '2026-10-01', completed_at: null, post_rpe: null, post_notes: 'my knee hurt', plan_name: 'A', plan_type: 'strength' }],
  coach: { has_coach: true },
  prescribed: { calories: null, protein_g: null },
};

const WCTX: WorkoutContextV2 = { coach_style: null, client: {
  goal: 'muscle_gain', experience: 'beginner', equipment: ['dumbbells'], days_per_week: 3, injuries: ['knee'], screening_flag: true,
  history_6w: [{ id: 'seed:pull-002', last_weight_lbs: 100, last_reps: 10, best_e1rm_lbs: 133.3, sessions: 3 }], adherence_pct_4w: 80, check_ins: [],
} };

const row = (id: string, name: string, sets: number, weight: number, rest: number) =>
  ({ exercise_external_id: id, name, order: 1, sets, reps_or_duration_seconds: 8, weight_lbs: weight, rest_seconds: rest, notes: null });
const generated = () => ({
  summary: 'Block', weeks: 1, days_per_week: 1, coach_notes: 'Progress weekly.',
  days: [{ week: 1, day: 1, name: 'Lower', type: 'strength', exercises: [
    row('barbell-back-squat', 'Barbell Back Squat', 40, 315, 2_000), row('seed:pull-002', 'Lat Pulldown', 3, 120, 90), row('db-curl', 'Dumbbell Curl', 3, 30, 60),
    row('lunge', 'Walking Lunge', 3, 50, 60),
  ] }],
});

function buildGenerator(granted: string[] = ['client1']) {
  const { egress } = egressWithGrants(granted);
  const completeStructured = jest.fn(async (_p: { system: string; user: string }, _v: unknown, opts: { dataSubject: AiDataSubject; surface: AiEgressSurface }) => {
    await egress.assertMaySend(opts.dataSubject, 'anthropic', opts.surface);
    return { data: generated(), tokensIn: 1, tokensOut: 1, modelUsed: 'm', latencyMs: 1 };
  });
  const create = jest.fn(async (_args: { data: { generatedPayload: ReturnType<typeof generated> } }) => ({ id: 'draft-1' }));
  const build = jest.fn(async () => WCTX);
  const svc = new CoachAIService(
    fakeOf({ aIDraft: { create } }), fakeOf({ isReady: () => true }), fakeOf({ completeStructured }), fakeOf({ build: jest.fn(async () => CTX) }),
    fakeOf({}), fakeOf({ assertCanAccessClient: jest.fn(async () => undefined) }), undefined, fakeOf<WorkoutContextService>({ build }),
  );
  return { svc, completeStructured, create, build };
}

describe('B-AIB3-126 — per-client program generator', () => {
  it('prompt carries injury areas, substitutions, bounds and context v2, and no name, snacks, bio, weight or client notes', async () => {
    const { svc, completeStructured, build } = buildGenerator();
    await svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1 });
    expect(build).toHaveBeenCalledWith({ coachId: 'coach1', clientId: 'client1' });
    const { user, system } = completeStructured.mock.calls[0][0];
    expect(user).toContain('injury_areas: knee');
    expect(user).toContain('substitution: knee: avoid loaded deep knee flexion');
    expect(user).toContain('hard_limits: sets 1-10; reps 1-30');
    expect(user).toContain('health_screening:');
    expect(user).toContain('"history_6w":[{"id":"seed:pull-002"');
    for (const banned of ['Jane', 'greek yogurt', 'Mum of two', '"current_weight_lbs"', '"height_cm"', 'my knee hurt', 'client1']) {
      expect(user).not.toContain(banned);
    }
    expect(system).toContain('injury_areas');
  });

  it('a generated knee-loading exercise is replaced by a substitution and every row is held to the bounds', async () => {
    const { svc, create } = buildGenerator();
    const out = await svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1 });
    const [squat, pulldown, curl, lunge] = create.mock.calls[0][0].data.generatedPayload.days[0].exercises;
    expect(lunge.name).toBe('Romanian Deadlift'); // a second knee swap in the same day takes the next option
    expect(squat).toMatchObject({ exercise_external_id: 'seed:legs-007', name: 'Hip Thrust', sets: 10, rest_seconds: 600, weight_lbs: null });
    expect(squat.notes).toBe('Swapped from Barbell Back Squat for the knee limitation.');
    expect(pulldown.weight_lbs).toBe(105); // logged 100 lb -> at most 105%
    expect(curl.weight_lbs).toBeNull(); // never logged -> the coach fills the load
    expect(out.payload.days[0].exercises[0].name).toBe('Hip Thrust');
  });

  it('keeps an exercise only on a clear positive keep request, and tells the coach', async () => {
    const { svc, create } = buildGenerator();
    await svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1, notes: 'Keep the barbell back squat, light.' });
    const payload = create.mock.calls[0][0].data.generatedPayload;
    expect(payload.days[0].exercises[0].name).toBe('Barbell Back Squat');
    expect(payload.coach_notes).toContain("Kept at the coach's request despite the client's limitations: Barbell Back Squat (knee).");
  });

  it.each([
    'Avoid Barbell Back Squat',
    'No barbell back squat please',
    "Don't keep the barbell back squat",
    'Barbell back squat felt heavy',
    'Keep Barbell Back Squat out of this plan',
    'Want an alternative to Barbell Back Squat',
    'Keep the barbell back squat off the program, his knee is sore',
    'Don\u2019t include Barbell Back Squat',
    "She doesn't want Barbell Back Squat",
    'He can\u2019t use the Barbell Back Squat',
  ])('a negative, an alternative request or a mention never exempts the injury filter: %s', async (notes) => {
    const { svc, create } = buildGenerator();
    await svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1, notes });
    const payload = create.mock.calls[0][0].data.generatedPayload;
    expect(payload.days[0].exercises[0].name).toBe('Hip Thrust');
    expect(payload.days[0].exercises[0].notes).toBe('Swapped from Barbell Back Squat for the knee limitation.');
    expect(String(payload.coach_notes ?? '')).not.toContain("Kept at the coach's request");
  });

  it('box-2 consent gate unchanged: the client is the data subject; no grant -> 403 and no draft', async () => {
    const ok = buildGenerator();
    await ok.svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1 });
    expect(ok.completeStructured.mock.calls[0][2].dataSubject).toEqual(clientDataSubject('client1', 'coach'));
    const denied = buildGenerator([]);
    const call = denied.svc.generateWorkoutProgram('coach1', { clientId: 'client1', weeks: 1, daysPerWeek: 1 });
    await expect(call).rejects.toBeInstanceOf(AiConsentRequiredException);
    expect(denied.create).not.toHaveBeenCalled();
  });
});

describe('B-AIB3-126 — gateway context for the workout capabilities', () => {
  const subject = {
    id: 'client-1', name: 'Brad Smith', role: 'student', coach_id: 'coach-1',
    profile: { id: 'p-1', goal_type: 'fat_loss', activity_level: 'active', workout_experience: 'intermediate', current_weight_lbs: 192,
      target_weight_lbs: 178, height_cm: 183, preferred_snacks: ['cottage cheese'], equipment_access: ['barbell'], workout_days_per_week: 4, injuries: ['knee'] },
    coach_messages_as_client: [{ id: 'm-1', body: 'Stay strict on dinner carbs.' }],
  };
  const svcWith = () => {
    const findUnique = jest.fn(async () => subject);
    return { findUnique, svc: new PrivateContextService(fakeOf({ user: { findUnique } })) };
  };

  it.each(['draft.create_workout_plan', 'draft.edit_workout_plan'])('%s: no name, weight, height, snacks or message', async (capability) => {
    const { svc, findUnique } = svcWith();
    const ctx = await svc.loadClientContext({ id: 'coach-1', role: 'coach' }, 'client-1', { capability });
    for (const banned of ['Brad', 'cottage cheese', 'Stay strict', '192', '178', '183', 'preferred_snacks', 'last_coach_message']) {
      expect(ctx.systemPrompt).not.toContain(banned);
    }
    expect(ctx.systemPrompt).toMatch(/"injuries": \[\s*"knee"/);
    expect(ctx.provenance.map((p) => p.source)).toEqual(['user', 'user_profile']);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ coach_messages_as_client: expect.objectContaining({ take: 0 }) }) }));
  });

  it('other capabilities keep the existing block; tenancy unchanged', async () => {
    const { svc } = svcWith();
    const ctx = await svc.loadClientContext({ id: 'coach-1', role: 'coach' }, 'client-1', { capability: 'chat.client_self' });
    expect(ctx.systemPrompt).toContain('cottage cheese');
    const other = svc.loadClientContext({ id: 'coach-2', role: 'coach' }, 'client-1', { capability: 'draft.edit_workout_plan' });
    await expect(other).rejects.toThrow('Caller is not permitted');
  });
});
