/**
 * COACH-AI-GATE-130 — the four Coach sharing switches (Settings > Privacy > Coach sharing) gate the
 * coach's daily brief, the Coach AI drafts, Roman adjust proposals and the churn draft. Real services
 * and a real ConsentService; Prisma fakes answer by the ids asked, like the database. Client SHARES
 * shares everything; client PRIVATE turned all four switches off on 10-01.
 */
import type { Prisma } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { AnthropicHandle, type AnthropicMessagesClient } from '../src/ai-egress/ai-egress.service';
import { ConsentScope, ConsentService } from '../src/consent/consent.service';
import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { CoachAIService } from '../src/ai/coach/coach-ai.service';
import { CoachAIController } from '../src/ai/coach/coach-ai.controller';
import type { ClientContext } from '../src/ai/context/client-context.types';
import type { WorkoutContextService, WorkoutContextV2 } from '../src/ai/context/workout-context.service';
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
  // The batch read (grantedScopesByClient, from b#865) answers the same way, by the ids and scopes asked.
  type ManyWhere = { coach_id: string; client_id: { in: string[] }; scope: { in: string[] } };
  const findMany = jest.fn(async ({ where }: { where: ManyWhere }) =>
    where.coach_id !== COACH
      ? []
      : where.client_id.in.flatMap((client_id) =>
          where.scope.in.map((scope) => ({
            client_id, scope, granted_at: new Date('2026-09-01T00:00:00Z'),
            revoked_at: sharing.includes(client_id) ? null : new Date('2026-10-01T00:00:00Z'),
          })),
        ),
  );
  return new ConsentService(fakeOf({ clientCoachConsent: { findUnique, findMany } }), fakeOf({}));
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
    fakeOf<WorkoutContextService>({ build: jest.fn(async () => workoutContext) }), consentSharing(sharing),
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

