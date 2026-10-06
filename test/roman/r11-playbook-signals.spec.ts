/**
 * Roman v1.1 R11-P2: deterministic playbook signals.
 *
 * Pins the slice contract: only the team's own rows are counted (head coach
 * plus active sub-coaches; never another coach, never an archived sub-coach),
 * every client-derived figure needs 3 distinct clients or it is omitted, the
 * output carries aggregates and exercise names only (no client id or name, no
 * coach id, no plan title, no date), and the service makes no model call.
 *
 * The Prisma fake evaluates the service's real `where` / `orderBy` / `take`
 * against seeded rows, so a missing tenancy filter shows up as a wrong number.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaService } from '../../src/prisma.service';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { computeMacros, resolveMacroInputs } from '../../src/macros/macro-calculator';
import {
  PlaybookSignalsService,
  classifyStrengthDay,
  mealsPerDayOfPlan,
  median,
  splitOf,
} from '../../src/roman/playbook/playbook-signals.service';
import { PLAYBOOK_SIGNALS_MIN_CLIENTS } from '../../src/roman/playbook/playbook-signals.types';

// ─── a tiny Prisma fake that honours where / orderBy / take ──────────────────

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (cond instanceof Date || typeof cond !== 'object') {
      if (v instanceof Date && cond instanceof Date ? v.getTime() !== cond.getTime() : v !== cond) return false;
      continue;
    }
    const ops = ['in', 'not', 'gte', 'lte'];
    if (Object.keys(cond).some((o) => ops.includes(o))) {
      if ('in' in cond && !(cond.in as unknown[]).includes(v)) return false;
      if ('not' in cond && cond.not === null && (v === null || v === undefined)) return false;
      if ('gte' in cond && !(v >= cond.gte)) return false;
      if ('lte' in cond && !(v <= cond.lte)) return false;
      continue;
    }
    if (!v || !matches(v, cond)) return false; // to-one relation filter
  }
  return true;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k];
      const y = b[k];
      if (x < y) return dir === 'desc' ? 1 : -1;
      if (x > y) return dir === 'desc' ? -1 : 1;
    }
    return 0;
  });
}

type Tables = Record<string, Row[]>;

function fakePrisma(tables: Tables) {
  const calls: Record<string, Row[]> = {};
  const model = (name: string) => ({
    findMany: jest.fn(async (args: Row = {}) => {
      (calls[name] ??= []).push(args);
      const rows = sortRows((tables[name] ?? []).filter((r) => matches(r, args.where)), args.orderBy);
      return typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
    }),
  });
  const models: Row = {};
  for (const name of [
    'teamSubCoachAssignment',
    'workoutPlanExercise',
    'clientWorkoutAssignment',
    'workoutAdjustmentProposal',
    'macroTarget',
    'dailyMealPlanAssignment',
    'mealPlan',
    'exerciseCatalogItem',
  ]) {
    models[name] = model(name);
  }
  return { prisma: Object.assign(Object.create(null) as PrismaService, models), calls };
}

// ─── fixture: a head coach H with active sub-coach S, an archived sub-coach X,
// and an unrelated coach O, each with distinctive data ───────────────────────

const H = 'coach-head-7f3a';
const S = 'coach-sub-91bd';
const X = 'coach-sub-archived-0c44';
const O = 'coach-other-55e1';
const CLIENTS = ['client-aa11', 'client-bb22', 'client-cc33', 'client-dd44'];
const OTHER_CLIENTS = ['client-oo01', 'client-oo02', 'client-oo03'];
const CLIENT_NAMES = ['Zelda Quill', 'Marcus Fenwick', 'Priya Okonkwo', 'Tobias Wren'];
const PLAN_TITLES = ['Zelda Push Day', 'Marcus Pull Day', 'Legs for Priya', 'Tobias Secret Plan'];
const NOW = new Date('2026-10-06T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const CATALOG: Row[] = [
  ['ex-bench', 'barbell-bench-press', 'seed:push-001', 'Barbell Bench Press', 'pectorals'],
  ['ex-ohp', 'overhead-press', 'seed:push-004', 'Overhead Press', 'front delts'],
  ['ex-pulldown', 'lat-pulldown', 'seed:pull-001', 'Lat Pulldown', 'lats'],
  ['ex-row', 'cable-row', 'seed:pull-002', 'Seated Cable Row', 'mid back'],
  ['ex-squat', 'back-squat', 'seed:legs-001', 'Back Squat', 'quads'],
  ['ex-rdl', 'romanian-deadlift', 'seed:legs-002', 'Romanian Deadlift', 'hamstrings'],
  ['ex-legpress', 'leg-press', 'seed:legs-003', 'Leg Press', 'quads'],
  ['ex-other', 'other-coach-lift', 'seed:other-001', 'Other Coach Lift', 'quads'],
].map(([id, slug, source_ref, name, primary_muscle]) => ({ id, slug, source_ref, name, primary_muscle }));

function profile(over: Row = {}): Row {
  return {
    current_weight_lbs: 200,
    target_weight_lbs: 180,
    height_cm: 180,
    date_of_birth: new Date('1990-01-01T00:00:00.000Z'),
    sex: 'male',
    activity_level: 'moderate',
    goal_type: 'fat_loss',
    ...over,
  };
}

function buildTables(clients: string[] = CLIENTS): Tables {
  const plans: Row[] = [
    { id: 'plan-push', coach_id: H, type: 'strength', archived_at: null, name: PLAN_TITLES[0], ex: ['ex-bench', 'ex-ohp'] },
    { id: 'plan-pull', coach_id: S, type: 'strength', archived_at: null, name: PLAN_TITLES[1], ex: ['ex-pulldown', 'ex-row'] },
    { id: 'plan-legs', coach_id: H, type: 'strength', archived_at: null, name: PLAN_TITLES[2], ex: ['ex-squat', 'ex-rdl', 'ex-squat'] },
    { id: 'plan-archived', coach_id: H, type: 'strength', archived_at: daysAgo(5), name: PLAN_TITLES[3], ex: ['ex-other'] },
    { id: 'plan-x', coach_id: X, type: 'strength', archived_at: null, name: 'X plan', ex: ['ex-other', 'ex-other'] },
    { id: 'plan-o', coach_id: O, type: 'strength', archived_at: null, name: 'O plan', ex: Array(9).fill('ex-other') },
  ];
  const planById = new Map(plans.map((p) => [p.id, p]));
  const workoutPlanExercise = plans.flatMap((p) =>
    (p.ex as string[]).map((exercise_external_id, i) => ({
      workout_plan_id: p.id,
      exercise_external_id,
      order: i,
      archived_at: null,
      workout_plan: { coach_id: p.coach_id, archived_at: p.archived_at },
    })),
  );
  const assign = (client_id: string, coach: string, planId: string, ago: number): Row => ({
    client_id,
    assigned_by_coach_id: coach,
    workout_plan_id: planId,
    scheduled_for: daysAgo(ago),
    workout_plan: { type: planById.get(planId)!.type },
  });
  // NOW is Tuesday 2026-10-06 (UTC). Monday-based weeks: days ago 0-1 are this week, 2-8 last week, 9-15 the week before.
  const team = clients.slice(0, 3);
  const clientWorkoutAssignment: Row[] = [
    ...(team[0] ? [assign(team[0], H, 'plan-push', 1), assign(team[0], S, 'plan-pull', 0), assign(team[0], H, 'plan-legs', 1)] : []),
    ...(team[1] ? [assign(team[1], H, 'plan-push', 3), assign(team[1], S, 'plan-pull', 4), assign(team[1], H, 'plan-legs', 9), assign(team[1], H, 'plan-push', 10)] : []),
    ...(team[2] ? [assign(team[2], H, 'plan-legs', 2), assign(team[2], S, 'plan-pull', 3)] : []),
    // Outside the 90-day window: never counted.
    ...(team[2] ? [assign(team[2], H, 'plan-push', 120)] : []),
    // Another coach and an archived sub-coach: never counted.
    ...OTHER_CLIENTS.flatMap((c) => [0, 1, 2, 3, 4, 5].map((d) => assign(c, O, 'plan-o', d))),
    assign(clients[0], X, 'plan-x', 1),
  ];

  const proposal = (client_id: string, coach_id: string, status: string, extra: Row = {}): Row => ({
    client_id,
    coach_id,
    rule_key: 'recovery_volume',
    status,
    created_at: daysAgo(10),
    proposed_change: { volume_pct: 20, exercises: [] },
    applied_change: null,
    before_exercises: null,
    dismiss_reason: null,
    ...extra,
  });
  const swap = {
    applied_change: { volume_pct: 20, exercises: [{ order: 0, exercise_external_id: 'ex-legpress', sets_before: 4, sets_after: 3 }] },
    before_exercises: [{ order: 0, exercise_external_id: 'ex-squat', sets: 4 }],
  };
  const workoutAdjustmentProposal: Row[] = [
    ...(team[0] ? [proposal(team[0], H, 'approved', swap)] : []),
    ...(team[1] ? [proposal(team[1], S, 'approved', swap)] : []),
    ...(team[2]
      ? [
          proposal(team[2], H, 'edited', { ...swap, applied_change: { ...swap.applied_change, volume_pct: 30 } }),
          proposal(team[2], H, 'dismissed', { dismiss_reason: 'disagree' }),
          // A one-client swap stays private: under 3 clients, omitted.
          proposal(team[2], H, 'approved', {
            applied_change: { volume_pct: 10, exercises: [{ order: 1, exercise_external_id: 'ex-row' }] },
            before_exercises: [{ order: 1, exercise_external_id: 'ex-pulldown' }],
          }),
          proposal(team[2], H, 'pending'),
        ]
      : []),
    ...OTHER_CLIENTS.map((c) => proposal(c, O, 'dismissed', { dismiss_reason: 'other' })),
  ];

  const target = (client_id: string, coach_id: string, protein_g: number, calories_kcal: number, ago: number, prof: Row): Row => ({
    client_id,
    coach_id,
    protein_g,
    calories_kcal,
    archived_at: null,
    effective_from: daysAgo(ago),
    created_at: daysAgo(ago),
    client: { profile: prof },
  });
  const macroTarget: Row[] = [
    ...(team[0] ? [target(team[0], H, 180, 2000, 5, profile()), target(team[0], H, 90, 1000, 40, profile())] : []),
    ...(team[1] ? [target(team[1], S, 150, 2100, 5, profile({ target_weight_lbs: null, current_weight_lbs: 150 }))] : []),
    ...(team[2] ? [target(team[2], H, 200, 2200, 5, profile({ target_weight_lbs: 160 }))] : []),
    ...OTHER_CLIENTS.map((c) => target(c, O, 400, 900, 1, profile())),
  ];

  const daily = (client_id: string, coach: string, slots: number, ago: number): Row => ({
    client_id,
    assigned_by_coach_id: coach,
    starts_on: daysAgo(ago),
    daily_meal_plan: { coach_id: coach, _count: { slots } },
  });
  const dailyMealPlanAssignment: Row[] = [
    ...(team[0] ? [daily(team[0], H, 4, 3), daily(team[0], H, 6, 30)] : []),
    ...(team[1] ? [daily(team[1], S, 3, 3)] : []),
    ...OTHER_CLIENTS.map((c) => daily(c, O, 9, 1)),
  ];
  const mealPlan: Row[] = [
    ...(team[2]
      ? [
          {
            client_id: team[2],
            coach_id: H,
            archived_at: null,
            created_at: daysAgo(2),
            title: PLAN_TITLES[2],
            items: [],
            days: [{ meals: [{}, {}, {}, {}, {}] }, { meals: [{}, {}, {}, {}, {}] }],
          },
        ]
      : []),
    { client_id: OTHER_CLIENTS[0], coach_id: O, archived_at: null, created_at: daysAgo(1), items: [], days: [{ meals: [{}] }] },
  ];

  return {
    teamSubCoachAssignment: [
      { head_coach_id: H, sub_coach_id: S, archived_at: null },
      { head_coach_id: H, sub_coach_id: X, archived_at: daysAgo(30) },
      { head_coach_id: O, sub_coach_id: 'coach-sub-of-o', archived_at: null },
    ],
    workoutPlanExercise,
    clientWorkoutAssignment,
    workoutAdjustmentProposal,
    macroTarget,
    dailyMealPlanAssignment,
    mealPlan,
    exerciseCatalogItem: CATALOG,
  };
}

const budget = Object.assign(Object.create(null) as CoachAIBudgetService, {
  resolveHeadCoachId: jest.fn(async (id: string) => (id === S || id === X ? H : id)),
});

function service(tables: Tables) {
  const { prisma, calls } = fakePrisma(tables);
  return { svc: new PlaybookSignalsService(prisma, budget), calls };
}

const expectedTdee = (over: Row = {}) => {
  const r = resolveMacroInputs(profile(over), NOW);
  if (!r.ok) throw new Error('fixture profile must resolve');
  return computeMacros(r.inputs).tdee;
};

describe('R11-P2 playbook signals: tenancy (only the team’s own rows)', () => {
  it('counts the head coach and its active sub-coach, never another coach or an archived sub-coach', async () => {
    const { svc, calls } = service(buildTables());
    const out = await svc.compute(H, { now: NOW });

    expect(out.team_size).toBe(2);
    // Every query is bounded to the team ids.
    for (const name of ['clientWorkoutAssignment', 'macroTarget', 'workoutAdjustmentProposal', 'mealPlan']) {
      const where = calls[name][0].where;
      const ids = (where.coach_id ?? where.assigned_by_coach_id).in;
      expect([...ids].sort()).toEqual([H, S].sort());
    }

    // Exercises: archived plan, archived sub-coach and coach O are excluded.
    expect(out.top_exercises.map((e) => e.name)).not.toContain('Other Coach Lift');
    expect(out.top_exercises[0]).toEqual({ name: 'Back Squat', times_programmed: 2 });
    expect(out.top_exercises).toHaveLength(6);

    // Schedule: c1 3/1wk, c2 4/2wk, c3 2/1wk -> median 2; coach O's 6/wk never counted.
    expect(out.schedule).not.toBeNull();
    expect(out.schedule!.clients).toBe(3);
    expect(out.schedule!.sessions_per_week_median).toBe(2);
    expect(out.schedule!.split).toBe('push_pull_legs');
    expect(out.schedule!.day_type_pct).toEqual({ push: 33, pull: 33, lower: 33 });

    // #655: coach O's three dismissals are not in the counts.
    expect(out.adjustments).toEqual([
      {
        rule_key: 'recovery_volume',
        decided: 5,
        approved_unedited: 3,
        edited: 1,
        dismissed: 1,
        undone: 0,
        unedited_approval_pct: 60,
        edit_volume_delta_median_pp: 10,
        dismiss_reasons: { disagree: 1 },
        clients: 3,
      },
    ]);
    // Swap seen on 3 clients is kept; the one-client swap is omitted.
    expect(out.substitutions).toEqual([{ from: 'Back Squat', to: 'Leg Press', times: 3 }]);

    // Macros: latest target per client only; coach O's 400 g / 900 kcal never counted.
    expect(out.macros).not.toBeNull();
    expect(out.macros!.clients).toBe(3);
    expect(out.macros!.protein_g_per_lb_median).toBe(1); // 180/180, 150/150, 200/160
    const deficits = [
      ((expectedTdee() - 2000) / expectedTdee()) * 100,
      ((expectedTdee({ target_weight_lbs: null, current_weight_lbs: 150 }) - 2100) /
        expectedTdee({ target_weight_lbs: null, current_weight_lbs: 150 })) * 100,
      ((expectedTdee({ target_weight_lbs: 160 }) - 2200) / expectedTdee({ target_weight_lbs: 160 })) * 100,
    ];
    expect(out.macros!.deficit_pct_median).toBe(Math.round(median(deficits)!));
    expect(out.macros!.surplus_pct_median).toBeNull();

    // Meals: latest day plan (4, not the older 6), 3 slots, 5 meals -> median 4.
    expect(out.meals).toEqual({ meals_per_day_median: 4, clients: 3 });
  });

  it('a sub-coach resolves to its head coach and gets the same team signals', async () => {
    const a = await service(buildTables()).svc.compute(H, { now: NOW });
    const b = await service(buildTables()).svc.compute(S, { now: NOW });
    expect(b).toEqual(a);
  });

  it('another coach sees only its own data', async () => {
    const out = await service(buildTables()).svc.compute(O, { now: NOW });
    expect(out.top_exercises).toEqual([{ name: 'Other Coach Lift', times_programmed: 9 }]);
    expect(out.macros!.protein_g_per_lb_median).toBe(2.22); // 400 g / 180 lb
    expect(out.meals!.meals_per_day_median).toBe(9);
    expect(out.substitutions).toEqual([]);
  });
});

describe('R11-P2 playbook signals: 3-client minimum', () => {
  it(`omits every client-derived figure under ${PLAYBOOK_SIGNALS_MIN_CLIENTS} clients`, async () => {
    const out = await service(buildTables(CLIENTS.slice(0, 2))).svc.compute(H, { now: NOW });
    expect(out.macros).toBeNull();
    expect(out.meals).toBeNull();
    expect(out.schedule).toBeNull();
    expect(out.adjustments).toEqual([]);
    expect(out.substitutions).toEqual([]);
    // Coach-authored plan contents are not client data and stay.
    expect(out.top_exercises.length).toBeGreaterThan(0);
  });

  it('clientIds (consenting clients) narrows client-derived figures and can drop them under the floor', async () => {
    const { svc, calls } = service(buildTables());
    const out = await svc.compute(H, { now: NOW, clientIds: CLIENTS.slice(0, 2) });
    expect(calls.macroTarget[0].where.client_id).toEqual({ in: CLIENTS.slice(0, 2) });
    expect(calls.mealPlan[0].where.client_id).toEqual({ in: CLIENTS.slice(0, 2) });
    expect(out.macros).toBeNull();
    expect(out.meals).toBeNull();
    expect(out.schedule).toBeNull();
    expect(out.adjustments).toEqual([]);
  });

  it('a sub-metric under the floor is null while the others stay', async () => {
    const t = buildTables();
    // Only two fat-loss clients resolve a maintenance estimate.
    t.macroTarget = t.macroTarget.map((r) =>
      r.client_id === CLIENTS[2] ? { ...r, client: { profile: profile({ target_weight_lbs: 160, date_of_birth: null }) } } : r,
    );
    const out = await service(t).svc.compute(H, { now: NOW });
    expect(out.macros!.protein_g_per_lb_median).toBe(1);
    expect(out.macros!.deficit_pct_median).toBeNull();
  });
});

describe('R11-P2 playbook signals: output privacy and no egress', () => {
  it('the output carries no client id or name, no coach id, no plan title and no date', async () => {
    const out = await service(buildTables()).svc.compute(H, { now: NOW });
    const json = JSON.stringify(out);
    for (const s of [...CLIENTS, ...OTHER_CLIENTS, ...CLIENT_NAMES, ...PLAN_TITLES, H, S, X, O]) {
      expect(json).not.toContain(s);
    }
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(json).not.toMatch(/client-|coach-|plan-|ex-[a-z]/);
  });

  it('makes no model call and imports no egress or provider client', () => {
    const src = readFileSync(join(__dirname, '../../src/roman/playbook/playbook-signals.service.ts'), 'utf8');
    expect(src).not.toMatch(/ai-egress|anthropic|ROMAN_ANTHROPIC_CLIENT|fetch\(|axios|\.create\(|\.update|\.upsert|\.delete/);
  });
});

describe('R11-P2 playbook signals: pure helpers', () => {
  it('classifies strength days from primary muscles', () => {
    expect(classifyStrengthDay(['pectorals', 'front delts', 'triceps'])).toBe('push');
    expect(classifyStrengthDay(['lats', 'mid back', 'biceps'])).toBe('pull');
    expect(classifyStrengthDay(['quads', 'hamstrings', 'glutes', 'core'])).toBe('lower');
    expect(classifyStrengthDay(['pectorals', 'lats'])).toBe('upper');
    expect(classifyStrengthDay(['pectorals', 'lats', 'quads', 'hamstrings'])).toBe('full_body');
    expect(classifyStrengthDay(['cardiovascular', 'core'])).toBeNull();
  });

  it('names the split', () => {
    expect(splitOf({ push: 2, pull: 2, lower: 2 })).toBe('push_pull_legs');
    expect(splitOf({ upper: 3, lower: 3 })).toBe('upper_lower');
    expect(splitOf({ full_body: 7, lower: 1, conditioning: 4 })).toBe('full_body');
    expect(splitOf({ upper: 1, full_body: 1, push: 1 })).toBe('mixed');
    expect(splitOf({ conditioning: 5 })).toBe('mixed');
  });

  it('median and meals per day', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mealsPerDayOfPlan([], [{ meals: [{}, {}, {}] }, { meals: [{}, {}, {}, {}] }, { meals: [{}, {}, {}] }])).toBe(3);
    expect(
      mealsPerDayOfPlan([{ time_of_day: 'Breakfast' }, { time_of_day: 'breakfast' }, { time_of_day: 'Lunch' }], null),
    ).toBe(2);
    expect(mealsPerDayOfPlan([{ name: 'oats' }], null)).toBeNull();
  });
});
