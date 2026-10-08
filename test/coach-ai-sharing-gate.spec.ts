/**
 * COACH-AI-GATE-130 — the four Coach sharing switches (Settings > Privacy > Coach sharing) gate the
 * coach's daily brief, the Coach AI drafts, Roman adjust proposals and the churn draft. Real services
 * and a real ConsentService; Prisma fakes answer by the ids asked, like the database. Client SHARES
 * shares everything; client PRIVATE turned all four switches off on 10-01.
 */
import type { Prisma } from '@prisma/client';
import { AnthropicHandle, type AnthropicMessagesClient } from '../src/ai-egress/ai-egress.service';
import { ConsentService } from '../src/consent/consent.service';
import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { CoachAIController } from '../src/ai/coach/coach-ai.controller';
import type { ClientContext } from '../src/ai/context/client-context.types';
import type { WorkoutContextV2 } from '../src/ai/context/workout-context.service';
import { RomanAdjustService } from '../src/roman-adjust/roman-adjust.service';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import * as mocks from './_fixtures/coach-brief-mocks';
import { fakeOf, grantAllEgress } from './ai-egress/ai-egress.fakes';

const COACH = 'coach1';
const SHARES = 'client-shares';
const PRIVATE = 'client-private';
const NAMES: Record<string, string> = { [SHARES]: 'Ana Shares', [PRIVATE]: 'Sam Private' };

type ConsentKey = { client_id: string; coach_id: string; scope: string };
function consentSharing(sharing: string[]): ConsentService {
  const findUnique = jest.fn(async ({ where }: { where: { ClientCoachConsent_client_coach_scope_key: ConsentKey } }) => {
    const k = where.ClientCoachConsent_client_coach_scope_key;
    if (k.coach_id !== COACH) return null;
    const revoked = sharing.includes(k.client_id) ? null : new Date('2026-10-01T00:00:00Z');
    return { granted_at: new Date('2026-09-01T00:00:00Z'), revoked_at: revoked };
  });
  return new ConsentService(fakeOf({ clientCoachConsent: { findUnique } }), fakeOf({}));
}

describe('Coach daily brief (B1)', () => {
  it('leaves out the check-ins, weigh-ins and workouts a client stopped sharing', async () => {
    const prisma = mocks.makeMockPrisma();
    mocks.wireSoloDefaults(prisma, { coachId: COACH, clientIds: [SHARES, PRIVATE] });
    prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
    prisma.coachBrief.update.mockImplementation(async ({ data }) => ({ id: 'b1', coach_id: COACH, brief_date: '2026-10-07', created_at: new Date(), ...data }));
    prisma.user.findMany.mockReset();
    // Roster, then "who has not checked in today" (nobody has): the ids asked.
    prisma.user.findMany.mockImplementation(async ({ where }) =>
      where.check_ins ? where.id.in.map((id: string) => ({ id, name: NAMES[id] })) : [{ id: SHARES }, { id: PRIVATE }],
    );
    // Every client asked about moved 4.6 lbs and completed one workout today.
    prisma.$queryRaw.mockImplementation(async (sql: Prisma.Sql) =>
      sql.strings.join('').includes('"WeightLog"')
        ? (sql.values[0] as string[]).map((id) => ({ user_id: id, user_name: NAMES[id], delta_lbs: 4.6 }))
        : [{ count: 0n }],
    );
    prisma.clientWorkoutAssignment.count.mockImplementation(async ({ where }) => where.client_id?.in.length ?? 0);
    const anthropic = mocks.makeMockAnthropic(new Error('provider down'));
    const config = mocks.asConfig(mocks.makeMockConfig());
    const svc = new CoachBriefService(mocks.asPrismaService(prisma), config, grantAllEgress(), mocks.asAnthropic(anthropic), consentSharing([SHARES]));

    await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-07', { force: true });

    const data = prisma.coachBrief.update.mock.calls[0][0].data;
    const items: Array<{ type: string; client_id: string }> = data.action_items;
    expect(items.map((i) => `${i.type}:${i.client_id}`).sort()).toEqual([`checkin_missing:${SHARES}`, `weight_flag:${SHARES}`]);
    expect(data.brief_context).toMatchObject({
      roster_size: 2, missed_checkin: 1, weight_logs_flagged: 1, workouts_completed_today: 1,
      not_shared: { check_ins: 1, weigh_ins: 1, workouts: 1 },
    });
    expect(data.narrative).toContain('No check-ins yet today from the 1 client sharing check-ins');
    const prompt: string = anthropic.messages.create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Check-ins received today: 0 of 1');
    expect(prompt).toContain('Not shared with the coach');
  });
});

