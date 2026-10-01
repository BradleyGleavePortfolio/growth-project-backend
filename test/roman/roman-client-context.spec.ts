// test/roman/roman-client-context.spec.ts
//
// R3 — RomanClientContext builder, renderer, tenancy and injection
// (PLAN_roman_intelligence §2.3–§2.6, §7.3 layer 1). In-memory personas from
// ./fixtures/roman-personas.ts; no network, no DB.

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RomanClientContextService,
  localClock,
  ageYears,
  addDays,
  ROMAN_CONTEXT_MAX_QUERIES,
} from '../../src/roman/context/roman-client-context.service';
import {
  renderClientContext,
  ROMAN_CONTEXT_HARD_CAP_TOKENS,
  ROMAN_CLEARANCE_RECOMMENDED_INSTRUCTION,
  ROMAN_CLIENT_DATA_NOTICE,
} from '../../src/roman/context/roman-client-context.renderer';
import {
  romanContextInvalidate,
  _resetRomanContextListeners,
} from '../../src/roman/context/roman-context-invalidation';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import { RomanService } from '../../src/roman/roman.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import type { RomanClientContext } from '../../src/roman/context/roman-client-context.types';
import type Anthropic from '@anthropic-ai/sdk';
import type { AuthedRequest } from '../../src/auth/auth-request';
import {
  makePersonaDb,
  FakeSafetyIntakeSource,
  CANARIES,
  INTAKE_CANARIES,
  NOW,
  LOCAL_TODAY_PT,
  P1,
  P2,
  P3,
  P4,
} from './fixtures/roman-personas';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
  _resetRomanContextListeners();
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

function asAnthropicDouble<T extends object>(mock: T): Anthropic {
  // @ts-expect-error partial structural mock of the Anthropic SDK client — only messages.stream is stubbed.
  return mock;
}
function asAuthedRequestDouble<T extends object>(mock: T): AuthedRequest {
  // @ts-expect-error partial structural mock of an authenticated request.
  return mock;
}

function setup() {
  const db = makePersonaDb();
  const intake = new FakeSafetyIntakeSource();
  const svc = new RomanClientContextService(db.prisma, intake);
  return { db, intake, svc };
}
const student = (id: string) => ({ id, role: 'student' });

// ─── local time ──────────────────────────────────────────────────────────────

describe('R3 local clock', () => {
  it('PT/UTC boundary: 00:30Z on 10/01 is still 09/30 17:30 in Los Angeles, but 10/01 in UTC', () => {
    expect(localClock(NOW, 'America/Los_Angeles')).toMatchObject({
      local_date: '2026-09-30',
      local_time: '17:30',
      local_weekday: 'Wednesday',
    });
    expect(localClock(NOW, 'UTC')).toMatchObject({
      local_date: '2026-10-01',
      local_time: '00:30',
      local_weekday: 'Thursday',
    });
    expect(localClock(NOW, 'Not/AZone').timezone).toBe('America/Los_Angeles');
  });
  it('age is a whole number in the local date; day math is UTC-safe', () => {
    expect(ageYears(new Date('1992-03-15T00:00:00Z'), '2026-09-30')).toBe(34);
    expect(ageYears(new Date('1992-10-15T00:00:00Z'), '2026-09-30')).toBe(33);
    expect(ageYears(null, '2026-09-30')).toBeNull();
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-09-30', -6)).toBe('2026-09-24');
  });
});

// ─── P1 golden facts ─────────────────────────────────────────────────────────

