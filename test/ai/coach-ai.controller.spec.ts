// Coach AI controller — integration-ish tests against the service with
// mocked Anthropic, ClientContext, MealPlans, and WorkoutBuilder
// services. Covers:
//   - happy-path generation for each of the 3 surfaces
//   - 503 when CoachAIStateService.isReady() returns false
//   - 404 when the coach does not own the target client
//   - approval flow materializes downstream rows for WORKOUT_PROGRAM
//     and MEAL_PLAN, no-op for INSIGHT.

import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CoachAIService } from '../../src/ai/coach/coach-ai.service';
import { CoachAIStateService } from '../../src/ai/coach/coach-ai-state.service';

function makeFixtures() {
  const drafts: any[] = [];
  const prisma = {
    user: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        // Only `coach1` owns `client1`.
        if (where.id === 'client1' && where.coach_id === 'coach1') return { id: 'client1' };
        return null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aIDraft: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `draft-${drafts.length + 1}`,
          status: 'DRAFT',
          ...data,
        };
        drafts.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => drafts.find((d) => d.id === where.id) || null),
      update: jest.fn(async ({ where, data }: any) => {
        const i = drafts.findIndex((d) => d.id === where.id);
        if (i < 0) throw new Error('not found');
        drafts[i] = { ...drafts[i], ...data };
        return drafts[i];
      }),
    },
  } as any;

  const stateImpl = {
    _ready: true as boolean,
    isReady(): boolean {
      return stateImpl._ready;
    },
    getStatus() {
      return { ready: stateImpl._ready };
    },
  };
  const state: CoachAIStateService & { _ready: boolean } =
    stateImpl as unknown as CoachAIStateService & { _ready: boolean };

  const anthropic = {
    completeStructured: jest.fn(),
  } as any;

  const fixtureContext = {
    client_id: 'client1',
    identity: { first_name: 'Jane', age_years: 35, sex: 'female' },
    profile: {
      height_cm: 165,
      current_weight_lbs: 150,
      target_weight_lbs: 140,
      goal_type: 'fat_loss',
      activity_level: 'moderate',
      workout_experience: 'intermediate',
      has_gym_membership: true,
      preferred_snacks: [],
      dietary_pattern: null,
      dietary_restrictions: [],
      workout_days_per_week: 4,
      meals_per_day: 4,
      equipment_access: ['dumbbells'],
      bio: null,
      injuries: [],
      food_preferences: null,
      preferred_training_time: null,
    },
    prescribed: {
      calories: 1800,
      protein_g: 140,
      carbs_g: 180,
      fat_g: 60,
      fiber_g: 25,
      meals_per_day: 4,
      water_ml: 2000,
      effective_from: null,
    },
    today: {
      date: '2026-05-13',
      calories: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      remaining_calories: 1800,
      remaining_protein_g: 140,
      pct_calories: 0,
    },
    weight_trend_90d: [],
    recent_workout_assignments: [],
    food_log_totals_last_7d: {
      days_logged: 0,
      avg_calories: 0,
      avg_protein_g: 0,
      avg_carbs_g: 0,
      avg_fat_g: 0,
    },
    recent_check_ins: [],
    coach: {
      coach_id: 'coach1',
      coach_name: 'Sasha',
      has_coach: true,
      last_coach_message_excerpt: null,
    },
    generated_at: '2026-05-13T12:00:00.000Z',
  };
  const ctxSvc = {
    build: jest.fn().mockResolvedValue(fixtureContext),
  } as any;

  const mealPlans = {
    createForClient: jest.fn().mockResolvedValue({ id: 'mp-1' }),
  } as any;

  const workouts = {
    createPlan: jest.fn().mockResolvedValue({ id: 'wp-1' }),
    setExercises: jest.fn().mockResolvedValue([]),
  } as any;

  const svc = new CoachAIService(prisma, state, anthropic, ctxSvc, mealPlans, workouts);
  return { svc, state, anthropic, prisma, mealPlans, workouts, drafts };
}