const clientContext = (clientId: string): ClientContext => ({
  client_id: clientId,
  identity: { first_name: 'Sam', age_years: 34, sex: 'male' },
  profile: {
    height_cm: 180, current_weight_lbs: 184.6, target_weight_lbs: 170, goal_type: 'fat_loss', activity_level: 'moderate',
    workout_experience: 'intermediate', has_gym_membership: true, preferred_snacks: [], dietary_pattern: null, dietary_restrictions: [],
    workout_days_per_week: 3, meals_per_day: 3, equipment_access: [], bio: null, injuries: ['knee'], food_preferences: null, preferred_training_time: null,
  },
  prescribed: { calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, meals_per_day: null, water_ml: null, effective_from: null },
  today: { date: '2026-10-07', calories: 2310, protein_g: 140, carbs_g: 250, fat_g: 80, remaining_calories: null, remaining_protein_g: null, pct_calories: null },
  weight_trend_90d: [{ date: '2026-09-07', weight_lbs: 180 }, { date: '2026-10-07', weight_lbs: 184.6 }],
  recent_workout_assignments: [
    { date: '2026-10-06', completed_at: '2026-10-06T18:00:00.000Z', post_rpe: 9, post_notes: 'knee hurt on squats', plan_name: 'Lower A', plan_type: 'strength' },
  ],
  food_log_totals_last_7d: { days_logged: 6, avg_calories: 2290, avg_protein_g: 131, avg_carbs_g: 240, avg_fat_g: 79 },
  recent_check_ins: [{ date: '2026-10-06', type: 'daily', mood: 2, energy: 2, soreness: 4, sleep_hours: 4.5, notes: 'rough week at work' }],
  coach: { coach_id: COACH, coach_name: 'Coach One', has_coach: true, last_coach_message_excerpt: null },
  generated_at: '2026-10-07T12:00:00.000Z',
});

const workoutContext: WorkoutContextV2 = {
  client: {
    goal: 'fat_loss', experience: 'intermediate', equipment: [], days_per_week: 3, injuries: [], screening_flag: false, adherence_pct_4w: 75,
    history_6w: [{ id: 'back_squat', last_weight_lbs: 225, last_reps: 5, best_e1rm_lbs: 262.5, sessions: 4 }],
    check_ins: [{ energy: 2, soreness: 4, sleep_hours: 4.5 }],
  },
  coach_style: null,
};

// Values only the client's four logs hold: weigh-ins, food, workouts, check-ins.
const LOG_VALUES = ['184.6', '2310', '2290', 'knee hurt on squats', 'rough week at work', '4.5', '262.5'];

function coachAi(sharing: string[]) {
  const completeStructured = jest.fn(async (_p: { system: string; user: string }) => ({
    data: { summary: 'Steady week.', wins: [], concerns: [], suggested_actions: [], questions_for_coach: [], days: [], coach_notes: '' },
    tokensIn: 1, tokensOut: 1, modelUsed: 'm', latencyMs: 1,
  }));
  const create = jest.fn(async ({ data }: { data: { inputContext: unknown } }) => ({ id: 'draft-1', ...data }));
  const prisma = { aIDraft: { create }, user: { findUnique: jest.fn(async () => ({ role: 'coach' })) } };
  const svc = new CoachAIService(
    fakeOf(prisma), fakeOf({ isReady: () => true }), fakeOf({ completeStructured }),
    fakeOf({ build: jest.fn(async (clientId: string) => clientContext(clientId)) }), fakeOf({}),
    fakeOf({ assertCanAccessClient: jest.fn(async () => undefined) }), undefined,
    fakeOf({ build: jest.fn(async () => workoutContext) }), consentSharing(sharing),
  );
  const sent = () => completeStructured.mock.calls[0][0].user;
  const stored = () => JSON.stringify(create.mock.calls[0][0].data.inputContext);
  return { svc, sent, stored };
}