describe('R3 builder — P1 Maya golden facts', () => {
  it('reads the CURRENT coach MacroTarget over the profile and over an old coach row, and computes today in PT', async () => {
    const { svc, db } = setup();
    const { context: ctx, query_count } = await svc.build(student(P1), NOW);

    expect(ctx.identity).toMatchObject({
      first_name: 'Maya',
      age_years: 34,
      sex: 'female',
      timezone: 'America/Los_Angeles',
      local_date: LOCAL_TODAY_PT,
      local_time: '17:30',
    });
    expect(ctx.targets).toMatchObject({
      source: 'coach_set',
      calories: 1450,
      protein_g: 115,
      carbs_g: 150,
      fat_g: 45,
      fiber_g: 25,
      effective_from: '2026-09-20',
      notes: 'Protein first at breakfast.',
    });
    expect(ctx.today).toMatchObject({
      date: LOCAL_TODAY_PT,
      kcal: 780,
      protein_g: 62,
      meals_logged: 2,
      remaining_kcal: 670,
      remaining_protein_g: 53,
      pct_kcal: 54,
      pct_protein: 54,
    });
    expect(ctx.today.last_logged_at).toBe('2026-09-30T20:45:00.000Z');
    expect(ctx.last_7_days.days.map((d) => d.date)).toEqual([
      '2026-09-25',
      '2026-09-28',
      '2026-09-29',
    ]); // 9/22 is outside
    expect(ctx.last_7_days).toMatchObject({ days_logged: 4, days_within_10pct_kcal: 2 }); // 1500 and 1420 within ±145 of 1450
    expect(ctx.profile).toMatchObject({
      goal_type: 'fat_loss',
      dietary_restrictions: ['dairy-free'],
      has_gym_membership: true,
      current_weight_lbs: 166.9,
      target_weight_lbs: 150,
    });
    expect(ctx.profile.food_preferences).toContain('salmon');
    expect(ctx.plan?.program_name).toBe('Program A Foundations');
    expect(ctx.plan?.today_session).toBeNull();
    expect(ctx.plan?.next_session).toMatchObject({
      date: '2026-10-01',
      name: 'Full Body B',
      type: 'strength',
    });
    expect(ctx.plan?.next_session?.exercises.map((e) => e.name)).toEqual([
      'Goblet Squat',
      'Dumbbell Bench Press',
      'Romanian Deadlift',
    ]);
    expect(ctx.plan?.next_session?.exercises[0]).toMatchObject({
      sets: 3,
      reps_or_duration_seconds: 10,
      cue: 'Chest tall, knees track toes',
    });
    expect(ctx.plan?.recent_completions).toEqual([
      { date: '2026-09-23', name: 'Full Body A', post_rpe: 6, has_notes: false, notes: null },
      {
        date: '2026-09-28',
        name: 'Full Body B',
        post_rpe: 7,
        has_notes: true,
        notes: 'Felt strong',
      },
    ]);
    expect(ctx.plan?.adherence_14d).toEqual({ completed: 2, scheduled: 2 });
    expect(ctx.weight_trend).toMatchObject({ unit: 'lbs', change_14d: -1.5, avg_7d: 166.9 });
    expect(ctx.weight_trend.points.map((p) => p.weight_lbs)).toEqual([168.4, 167.6, 166.9]);
    expect(ctx.check_ins).toEqual([
      {
        date: '2026-09-30',
        type: 'morning',
        mood: 4,
        energy: 3,
        soreness: 2,
        sleep_hours: 6.5,
        notes: 'Slept badly, kids up.',
      },
    ]);
    expect(ctx.coach).toMatchObject({
      has_coach: true,
      coach_first_name: 'Alex',
      guidelines: 'Keep dairy out. Protein at every meal. Walk on rest days.',
    });
    // ctx-v2: both directions, oldest first, current coach's thread only
    expect(ctx.coach.recent_messages).toEqual([
      { date: '2026-09-29', from: 'coach', excerpt: 'Great week Maya - protein looked solid.' },
      { date: '2026-09-29', from: 'client', excerpt: 'Thanks Alex, knee felt fine on the squats.' },
    ]);
    // ctx-v2: today's food entries by name, oldest first
    expect(ctx.today.entries).toEqual([
      { meal: 'breakfast', name: 'Greek yogurt bowl', kcal: 320, protein_g: 30, logged_at: '2026-09-30T15:10:00.000Z' },
      { meal: 'lunch', name: 'Chicken rice bowl', kcal: 460, protein_g: 32, logged_at: '2026-09-30T20:45:00.000Z' },
    ]);
    // ctx-v2: own community posts only (deleted and hidden excluded)
    expect(ctx.community_posts).toEqual([
      { date: '2026-09-28', scope: 'cohort', title: 'Week 3 done', excerpt: 'Hit every session this week, first time ever.' },
    ]);
    // ctx-v2: wearables as daily aggregates (sleep keyed to the morning it ends)
    expect(ctx.wearables).toMatchObject({
      connected: true,
      providers: ['oura'],
      last_synced_at: '2026-09-30T14:00:00.000Z',
      last_night_sleep_hours: 6.3,
    });
    expect(ctx.wearables.days).toEqual([
      { date: '2026-09-29', steps: 8200, active_kcal: null, resting_hr_bpm: 58, hrv_ms: 44, sleep_hours: 6.7, sleep_efficiency_pct: null, recovery_score: 71, readiness_score: null },
      { date: '2026-09-30', steps: 6100, active_kcal: null, resting_hr_bpm: 60, hrv_ms: null, sleep_hours: 6.3, sleep_efficiency_pct: 88, recovery_score: null, readiness_score: null },
    ]);
    expect(ctx.wearables.avg_7d).toMatchObject({ steps: 7150, resting_hr_bpm: 59, sleep_hours: 6.5 });
    // ctx-v2: consultation + safety-screen answers are the client's own
    expect(ctx.consultation).toEqual({
      completed: true,
      completed_at: '2026-09-01',
      answers: [{ question: 'Main goal', answer: 'Get strong, CONSULT-ANSWER-MAYA' }],
    });
    expect(ctx.meal_plan).toEqual({
      title: 'Dairy-free 1450',
      items: [
        'Breakfast: Egg scramble (380 kcal, 30 g protein)',
        'Lunch: Chicken bowl (520 kcal, 42 g protein)',
      ],
    });
    expect(ctx.logged_workouts).toEqual([
      {
        date: '2026-09-26',
        name: 'Walk + core',
        type: 'cardio',
        duration_minutes: 35,
        intensity: 'light',
        exercise_count: 2,
      },
    ]);
    expect(ctx.safety_intake).toEqual({
      completed: true,
      clearance_recommended: false,
      screen_answers: [{ question: 'Chest pain with activity?', answer: 'No' }],
    });
    expect(ctx.macro_method).toMatchObject({ floor_kcal: 1200, floor_applied: false });
    expect(ctx.data_quality.missing).toEqual([]);

    expect(query_count).toBeLessThanOrEqual(ROMAN_CONTEXT_MAX_QUERIES);
    expect(db.forbiddenTouched).toEqual([]);
  });

  it('every query is scoped to the caller (and coach-owned ones to the current coach)', async () => {
    const { svc, db } = setup();
    await svc.build(student(P1), NOW);
    const byTable = (t: string) => db.wheres.filter((w) => w.table === t).map((w) => w.where ?? {});
    for (const t of [
      'loggedFoodEntry',
      'weightLog',
      'checkIn',
      'workoutSession',
      'wearableConnection',
      'wearableSample',
    ]) {
      expect(byTable(t).length).toBeGreaterThan(0);
      for (const w of byTable(t)) expect(w.user_id).toBe(P1);
    }
    for (const w of byTable('communityPost'))
      expect(w).toMatchObject({ author_id: P1, deleted_at: null, visibility: 'active' });
    expect(byTable('communityPost').length).toBeGreaterThan(0);
    for (const w of byTable('macroTarget'))
      expect(w).toMatchObject({ client_id: P1, coach_id: 'coach-A', archived_at: null });
    for (const w of byTable('clientWorkoutAssignment'))
      expect(w).toMatchObject({ client_id: P1, assigned_by_coach_id: 'coach-A' });
    for (const w of byTable('coachGuideline'))
      expect(w).toMatchObject({ client_id: P1, coach_id: 'coach-A' });
    for (const w of byTable('coachMessage'))
      expect(w).toMatchObject({
        client_id: P1,
        coach_id: 'coach-A',
        sender_id: { in: ['coach-A', P1] },
      });
    for (const w of byTable('dailyMealPlanAssignment'))
      expect(w).toMatchObject({ client_id: P1, assigned_by_coach_id: 'coach-A' });
    for (const t of [
      'macroTarget',
      'clientWorkoutAssignment',
      'coachGuideline',
      'coachMessage',
      'dailyMealPlanAssignment',
    ]) {
      expect(byTable(t).length).toBeGreaterThan(0);
    }
    // the catalog lookup is the only unscoped query, and it is keyed by exercise ids, not by user
    expect(byTable('exerciseCatalogItem')).toHaveLength(1);
  });
});

