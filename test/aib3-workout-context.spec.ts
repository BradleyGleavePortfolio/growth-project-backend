// B-AIB3-126 — workout context v2 (plan sections 1, 6): signals present, no name / snacks / messages / client-typed text;
// recovery only with an active wearable connection; coach style only from the coach's own plans.
import { WorkoutContextService, contextUsedKeys, historyFromSessions } from '../src/ai/context/workout-context.service';
import type { PrismaService } from '../src/prisma.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-06T18:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const PLANS = [
  { coach_id: 'coach-1', exercises: [
    { exercise_external_id: 'seed:legs-007', sets: 4, reps_or_duration_seconds: 8, rest_seconds: 120, superset_group_id: null },
    { exercise_external_id: 'seed:legs-008', sets: 3, reps_or_duration_seconds: 12, rest_seconds: 60, superset_group_id: 'a' },
  ] },
  { coach_id: 'coach-2', exercises: [
    { exercise_external_id: 'seed:other-coach-only', sets: 9, reps_or_duration_seconds: 3, rest_seconds: 300, superset_group_id: null },
  ] },
];

function prismaDouble(opts: { wearable: boolean }) {
  return {
    userProfile: { findUnique: jest.fn(async () => ({
      goal_type: 'muscle_gain', workout_experience: 'beginner', workout_days_per_week: 3, preferred_snacks: ['cottage cheese'],
      equipment_access: ['dumbbells', 'My garage rack!! call me 555-0100'], injuries: ['knee', 'sore left shoulder'],
    })) },
    clientOnboardingIntake: { findUnique: jest.fn(async () => ({ screening_any_yes: true })) },
    workoutSession: { findMany: jest.fn(async () => [
      { id: 's2', exercises: [{ exercise_name: 'Back Squat', reps_per_set: [5, 5], weight_per_set: [185, 195] }, { exercise_name: 'Grandma Jane secret move', reps_per_set: [10], weight_per_set: [20] }] },
      { id: 's1', exercises: [{ exercise_name: 'back squat', reps_per_set: [8], weight_per_set: [225] }] },
    ]) },
    clientWorkoutAssignment: { findMany: jest.fn(async () => [
      { completed_at: daysAgo(1) }, { completed_at: null }, { completed_at: daysAgo(8) }, { completed_at: daysAgo(15) },
    ]) },
    checkIn: { findMany: jest.fn(async () => [{ energy: 4, soreness: 2, sleep_hours: 7.5 }, { energy: 3, soreness: 3, sleep_hours: null }]) },
    wearableConnection: { findFirst: jest.fn(async () => (opts.wearable ? { id: 'w-1' } : null)) },
    wearableSample: { findMany: jest.fn(async () => ([
      ['SLEEP_TOTAL_MIN', 420, 1], ['SLEEP_TOTAL_MIN', 300, 1], ['SLEEP_TOTAL_MIN', 480, 2], ['RESTING_HEART_RATE_BPM', 66, 2],
      ['RESTING_HEART_RATE_BPM', 58, 12], ['HRV_MS', 50, 3], ['HRV_MS', 50.5, 10],
    ] as const).map(([metric, value, d]) => ({ metric, value, start_at: daysAgo(d) }))) },
    // Mirrors the database: only rows matching the where clause come back.
    workoutPlan: { findMany: jest.fn(async (args: { where: { coach_id: string } }) => PLANS.filter((p) => p.coach_id === args.where.coach_id)) },
  };
}

function build(opts: { wearable: boolean }) {
  const prisma = prismaDouble(opts);
  const svc = new WorkoutContextService(fakeOf<PrismaService>(prisma));
  return { prisma, svc };
}

describe('B-AIB3-126 — workout context v2', () => {
  it('snapshot: injuries, history, adherence, check-ins and recovery; no name, snacks, message or free text', async () => {
    const { svc } = build({ wearable: true });
    const ctx = await svc.build({ coachId: 'coach-1', clientId: 'client-1', now: NOW });
    expect(Object.keys(ctx.client ?? {}).sort()).toEqual([
      'adherence_pct_4w', 'check_ins', 'days_per_week', 'equipment', 'experience', 'goal', 'history_6w', 'injuries', 'recovery',
      'screening_flag',
    ]);
    expect(ctx.client).toMatchObject({
      injuries: ['knee', 'shoulder'],
      screening_flag: true,
      equipment: ['dumbbells'],
      adherence_pct_4w: 75,
      check_ins: [{ energy: 4, soreness: 2, sleep_hours: 7.5 }, { energy: 3, soreness: 3, sleep_hours: null }],
      history_6w: [{ id: 'seed:legs-001', last_weight_lbs: 195, last_reps: 5, best_e1rm_lbs: 285, sessions: 2 }],
      recovery: { sleep_hours_avg_7d: 7.5, resting_hr_trend: 'up', hrv_trend: 'flat' },
    });
    const json = JSON.stringify(ctx);
    for (const banned of ['snack', 'cottage', 'message', 'name', 'Jane', 'garage', '555', 'client-1', 'notes']) {
      expect(json).not.toContain(banned);
    }
    expect(contextUsedKeys(ctx)).toEqual([
      'goal', 'experience', 'equipment', 'schedule', 'injuries', 'health_screening', 'training_history', 'adherence', 'check_ins',
      'recovery', 'coach_style',
    ]);
  });

  it('recovery is absent without an active wearable connection, and samples are never read', async () => {
    const { svc, prisma } = build({ wearable: false });
    const ctx = await svc.build({ coachId: 'coach-1', clientId: 'client-1', now: NOW });
    expect(ctx.client && 'recovery' in ctx.client).toBe(false);
    expect(prisma.wearableSample.findMany).not.toHaveBeenCalled();
    expect(prisma.wearableConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'client-1', status: 'connected', disconnected_at: null } }),
    );
  });

  it("coach style uses only the coach's own plans and no client data", async () => {
    const { svc, prisma } = build({ wearable: false });
    const ctx = await svc.build({ coachId: 'coach-1', now: NOW });
    expect(ctx.client).toBeNull();
    expect(prisma.userProfile.findUnique).not.toHaveBeenCalled();
    expect(prisma.workoutPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { coach_id: 'coach-1', archived_at: null } }));
    expect(ctx.coach_style).toEqual({
      plans: 1,
      rep_range_pct: { low_1_5: 0, mid_6_12: 100, high_13_30: 0, timed: 0 },
      median_sets: 3.5,
      median_rest_seconds: 90,
      top_exercise_ids: ['seed:legs-007', 'seed:legs-008'],
      split: 'mixed',
      superset_rate_pct: 50,
    });
    expect(JSON.stringify(ctx)).not.toContain('other-coach-only');
  });

  it('history keeps at most 30 library ids and skips unknown names', () => {
    const sessions = [{ id: 's', exercises: [{ exercise_name: 'Plank', reps_per_set: [1], weight_per_set: [0] }, { exercise_name: 'x', reps_per_set: [5], weight_per_set: [100] }] }];
    expect(historyFromSessions(sessions)).toEqual([{ id: 'seed:core-001', last_weight_lbs: null, last_reps: null, best_e1rm_lbs: null, sessions: 1 }]);
    expect(historyFromSessions(sessions, 0)).toEqual([]);
  });
});
