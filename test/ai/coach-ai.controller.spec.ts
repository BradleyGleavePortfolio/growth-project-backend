// Coach AI controller — integration-ish tests against the service with
// mocked Anthropic, ClientContext, MealPlans, and WorkoutBuilder
// services. Covers:
//   - happy-path generation for each of the 3 surfaces
//   - 503 when CoachAIStateService.isReady() returns false
//   - 404 when the coach does not own the target client
//   - approval flow materializes downstream rows for WORKOUT_PROGRAM
//     and MEAL_PLAN, no-op for INSIGHT.

import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // No stored time zone for client1 (approve then schedules in UTC).
    notificationPreferences: { findUnique: jest.fn().mockResolvedValue(null) },
    coachProfile: { findUnique: jest.fn().mockResolvedValue(null) },
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
      findMany: jest.fn(async ({ where }: any) =>
        drafts.filter((d) => d.coachId === where.coachId && d.status === where.status),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const i = drafts.findIndex((d) => d.id === where.id);
        if (i < 0) throw new Error('not found');
        drafts[i] = { ...drafts[i], ...data };
        return drafts[i];
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        drafts.forEach((d, i) => {
          if (d.id !== where.id) return;
          if (where.coachId !== undefined && d.coachId !== where.coachId) return;
          if (where.status !== undefined && d.status !== where.status) return;
          if (where.approvedAsId !== undefined && (d.approvedAsId ?? null) !== where.approvedAsId) return;
          drafts[i] = { ...d, ...data };
          count += 1;
        });
        return { count };
      }),
    },
  } as any;
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));

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
    writePlanAssignmentsInTx: jest.fn(
      async (_tx: unknown, _coach: string, _client: string, plans: Array<{ id: string }>) =>
        plans.map((_p, i) => ({ id: `cwa-${i + 1}` })),
    ),
    notifyProgramAssigned: jest.fn(),
    // MWB-1 (§7.2): CoachAIService now delegates its client gate to
    // WorkoutBuilderService.assertCanAccessClient. Mirror the old ownership
    // rule (only coach1 owns client1) so the access-control tests still
    // exercise the same allow/deny matrix. Throwing here surfaces as the
    // /coach/* 404 opacity convention in assertCoachOwnsClient.
    assertCanAccessClient: jest
      .fn()
      .mockImplementation(async (coachId: string, clientId: string) => {
        if (coachId === 'coach1' && clientId === 'client1') return;
        throw new Error('no access');
      }),
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

  // B-AIASSIGN-125: "Approve & assign" must put the days on the client's calendar.
  async function threeDayDraft(f: ReturnType<typeof makeFixtures>) {
    const ex = [{ exercise_external_id: 'bench', name: 'Bench', order: 1, sets: 4, reps_or_duration_seconds: 8 }];
    f.anthropic.completeStructured.mockResolvedValue({
      data: {
        summary: 'Strength block',
        weeks: 2,
        days_per_week: 2,
        days: [
          { week: 1, day: 1, name: 'Upper', type: 'strength', exercises: ex },
          { week: 1, day: 3, name: 'Lower', type: 'strength', exercises: ex },
          { week: 2, day: 1, name: 'Upper', type: 'strength', exercises: ex },
        ],
        coach_notes: '',
      },
      tokensIn: 100,
      tokensOut: 100,
      modelUsed: 'claude-sonnet-4-6',
      latencyMs: 100,
    });
    f.workouts.createPlan
      .mockResolvedValueOnce({ id: 'wp-1' })
      .mockResolvedValueOnce({ id: 'wp-2' })
      .mockResolvedValueOnce({ id: 'wp-3' });
    const { draftId } = await f.svc.generateWorkoutProgram('coach1', {
      clientId: 'client1',
      weeks: 2,
      daysPerWeek: 2,
    });
    return draftId;
  }

  it('approve assigns every AI day to the client, one push, and returns assigned_count', async () => {
    const f = makeFixtures();
    const draftId = await threeDayDraft(f);
    const before = Date.now();
    const approved: any = await f.svc.approveDraft('coach1', draftId);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAsId).toBe('wp-1');
    expect(approved.assigned_count).toBe(3);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.workouts.writePlanAssignmentsInTx).toHaveBeenCalledTimes(1);
    const [tx, coachId, clientId, plans, startIso] = f.workouts.writePlanAssignmentsInTx.mock.calls[0];
    expect(tx).toBe(f.prisma);
    expect(coachId).toBe('coach1');
    expect(clientId).toBe('client1');
    expect(plans).toEqual([
      { id: 'wp-1', week_index: 0, day_index: 0 },
      { id: 'wp-2', week_index: 0, day_index: 2 },
      { id: 'wp-3', week_index: 1, day_index: 0 },
    ]);
    // No client zone known in this fixture -> next Monday 09:00 UTC.
    const start = new Date(startIso);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getTime()).toBeGreaterThan(before);
    expect(start.getTime() - before).toBeLessThanOrEqual(8 * 24 * 60 * 60 * 1000);
    expect(f.workouts.notifyProgramAssigned).toHaveBeenCalledTimes(1);
    expect(f.workouts.notifyProgramAssigned).toHaveBeenCalledWith('client1', 'cwa-1', 'wp-1');
  });

  it('a second approve (double tap) replays the result without assigning again', async () => {
    const f = makeFixtures();
    const draftId = await threeDayDraft(f);
    const first: any = await f.svc.approveDraft('coach1', draftId);
    const second: any = await f.svc.approveDraft('coach1', draftId);
    expect(first.assigned_count).toBe(3);
    expect(second.assigned_count).toBe(3);
    expect(second.approvedAsId).toBe('wp-1');
    expect(f.workouts.createPlan).toHaveBeenCalledTimes(3);
    expect(f.workouts.writePlanAssignmentsInTx).toHaveBeenCalledTimes(1);
    expect(f.workouts.notifyProgramAssigned).toHaveBeenCalledTimes(1);
  });

  it('two approves at once assign the program once', async () => {
    const f = makeFixtures();
    const draftId = await threeDayDraft(f);
    const results = await Promise.allSettled([
      f.svc.approveDraft('coach1', draftId),
      f.svc.approveDraft('coach1', draftId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(f.workouts.createPlan).toHaveBeenCalledTimes(3);
    expect(f.workouts.writePlanAssignmentsInTx).toHaveBeenCalledTimes(1);
  });

  it('a failed assignment leaves the draft approvable again', async () => {
    const f = makeFixtures();
    const draftId = await threeDayDraft(f);
    f.workouts.writePlanAssignmentsInTx.mockRejectedValueOnce(new Error('db down'));
    await expect(f.svc.approveDraft('coach1', draftId)).rejects.toThrow('db down');
    expect(f.drafts.find((d) => d.id === draftId).status).toBe('DRAFT');
    expect(f.workouts.notifyProgramAssigned).not.toHaveBeenCalled();
  });

  it('approve refuses a client the coach can no longer reach', async () => {
    const f = makeFixtures();
    const draftId = await threeDayDraft(f);
    f.workouts.assertCanAccessClient.mockRejectedValueOnce(new Error('moved'));
    await expect(f.svc.approveDraft('coach1', draftId)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.workouts.writePlanAssignmentsInTx).not.toHaveBeenCalled();
    expect(f.drafts.find((d) => d.id === draftId).status).toBe('DRAFT');
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

  describe('a client who moves to another coach', () => {
    async function insightDraft(f: ReturnType<typeof makeFixtures>, coachId: string) {
      f.anthropic.completeStructured.mockResolvedValue({
        data: { summary: '', wins: [], concerns: [], suggested_actions: [], questions_for_coach: [] },
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: 'claude-sonnet-4-6',
        latencyMs: 1,
      });
      return (await f.svc.generateClientInsight(coachId, { clientId: 'client1' })).draftId;
    }

    it('takes their drafts from the former coach: list, read, edit, reject and approve', async () => {
      const f = makeFixtures();
      const draftId = await insightDraft(f, 'coach1');
      expect((await f.svc.listDrafts('coach1')).map((d) => d.id)).toEqual([draftId]);
      f.workouts.assertCanAccessClient.mockRejectedValue(new Error('moved'));
      expect(await f.svc.listDrafts('coach1')).toEqual([]);
      for (const call of [
        () => f.svc.getDraft('coach1', draftId),
        () => f.svc.editDraft('coach1', draftId, { summary: 'edited' }),
        () => f.svc.rejectDraft('coach1', draftId, 'no'),
        () => f.svc.approveDraft('coach1', draftId),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(f.drafts[0]).toMatchObject({ status: 'DRAFT', generatedPayload: { summary: '' } });
    });

    it('a sub-coach keeps their drafts while the client is assigned to them', async () => {
      const f = makeFixtures();
      f.workouts.assertCanAccessClient.mockImplementation(async (coachId: string, clientId: string) => {
        if (coachId === 'sub1' && clientId === 'client1') return;
        throw new Error('no access');
      });
      const draftId = await insightDraft(f, 'sub1');
      expect((await f.svc.listDrafts('sub1')).map((d) => d.id)).toEqual([draftId]);
      expect((await f.svc.getDraft('sub1', draftId)).id).toBe(draftId);
      f.workouts.assertCanAccessClient.mockRejectedValue(new Error('unassigned'));
      expect(await f.svc.listDrafts('sub1')).toEqual([]);
      await expect(f.svc.getDraft('sub1', draftId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