// ─── canaries / exclusions ───────────────────────────────────────────────────

describe('R3 builder — canary absence and exclusion list', () => {
  it("P1's rendered block contains none of P4/P5's data, the old coach's rows, coach-private notes, PII, wearable tokens or deleted/hidden posts", async () => {
    const { svc } = setup();
    const bundle = await svc.buildFresh(student(P1), NOW);
    for (const c of CANARIES) expect(bundle.rendered).not.toContain(c);
    for (const c of [
      'WEARABLE-TOKEN-CANARY',
      'DELETED-POST-CANARY',
      'HIDDEN-POST-CANARY',
      '99999',
      '31111',
      'whoop',
      'WHOOP',
    ])
      expect(bundle.rendered).not.toContain(c);
    for (const c of INTAKE_CANARIES) expect(bundle.rendered).not.toContain(c);
    expect(bundle.rendered).not.toMatch(
      /"email"|"phone"|"user_id"|"date_of_birth"|"coach_notes_md"|"id":|access_token|refresh_token/,
    );
    // present, so the assertion above is not vacuous (ruling #6 scope)
    expect(bundle.rendered).toContain('"first_name":"Maya"');
    expect(bundle.rendered).toContain('1450');
    expect(bundle.rendered).toContain('Greek yogurt bowl');
    expect(bundle.rendered).toContain('knee felt fine on the squats');
    expect(bundle.rendered).toContain('Week 3 done');
    expect(bundle.rendered).toContain('CONSULT-ANSWER-MAYA');
    expect(bundle.rendered).toContain('"last_night_sleep_hours":6.3');
  });

  it("P4 (same coach, same cohort) sees her own posts, wearables and answers but none of P1's", async () => {
    const { svc } = setup();
    const bundle = await svc.buildFresh(student(P4), NOW);
    expect(bundle.rendered).toContain('ZELDA-CANARY post');
    expect(bundle.rendered).toContain('ZELDA-CANARY screen answer');
    expect(bundle.rendered).toContain('31111');
    for (const c of ['Maya', 'Greek yogurt', 'Week 3 done', 'CONSULT-ANSWER-MAYA', 'knee felt fine', '8200', '6100'])
      expect(bundle.rendered).not.toContain(c);
  });

  it('P4 (same coach) does not see P1 either, and the coach surface canary tables are never read', async () => {
    const { svc, db } = setup();
    const bundle = await svc.buildFresh(student(P4), NOW);
    expect(bundle.rendered).not.toContain('Maya');
    expect(bundle.rendered).not.toContain('1450');
    expect(bundle.rendered).toContain('2777');
    expect(db.forbiddenTouched).toEqual([]);
  });

  it('a non-student caller gets no coach-owned facts even for their own id (JWT role and DB role both gate)', async () => {
    const { svc, db } = setup();
    // JWT says coach, DB says student → no coach-owned facts
    const { context } = await svc.build({ id: P1, role: 'coach' }, NOW);
    expect(context.coach.has_coach).toBe(false);
    expect(context.targets.source).toBe('onboarding_calculated'); // profile fallback, not the coach row
    expect(context.plan).toBeNull();
    expect(context.meal_plan).toBeNull();
    expect(db.calls).not.toContain('macroTarget.findFirst');
    // A coach building their own context: no coach-owned facts, no client rows
    const own = await svc.build({ id: 'coach-A', role: 'coach' }, NOW);
    expect(own.context.coach.has_coach).toBe(false);
    expect(own.context.plan).toBeNull();
    expect(own.query_count).toBeLessThanOrEqual(ROMAN_CONTEXT_MAX_QUERIES);
  });

  it('an unknown user yields an empty context with everything marked missing', async () => {
    const { svc, db } = setup();
    const { context, query_count } = await svc.build(student('user-nobody'), NOW);
    expect(context.data_quality.missing).toContain('user');
    expect(context.targets.source).toBe('none');
    expect(query_count).toBe(1);
    expect(db.calls).toEqual(['user.findUnique']);
  });
});