describe('CoachAIService', () => {
  it('returns 503 when state.isReady() is false', async () => {
    const f = makeFixtures();
    (f.state as any)._ready = false;
    await expect(
      f.svc.generateWorkoutProgram('coach1', {
        clientId: 'client1',
        weeks: 4,
        daysPerWeek: 4,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 404 when the coach does not own the client', async () => {
    const f = makeFixtures();
    await expect(
      f.svc.generateMealPlan('coach1', { clientId: 'foreign', days: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('generates a workout program draft on happy path', async () => {
    const f = makeFixtures();
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: 'Hypertrophy block',
        weeks: 4,
        days_per_week: 4,
        days: [
          {
            week: 1,
            day: 1,
            name: 'Upper A',
            type: 'strength',
            duration_estimate_minutes: 60,
            exercises: [
              {
                exercise_external_id: 'barbell-bench-press',
                name: 'Barbell Bench Press',
                order: 1,
                sets: 4,
                reps_or_duration_seconds: 8,
              },
            ],
          },
        ],
        coach_notes: 'progress by ~5lb/wk',
      },
      tokensIn: 500,
      tokensOut: 300,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 1234,
    });
    const result = await f.svc.generateWorkoutProgram('coach1', {
      clientId: 'client1',
      weeks: 4,
      daysPerWeek: 4,
    });
    expect(result.draftId).toBe('draft-1');
    expect(result.payload.weeks).toBe(4);
    expect(f.drafts[0].type).toBe('WORKOUT_PROGRAM');
  });

  it('approve flow materializes WorkoutPlan + exercises', async () => {
    const f = makeFixtures();
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: 'Hypertrophy block',
        weeks: 4,
        days_per_week: 4,
        days: [
          {
            week: 1,
            day: 1,
            name: 'Upper A',
            type: 'strength',
            duration_estimate_minutes: 60,
            exercises: [
              { exercise_external_id: 'bench', name: 'Bench', order: 1, sets: 4, reps_or_duration_seconds: 8 },
            ],
          },
        ],
        coach_notes: '',
      },
      tokensIn: 100,
      tokensOut: 100,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 100,
    });
    const { draftId } = await f.svc.generateWorkoutProgram('coach1', {
      clientId: 'client1',
      weeks: 4,
      daysPerWeek: 4,
    });
    const approved = await f.svc.approveDraft('coach1', draftId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAsId).toBe('wp-1');
    expect(f.workouts.createPlan).toHaveBeenCalledTimes(1);
    expect(f.workouts.setExercises).toHaveBeenCalledTimes(1);
  });

  it('approve flow on a MEAL_PLAN draft materializes a MealPlan', async () => {
    const f = makeFixtures();
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: 'Cut plan',
        days: [
          {
            day: 1,
            meals: [
              {
                slot: 'breakfast',
                items: [
                  { name: 'Oats', serving: '1 cup', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 },
                ],
              },
            ],
            daily_totals: { calories: 1800, protein_g: 140, carbs_g: 180, fat_g: 60 },
          },
        ],
        coach_notes: 'swap protein source if needed',
      },
      tokensIn: 100,
      tokensOut: 100,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 100,
    });
    const { draftId } = await f.svc.generateMealPlan('coach1', {
      clientId: 'client1',
      days: 1,
    });
    const approved = await f.svc.approveDraft('coach1', draftId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAsId).toBe('mp-1');
    expect(f.mealPlans.createForClient).toHaveBeenCalledTimes(1);
  });

  it('approve flow on INSIGHT draft does not materialize but flips status', async () => {
    const f = makeFixtures();
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: 'doing well',
        wins: ['hit protein'],
        concerns: [],
        suggested_actions: [],
        questions_for_coach: [],
      },
      tokensIn: 50,
      tokensOut: 50,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 100,
    });
    const { draftId } = await f.svc.generateClientInsight('coach1', { clientId: 'client1' });
    const approved = await f.svc.approveDraft('coach1', draftId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAsId).toBeNull();
    expect(f.workouts.createPlan).not.toHaveBeenCalled();
    expect(f.mealPlans.createForClient).not.toHaveBeenCalled();
  });

  it('reject flow flips status to REJECTED with reason', async () => {
    const f = makeFixtures();
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: '',
        wins: [],
        concerns: [],
        suggested_actions: [],
        questions_for_coach: [],
      },
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 1,
    });
    const { draftId } = await f.svc.generateClientInsight('coach1', { clientId: 'client1' });
    const rejected = await f.svc.rejectDraft('coach1', draftId, 'not useful');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('not useful');
  });
});