describe('Coach AI drafts (B2)', () => {
  it('weekly insight for a client who shares nothing: no weights, food, workouts, mood, sleep or notes sent or stored', async () => {
    const { svc, sent, stored } = coachAi([SHARES]);
    await svc.generateClientInsight(COACH, { clientId: PRIVATE });
    for (const v of LOG_VALUES) {
      expect(sent()).not.toContain(v);
      expect(stored()).not.toContain(v);
    }
    expect(sent()).not.toMatch(/"mood": 2/);
    expect(sent()).toContain('NOT_SHARED_WITH_COACH: weigh-ins, food logs, workout logs, check-ins and habits.');
  });

  it('weekly insight for a client who shares everything is unchanged', async () => {
    const { svc, sent } = coachAi([SHARES]);
    await svc.generateClientInsight(COACH, { clientId: SHARES });
    for (const v of ['184.6', '2310', 'knee hurt on squats', 'rough week at work']) expect(sent()).toContain(v);
    expect(sent()).not.toContain('NOT_SHARED_WITH_COACH');
  });

  it('workout program and meal plan for a client who shares nothing: no logged sets, effort, sleep or food', async () => {
    const { svc, sent } = coachAi([SHARES]);
    await svc.generateWorkoutProgram(COACH, { clientId: PRIVATE, weeks: 4, daysPerWeek: 3 });
    for (const v of ['225', '262.5', '"adherence_pct_4w":75', '4.5', '"post_rpe": 9']) expect(sent()).not.toContain(v);
    const meal = coachAi([SHARES]);
    await meal.svc.generateMealPlan(COACH, { clientId: PRIVATE, days: 7 });
    for (const v of ['184.6', '2310', '2290']) expect(meal.sent()).not.toContain(v);
  });

  it('draft responses never carry the stored snapshot', async () => {
    const draft = { id: 'd1', status: 'DRAFT', generatedPayload: {}, inputContext: { weight_trend_90d: [184.6] } };
    const svc = { getDraft: async () => draft, approveDraft: async () => draft, editDraft: async () => draft, rejectDraft: async () => draft };
    const controller = new CoachAIController(fakeOf(svc), fakeOf({}));
    const req = fakeOf<Parameters<CoachAIController['getDraft']>[0]>({ user: { id: COACH } });
    for (const res of [
      await controller.getDraft(req, 'd1'),
      await controller.approve(req, 'd1'),
      await controller.edit(req, 'd1', { patch: {} }),
      await controller.reject(req, 'd1', { reason: 'no' }),
    ]) {
      expect(res).not.toHaveProperty('inputContext');
      expect(res).toMatchObject({ id: 'd1', status: 'DRAFT' });
    }
  });
});

describe('Roman adjust proposals (U3)', () => {
  it('reads workout effort ratings only for clients who share workouts', async () => {
    type Where = { where: { client_id: { in: string[] }; completed_at?: unknown } };
    const findMany = jest.fn(async ({ where }: Where) =>
      where.completed_at ? [] : where.client_id.in.map((id) => ({ id: `a-${id}`, client_id: id, scheduled_for: new Date('2026-10-08T16:00:00Z') })),
    );
    const prisma = {
      user: { findMany: async () => [SHARES, PRIVATE].map((id) => ({ id, name: NAMES[id], notification_prefs: null })), findUnique: async () => ({ role: 'coach' }) },
      clientWorkoutAssignment: { findMany },
      wearableSample: { findMany: async () => [] },
    };
    const svc = new RomanAdjustService(fakeOf(prisma), fakeOf({}), grantAllEgress(), consentSharing([SHARES]));
    await svc.refreshForCoach(COACH, new Date('2026-10-07T16:00:00Z'), true);
    const completions = findMany.mock.calls.find(([args]) => args.where.completed_at);
    expect(completions?.[0].where.client_id.in).toEqual([SHARES]);
  });
});

describe('Churn re-engagement draft (U4)', () => {
  it('leaves the last check-in out when the client does not share check-ins', async () => {
    const checkIn = jest.fn(async () => ({ mood: 1, energy: 2, notes: 'rough week at work', logged_at: new Date('2026-10-06T08:00:00Z') }));
    const prisma = {
      user: { findFirst: async () => ({ id: PRIVATE, name: NAMES[PRIVATE] }), findUnique: async () => ({ name: 'Coach One', role: 'coach', coach_profile: null }) },
      churnIntervention: {
        create: async () => ({ id: 'i1' }),
        update: async ({ data }: { data: { draft_text: string } }) => ({ id: 'i1', client_id: PRIVATE, status: 'draft', top_factor: null, created_at: new Date(), ...data }),
      },
      checkIn: { findFirst: checkIn },
    };
    const create = jest.fn(async (_body: { system: string }) => ({ content: [{ type: 'text', text: 'Sam, how is the week going? Coach One' }] }));
    const anthropic = AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>({ messages: { create } }));
    const svc = new ChurnInterventionService(
      fakeOf(prisma), fakeOf({ getLatestPrediction: async () => null }), fakeOf({ get: () => undefined }),
      grantAllEgress(), undefined, anthropic, consentSharing([SHARES]),
    );
    await svc.generateChurnDraft(COACH, PRIVATE, { idempotency_key: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f' });
    expect(checkIn).not.toHaveBeenCalled();
    const system = create.mock.calls[0][0].system;
    expect(system).not.toContain('Mood:');
    expect(system).toContain('Their check-ins are not shared with the coach');
  });
});