// ─── P2 / P3 ─────────────────────────────────────────────────────────────────

describe('R3 builder — P2 Dan (clearance recommended) and P3 Lee (new client)', () => {
  it('P2: onboarding-calculated 1,500 kcal with the male floor applied; safety-screen answers are his own (ruling #6)', async () => {
    const { svc, intake } = setup();
    const bundle = await svc.buildFresh(student(P2), NOW);
    const ctx = bundle.context;
    expect(ctx.identity).toMatchObject({ first_name: 'Dan', age_years: 58, sex: 'male' });
    expect(ctx.targets).toMatchObject({
      source: 'onboarding_calculated',
      calories: 1500,
      protein_g: 150,
    });
    expect(ctx.macro_method).toMatchObject({ floor_kcal: 1500, floor_applied: true });
    expect(ctx.profile.injuries).toEqual(['left knee']);
    expect(ctx.plan?.program_name).toBe('Program C Gentle Start');
    expect(ctx.today.meals_logged).toBe(0);
    expect(ctx.data_quality.missing).toContain('today_logs');

    // Ruling #6: Roman sees Dan's own screen answers; the source's internal
    // category bookkeeping is not part of the interface and stays out.
    expect(ctx.safety_intake).toEqual({
      completed: true,
      clearance_recommended: true,
      screen_answers: [
        { question: 'Bone or joint problem?', answer: 'Yes, left knee replacement 2019', flagged: true },
        { question: 'Blood pressure or heart medication?', answer: 'Yes, lisinopril', flagged: true },
        { question: 'Chest pain with activity?', answer: 'No' },
      ],
    });
    expect(Object.keys(ctx.safety_intake).sort()).toEqual([
      'clearance_recommended',
      'completed',
      'screen_answers',
    ]);
    expect(bundle.rendered).toContain(ROMAN_CLEARANCE_RECOMMENDED_INSTRUCTION);
    expect(bundle.rendered).toContain('lisinopril');
    for (const c of INTAKE_CANARIES) expect(bundle.rendered).not.toContain(c);
    expect(JSON.stringify(intake.internal[P2])).toContain('joint_or_bone');
    expect(ctx.consultation.answers).toHaveLength(2);
    expect(ctx.wearables).toEqual({
      connected: false,
      providers: [],
      last_synced_at: null,
      avg_7d: {
        steps: null,
        active_kcal: null,
        resting_hr_bpm: null,
        hrv_ms: null,
        sleep_hours: null,
        sleep_efficiency_pct: null,
        recovery_score: null,
        readiness_score: null,
      },
      last_night_sleep_hours: null,
      days: [],
    });
    expect(ctx.data_quality.missing).toContain('wearables');
  });

  it('P1 (no clearance) does not get the conservative instruction', async () => {
    const { svc } = setup();
    const bundle = await svc.buildFresh(student(P1), NOW);
    expect(bundle.rendered).not.toContain(ROMAN_CLEARANCE_RECOMMENDED_INSTRUCTION);
  });

  it('P3: no coach, no targets, no plan, intake not completed → source none, floor 1,500 for prefer_not_to_say, missing[] says so', async () => {
    const { svc } = setup();
    const { context: ctx, query_count } = await svc.build(student(P3), NOW);
    expect(ctx.identity).toMatchObject({
      first_name: 'Lee',
      age_years: null,
      sex: 'prefer_not_to_say',
      timezone: 'America/Los_Angeles',
    });
    expect(ctx.targets.source).toBe('none');
    expect(ctx.macro_method).toMatchObject({ floor_kcal: 1500, floor_applied: null });
    expect(ctx.safety_intake).toEqual({
      completed: false,
      clearance_recommended: false,
      screen_answers: [],
    });
    expect(ctx.consultation).toEqual({ completed: false, completed_at: null, answers: [] });
    expect(ctx.community_posts).toEqual([]);
    expect(ctx.coach).toEqual({
      has_coach: false,
      coach_first_name: null,
      guidelines: null,
      recent_messages: [],
    });
    expect(ctx.plan).toBeNull();
    expect(ctx.data_quality.missing).toEqual(
      expect.arrayContaining([
        'targets',
        'plan',
        'today_logs',
        'intake',
        'consultation',
        'coach',
        'weight',
        'wearables',
      ]),
    );
    expect(query_count).toBeLessThanOrEqual(ROMAN_CONTEXT_MAX_QUERIES);
  });
});