describe('Stored weekly insight after a client turns a switch off (B-872-SOL-H-131-1)', () => {
  type Row = Record<string, unknown> & { id: string };
  type Withdrawn = { coach_id: string; client_id: string; scope: { in: string[] }; revoked_at: { gt: Date } };
  function insightFlow(role = 'coach') {
    const rows: Record<string, Row> = {};
    let revokedAt: Date | null = null;
    const completeStructured = jest.fn(async () => ({
      data: { summary: 'Weigh-ins are down to 184.6 lb.', wins: [], concerns: [], suggested_actions: [], questions_for_coach: [] },
      tokensIn: 1, tokensOut: 1, modelUsed: 'm', latencyMs: 1,
    }));
    const prisma = {
      aIDraft: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
          (rows['ins-1'] = { id: 'ins-1', status: 'DRAFT', createdAt: new Date('2026-10-05T12:00:00Z'), ...data })),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          (rows[where.id] = { ...rows[where.id], ...data })),
      },
      user: { findUnique: jest.fn(async () => ({ role })) },
      // Answers like the database: a Weigh-ins row for this coach and client revoked after the asked time.
      clientCoachConsent: {
        findFirst: jest.fn(async ({ where }: { where: Withdrawn }) =>
          revokedAt && where.coach_id === COACH && where.client_id === SHARES &&
          where.scope.in.includes(ConsentScope.FITNESS_BODY_METRICS) && revokedAt > where.revoked_at.gt
            ? { id: 'consent-1' }
            : null),
      },
    };
    const svc = new CoachAIService(
      fakeOf(prisma), fakeOf({ isReady: () => true }), fakeOf({ completeStructured }),
      fakeOf({ build: jest.fn(async (clientId: string) => clientContext(clientId)) }), fakeOf({}),
      fakeOf({ assertCanAccessClient: jest.fn(async () => undefined) }), undefined,
      fakeOf<WorkoutContextService>({ build: jest.fn(async () => workoutContext) }), consentSharing([SHARES]),
    );
    return { svc, setRevokedAt: (at: Date | null) => { revokedAt = at; } };
  }

  it('generate, then Weigh-ins off: read, edit and reject return the insight without its content', async () => {
    const { svc, setRevokedAt } = insightFlow();
    const controller = new CoachAIController(svc, fakeOf({}));
    const req = fakeOf<Parameters<CoachAIController['getDraft']>[0]>({ user: { id: COACH } });
    const { draftId } = await svc.generateClientInsight(COACH, { clientId: SHARES });
    expect(JSON.stringify(await controller.getDraft(req, draftId))).toContain('184.6');
    setRevokedAt(new Date('2026-10-06T08:00:00Z'));
    for (const res of [
      await controller.getDraft(req, draftId),
      await controller.edit(req, draftId, { patch: { coach_notes: 'ok' } }),
      await controller.reject(req, draftId, { reason: 'no' }),
    ]) {
      expect(res).toMatchObject({ id: draftId, generatedPayload: null });
      expect(JSON.stringify(res)).not.toContain('184.6');
    }
  });

  it('approve after Weigh-ins off returns no content; the owner account still reads it', async () => {
    const coach = insightFlow();
    const { draftId } = await coach.svc.generateClientInsight(COACH, { clientId: SHARES });
    coach.setRevokedAt(new Date('2026-10-06T08:00:00Z'));
    expect((await coach.svc.approveDraft(COACH, draftId)).generatedPayload).toBeNull();
    const owner = insightFlow('owner');
    await owner.svc.generateClientInsight(COACH, { clientId: SHARES });
    owner.setRevokedAt(new Date('2026-10-06T08:00:00Z'));
    expect(JSON.stringify((await owner.svc.getDraft(COACH, draftId)).generatedPayload)).toContain('184.6');
  });

  it('a switch turned off before the insight was made, or turned on again, keeps the insight', async () => {
    const { svc, setRevokedAt } = insightFlow();
    const { draftId } = await svc.generateClientInsight(COACH, { clientId: SHARES });
    setRevokedAt(new Date('2026-10-04T08:00:00Z'));
    expect(JSON.stringify((await svc.getDraft(COACH, draftId)).generatedPayload)).toContain('184.6');
    setRevokedAt(null);
    expect(JSON.stringify((await svc.getDraft(COACH, draftId)).generatedPayload)).toContain('184.6');
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
  // With b#865 merged, the draft needs all four switches (churn-intervention.service.ts generateChurnDraft),
  // so a client who does not share check-ins gets no draft: nothing is read or sent.
  it('a client who does not share check-ins gets no draft: no check-in read, no AI call', async () => {
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
    await expect(
      svc.generateChurnDraft(COACH, PRIVATE, { idempotency_key: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(checkIn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

// B-872-SOL-130-1 (FIX-OPUS-131): a brief stored before a client turned a switch off is not served as
// stored. Today's brief is written again under the current switches; history keeps the day and its
// status but drops the content.
describe('Stored briefs after a client turns a switch off (B-872-SOL-130-1)', () => {
  const STORED = {
    id: 'b0', coach_id: COACH, brief_date: '2026-10-07', status: 'generated', brief_mode: 'solo_coach',
    generated_by: 'ai', narrative: 'Sam Private moved 4.6 lbs this week.', brief_context: { roster_size: 2 },
    action_items: [{ type: 'weight_flag', client_id: PRIVATE }],
    generated_at: new Date('2026-10-07T13:00:00Z'), created_at: new Date('2026-10-07T13:00:00Z'),
  };
  function briefService(withdrawnAt: Date | null) {
    const prisma = mocks.makeMockPrisma();
    mocks.wireSoloDefaults(prisma, { coachId: COACH, clientIds: [SHARES, PRIVATE] });
    const lastRevoke = jest.fn(async () => (withdrawnAt ? { revoked_at: withdrawnAt } : null));
    Object.assign(prisma, { clientCoachConsent: { findFirst: lastRevoke } });
    prisma.coachBrief.findUnique.mockResolvedValue(STORED);
    prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
    prisma.coachBrief.update.mockImplementation(async ({ data }) => ({ ...STORED, ...data }));
    prisma.user.findMany.mockReset();
    prisma.user.findMany.mockImplementation(async ({ where }) =>
      where.check_ins ? where.id.in.map((id: string) => ({ id, name: NAMES[id] })) : [{ id: SHARES }, { id: PRIVATE }],
    );
    prisma.$queryRaw.mockImplementation(async (sql: Prisma.Sql) =>
      sql.strings.join('').includes('"WeightLog"')
        ? (sql.values[0] as string[]).map((id) => ({ user_id: id, user_name: NAMES[id], delta_lbs: 4.6 }))
        : [{ count: 0n }],
    );
    const config = mocks.asConfig(mocks.makeMockConfig());
    const anthropic = mocks.makeMockAnthropic(new Error('provider down'));
    const svc = new CoachBriefService(mocks.asPrismaService(prisma), config, grantAllEgress(), mocks.asAnthropic(anthropic), consentSharing([SHARES]));
    return { prisma, svc, lastRevoke };
  }

  it("today: a brief stored before the switch went off is written again without that client's weigh-in", async () => {
    const { prisma, svc } = briefService(new Date('2026-10-07T14:00:00Z'));
    const out = await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-07');
    expect(prisma.coachBrief.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'generating' }) }),
    );
    const items = (out.summary?.action_items ?? []) as Array<{ type: string; client_id?: string }>;
    expect(items.some((i) => i.client_id === PRIVATE)).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Sam Private');
  });

  it('today: a brief stored after the last switch change is served as stored', async () => {
    const { prisma, svc, lastRevoke } = briefService(new Date('2026-10-07T12:00:00Z'));
    const out = await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-07');
    expect(lastRevoke).toHaveBeenCalled();
    expect(prisma.coachBrief.updateMany).not.toHaveBeenCalled();
    expect(out.summary?.narrative).toBe(STORED.narrative);
  });

  it('history: a brief stored before the switch went off keeps its day and status, not its content', async () => {
    const { prisma, svc } = briefService(new Date('2026-10-07T14:00:00Z'));
    const later = { ...STORED, id: 'b1', brief_date: '2026-10-08', narrative: 'Ana Shares checked in.', generated_at: new Date('2026-10-08T13:00:00Z') };
    prisma.coachBrief.count.mockResolvedValue(2);
    prisma.coachBrief.findMany.mockResolvedValue([later, STORED]);
    const { items } = await svc.getBriefHistory(COACH, 1, 20);
    expect(items.map((i) => [i.id, i.status, i.summary?.narrative ?? null])).toEqual([
      ['b1', 'generated', 'Ana Shares checked in.'],
      ['b0', 'generated', null],
    ]);
  });
});