// ─── renderer ────────────────────────────────────────────────────────────────

describe('R3 renderer — delimiting, hash and the token cap', () => {
  it('wraps the block with as_of + version, the data-not-instructions notice, and a stable sha256', async () => {
    const { svc } = setup();
    const a = await svc.buildFresh(student(P1), NOW);
    const b = await svc.buildFresh(student(P1), NOW);
    expect(
      a.rendered.startsWith(
        `<client_data as_of="${LOCAL_TODAY_PT} 17:30 America/Los_Angeles" version="ctx-v2">`,
      ),
    ).toBe(true);
    expect(a.rendered.endsWith('</client_data>')).toBe(true);
    expect(a.rendered).toContain(ROMAN_CLIENT_DATA_NOTICE);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.hash).toBe(b.hash);
    expect(a.estimated_tokens).toBeLessThanOrEqual(ROMAN_CONTEXT_HARD_CAP_TOKENS);
    expect(a.estimated_tokens).toBeGreaterThan(200);
  });

  it('over the cap it drops blocks in the plan order and records each drop', async () => {
    const { svc } = setup();
    const { context } = await svc.build(student(P1), NOW);
    const big: RomanClientContext = JSON.parse(JSON.stringify(context));
    const pad = (n: number) => 'x'.repeat(n);
    big.logged_workouts = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-2${i}`,
      name: pad(60),
      type: 'cardio',
      duration_minutes: 30,
      intensity: 'light',
      exercise_count: 3,
    }));
    big.check_ins = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-2${i}`,
      type: 'morning',
      mood: 3,
      energy: 3,
      soreness: 3,
      sleep_hours: 7,
      notes: pad(140),
    }));
    big.meal_plan = { title: 'Big', items: Array.from({ length: 12 }, () => pad(120)) };
    big.coach.recent_messages = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-2${i}`,
      from: (i % 2 ? 'client' : 'coach') as 'client' | 'coach',
      excerpt: pad(200),
    }));
    big.wearables.days = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-2${i}`,
      steps: 8000,
      active_kcal: 400,
      resting_hr_bpm: 58,
      hrv_ms: 44,
      sleep_hours: 7.1,
      sleep_efficiency_pct: 88,
      recovery_score: 70,
      readiness_score: 72,
    }));
    big.community_posts = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-2${i}`,
      scope: 'cohort',
      title: pad(80),
      excerpt: pad(200),
    }));
    big.today.entries = Array.from({ length: 16 }, (_, i) => ({
      meal: 'lunch',
      name: pad(60),
      kcal: 300,
      protein_g: 20,
      logged_at: `2026-09-30T1${i % 10}:00:00.000Z`,
    }));
    big.consultation.answers = Array.from({ length: 30 }, () => ({
      question: pad(80),
      answer: pad(200),
    }));
    big.safety_intake.screen_answers = Array.from({ length: 12 }, () => ({
      question: pad(80),
      answer: pad(200),
    }));
    big.coach.guidelines = pad(1500);
    big.profile.bio = pad(240);
    big.profile.injuries = Array.from({ length: 5 }, () => pad(200));
    big.profile.food_preferences = pad(400);
    big.last_7_days.days = Array.from({ length: 6 }, (_, i) => ({
      date: `2026-09-2${i}`,
      kcal: 1500,
      protein_g: 100,
      carbs_g: 150,
      fat_g: 50,
      meals_logged: 3,
    }));
    if (big.plan) {
      big.plan.recent_completions = Array.from({ length: 10 }, (_, i) => ({
        date: `2026-09-1${i}`,
        name: pad(80),
        post_rpe: 7,
        has_notes: true,
        notes: pad(140),
      }));
      big.plan.next_session!.exercises = Array.from({ length: 8 }, () => ({
        name: pad(60),
        sets: 3,
        reps_or_duration_seconds: 10,
        cue: pad(80),
      }));
      big.plan.today_session = big.plan.next_session;
    }
    const untruncated = JSON.stringify(big).length / 4;
    expect(untruncated).toBeGreaterThan(ROMAN_CONTEXT_HARD_CAP_TOKENS);

    const r = renderClientContext(big);
    expect(r.estimated_tokens).toBeLessThanOrEqual(ROMAN_CONTEXT_HARD_CAP_TOKENS);
    const order = [
      'wearables.days',
      'community_posts',
      'today.entries',
      'consultation.answers',
      'logged_workouts',
      'check_ins.notes',
      'meal_plan.items',
      'coach.recent_messages',
      'last_7_days.days',
      'plan.recent_completions',
      'safety_intake.screen_answers.unflagged',
      'coach.guidelines.short',
    ];
    expect(r.context.data_quality.truncated.length).toBeGreaterThan(0);
    expect(r.context.data_quality.truncated).toEqual(
      order.slice(0, r.context.data_quality.truncated.length),
    );
    expect(r.context.logged_workouts).toEqual([]);
    // averages survive even when the per-day detail goes
    expect(r.context.last_7_days.avg_kcal_on_logged_days).toBe(
      big.last_7_days.avg_kcal_on_logged_days,
    );
    // the input is not mutated
    expect(big.logged_workouts).toHaveLength(5);
  });
});

// ─── memo + invalidation (G30 freshness) ─────────────────────────────────────

describe('R3 memo — 15 s, per (user, local_date), invalidated by write hooks', () => {
  it('reuses within 15 s, rebuilds after invalidation so a new food log changes today.kcal', async () => {
    const { svc, db } = setup();
    const a = await svc.getBundle(student(P1), NOW);
    const b = await svc.getBundle(student(P1), new Date(NOW.getTime() + 5_000));
    expect(b).toBe(a);
    expect(db.calls.filter((c) => c === 'user.findUnique')).toHaveLength(1);

    // "I just logged lunch" — the write path fires the global hook.
    db.raw.loggedFood.push({
      user_id: P1,
      date: new Date('2026-09-30T00:00:00Z'),
      logged_at: new Date('2026-09-30T23:00:00Z'),
      quantity_multiplier: 1,
      food_item: { calories: 400, protein_g: 40, carbs_g: 30, fat_g: 10 },
    });
    romanContextInvalidate(P1);
    const c = await svc.getBundle(student(P1), new Date(NOW.getTime() + 6_000));
    expect(c).not.toBe(a);
    expect(c.context.today.kcal).toBe(1180);
    expect(c.context.today.protein_g).toBe(102);
    expect(c.hash).not.toBe(a.hash);
  });

  it('expires after 15 s and never serves another user’s entry', async () => {
    const { svc, db } = setup();
    await svc.getBundle(student(P1), NOW);
    await svc.getBundle(student(P1), new Date(NOW.getTime() + 15_001));
    expect(db.calls.filter((c) => c === 'user.findUnique')).toHaveLength(2);
    const z = await svc.getBundle(student(P4), NOW);
    expect(z.rendered).not.toContain('Maya');
  });

  it('a local-day rollover invalidates the memo even inside 15 s', async () => {
    const { svc, db } = setup();
    const t1 = new Date('2026-10-01T06:59:55.000Z'); // 23:59:55 PT 09/30
    const t2 = new Date('2026-10-01T07:00:05.000Z'); // 00:00:05 PT 10/01
    const a = await svc.getBundle(student(P1), t1);
    const b = await svc.getBundle(student(P1), t2);
    expect(a.context.identity.local_date).toBe('2026-09-30');
    expect(b.context.identity.local_date).toBe('2026-10-01');
    expect(db.calls.filter((c) => c === 'user.findUnique')).toHaveLength(2);
  });
});

// ─── injection into RomanService ─────────────────────────────────────────────

function makeAnthropic() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    messages: {
      stream: jest.fn((body: Record<string, unknown>) => {
        calls.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'You have 670 kcal left.' },
            };
            yield { type: 'message_delta', usage: { output_tokens: 6 } };
          },
        };
      }),
    },
  };
}
const session = (surface: 'client' | 'coach', user_id: string) => ({
  id: 'sess_1',
  user_id,
  surface,
  day_key: LOCAL_TODAY_PT,
  message_count: 0,
  started_at: NOW,
  last_activity_at: NOW,
  quips_in_session: 0,
  exclamation_used: false,
  subject_context_json: null,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
});
async function drain(gen: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('R3 injection — second system block, provenance columns, coach JWT', () => {
  it('student on the client surface: system is [static, <client_data>], content stays clean, context_hash persisted', async () => {
    const { db, svc } = setup();
    const anthropic = makeAnthropic();
    const roman = new RomanService(db.prisma, asAnthropicDouble(anthropic));
    roman.setClientContext(svc);
    await drain(roman.streamAssistantTurn(student(P1), session('client', P1)));

    expect(anthropic.calls).toHaveLength(1);
    const system = anthropic.calls[0].system as Array<{ type: string; text: string }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(2);
    expect(system[0].text).not.toContain('<client_data');
    expect(system[1].text).toMatch(/^<client_data as_of=/);
    expect(system[1].text).toContain('"first_name":"Maya"');
    for (const c of CANARIES) expect(system[1].text).not.toContain(c);

    const romanTurn = db.raw.romanMessages.find((m) => m.role === 'roman')!;
    expect(romanTurn.content).toBe('You have 670 kcal left.');
    expect(romanTurn.content).not.toContain('client_data');
    expect(romanTurn.context_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(romanTurn.context_generated_at).toBeInstanceOf(Date);
    // the hash is exactly that of the injected block
    const rebuilt = await svc.buildFresh(student(P1), romanTurn.context_generated_at as Date);
    expect(rebuilt.hash).toBe(romanTurn.context_hash);
  });

  it('a coach JWT on the client surface gets NO client data; the coach surface gets none either', async () => {
    const { db, svc } = setup();
    const anthropic = makeAnthropic();
    const roman = new RomanService(db.prisma, asAnthropicDouble(anthropic));
    roman.setClientContext(svc);
    await drain(
      roman.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('client', 'coach-A')),
    );
    await drain(
      roman.streamAssistantTurn({ id: 'coach-A', role: 'coach' }, session('coach', 'coach-A')),
    );
    for (const call of anthropic.calls) {
      expect(typeof call.system).toBe('string');
      expect(call.system as string).not.toContain('<client_data');
      expect(call.system as string).not.toContain('Maya');
    }
    for (const m of db.raw.romanMessages) {
      expect(m.context_hash).toBeNull();
      expect(m.context_generated_at).toBeNull();
    }
    expect(db.calls).not.toContain('loggedFoodEntry.findMany');
  });

  it('without the context service wired (legacy construction) the turn is ungrounded but works', async () => {
    const { db } = setup();
    const anthropic = makeAnthropic();
    const roman = new RomanService(db.prisma, asAnthropicDouble(anthropic));
    const chunks = await drain(roman.streamAssistantTurn(student(P1), session('client', P1)));
    expect(typeof anthropic.calls[0].system).toBe('string');
    expect(chunks.some((c) => (c as { type: string }).type === 'done')).toBe(true);
  });

  it('a builder failure degrades to an ungrounded turn, never a blank reply', async () => {
    const { db, svc } = setup();
    jest.spyOn(svc, 'getBundle').mockRejectedValueOnce(new Error('db down'));
    const anthropic = makeAnthropic();
    const roman = new RomanService(db.prisma, asAnthropicDouble(anthropic));
    roman.setClientContext(svc);
    const chunks = await drain(roman.streamAssistantTurn(student(P1), session('client', P1)));
    expect(typeof anthropic.calls[0].system).toBe('string');
    expect(
      chunks.some(
        (c) =>
          (c as { type: string; text?: string }).type === 'done' &&
          (c as { text: string }).text.length > 0,
      ),
    ).toBe(true);
  });
});

// ─── disclosure endpoint ─────────────────────────────────────────────────────

describe('R3 GET /roman/context/me', () => {
  it('returns the caller’s own structured context and nothing else', async () => {
    const { svc } = setup();
    const ctrl = new RomanContextController(svc);
    const out = await ctrl.me(asAuthedRequestDouble({ user: { id: P1, role: 'student' } }));
    expect(out.version).toBe('ctx-v2');
    expect(out.context.identity.first_name).toBe('Maya');
    expect(out.estimated_tokens).toBeLessThanOrEqual(ROMAN_CONTEXT_HARD_CAP_TOKENS);
    for (const c of CANARIES) expect(JSON.stringify(out)).not.toContain(c);
  });
});

// ─── migration shape ─────────────────────────────────────────────────────────

describe('R3 migration — additive provenance columns', () => {
  const dir = join(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20270202000000_roman_message_context_provenance',
  );
  it('adds two nullable columns to RomanMessage and nothing else', () => {
    const sql = readFileSync(join(dir, 'migration.sql'), 'utf8');
    const statements = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
    expect(statements).toEqual([
      'ALTER TABLE "RomanMessage" ADD COLUMN "context_hash" TEXT;',
      'ALTER TABLE "RomanMessage" ADD COLUMN "context_generated_at" TIMESTAMP(3);',
    ]);
    expect(readFileSync(join(dir, 'down.sql'), 'utf8')).toContain(
      'DROP COLUMN IF EXISTS "context_hash"',
    );
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(
      /model RomanMessage \{[\s\S]*context_hash\s+String\?[\s\S]*context_generated_at DateTime\?/,
    );
  });
});
