/**
 * PLAN-SWAPS-BE (agent 196; C2 Style C S2): a plan meal's swaps and recipe, today's plan changes and plan
 * items on the grocery list. Written first: every test here fails at main 6776238e.
 *
 *   1. the coach meal routes store swaps and a recipe of the coach's own, and refuse another coach's,
 *      an archived or a missing one (MEAL_SWAP_INVALID / MEAL_RECIPE_INVALID);
 *   2. a meal change in a plan edit writes one revision in the same transaction; a time-only edit none;
 *   3. GET /me/meal-plan/today: swaps (name, kcal, protein) only from the client's own coach's live
 *      templates, never another coach's; the recipe only when the client can open it; changes_today
 *      shows a change until midnight in the client's zone, and not after;
 *   4. the grocery bulk add keeps source_plan_slot_id for a slot of the caller's own plan only;
 *   5. today's phone payload for the bulk add still validates, and the new field is checked.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RealMealPlansService } from '../src/real-meal-plans/real-meal-plans.service';
import { ListsService } from '../src/lists/lists.service';
import { ListsController } from '../src/lists/lists.controller';
import {
  ClientMealPlanController,
  CoachDailyMealPlansController,
  CoachMealTemplatesController,
} from '../src/real-meal-plans/real-meal-plans.controller';
import { BulkAddListItemsDto } from '../src/lists/lists.dto';
import { CreateMealTemplateDto, UpdateMealTemplateDto } from '../src/real-meal-plans/real-meal-plans.dto';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  MEAL_RECIPE_INVALID,
  MEAL_SWAP_INVALID,
  localDateKey,
  localDayStartBefore,
  revisionsFor,
} from '../src/real-meal-plans/plan-swaps';
import type { PrismaService } from '../src/prisma.service';

type Row = Record<string, any>;
const stub = <T>(o: unknown) => o as T;

const COACH = 'coach-a';
const OTHER = 'coach-b';
const CLIENT = 'client-1';
const MOVED = 'client-2';
const ZONE = 'America/New_York';

function inMatch(where: Row | undefined, row: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as Row[]).every((w) => inMatch(w, row));
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
    if (v && typeof v === 'object') return true; // relation filters are checked by the test's own setup
    return row[k] === v;
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function world() {
  const users: Row[] = [
    { id: CLIENT, role: 'student', coach_id: COACH },
    { id: MOVED, role: 'student', coach_id: OTHER },
  ];
  const templates: Row[] = [
    { id: 'tpl-oats', coach_id: COACH, name: 'Oats', calories_kcal: 400, protein_g: 20, archived_at: null, swap_template_ids: ['tpl-eggs', 'tpl-old', 'tpl-b'], recipe_id: 'rec-a' },
    { id: 'tpl-eggs', coach_id: COACH, name: 'Eggs', calories_kcal: 300, protein_g: 25, archived_at: null, swap_template_ids: [], recipe_id: 'rec-private' },
    { id: 'tpl-old', coach_id: COACH, name: 'Old', calories_kcal: 1, protein_g: 1, archived_at: new Date('2026-01-01'), swap_template_ids: [], recipe_id: null },
    { id: 'tpl-b', coach_id: OTHER, name: 'Theirs', calories_kcal: 500, protein_g: 30, archived_at: null, swap_template_ids: [], recipe_id: null },
  ];
  const recipes: Row[] = [
    { id: 'rec-a', created_by_id: COACH, is_public: true },
    { id: 'rec-private', created_by_id: COACH, is_public: false },
    { id: 'rec-b', created_by_id: OTHER, is_public: true },
  ];
  const plans: Row[] = [{ id: 'plan-a', coach_id: COACH, archived_at: null }];
  const slots: Row[] = [
    { id: 'slot-b', daily_meal_plan_id: 'plan-a', slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats', time_of_day: null },
    { id: 'slot-l', daily_meal_plan_id: 'plan-a', slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs', time_of_day: null },
  ];
  const assignments: Row[] = [
    { id: 'as-1', daily_meal_plan_id: 'plan-a', client_id: CLIENT },
    { id: 'as-2', daily_meal_plan_id: 'plan-a', client_id: MOVED },
  ];
  const revisions: Row[] = [];
  const listItems: Row[] = [];
  let seq = 0;
  const inTx = { depth: 0 };
  const writesOutsideTx: string[] = [];
  const track = (name: string) => {
    if (inTx.depth === 0) writesOutsideTx.push(name);
  };
  const withTemplate = (s: Row) => ({ ...s, meal_template: templates.find((t) => t.id === s.meal_template_id) });

  const prisma: Row = {
    user: {
      findFirst: jest.fn(async ({ where }: Row) => users.find((u) => u.id === where.id) ?? null),
      findUnique: jest.fn(async ({ where }: Row) => users.find((u) => u.id === where.id) ?? null),
    },
    notificationPreferences: {
      findUnique: jest.fn(async () => ({ timezone: ZONE, timezone_updated_at: new Date('2026-10-01') })),
    },
    coachProfile: { findUnique: jest.fn(async () => null) },
    userProfile: { findUnique: jest.fn(async () => null) },
    coachingSession: { findUnique: jest.fn(async () => null) },
    recipe: {
      findFirst: jest.fn(async ({ where }: Row) => recipes.find((r) => inMatch(where, r)) ?? null),
      // visibleRecipesWhere: the client's own, or a shared recipe of the client's coach.
      findMany: jest.fn(async ({ where }: Row) => {
        const [ids] = where.AND as Row[];
        return recipes.filter((r) => inMatch(ids, r) && r.is_public && r.created_by_id === COACH).map((r) => ({ id: r.id }));
      }),
    },
    mealTemplate: {
      count: jest.fn(async ({ where }: Row) => templates.filter((t) => inMatch(where, t)).length),
      findFirst: jest.fn(async ({ where }: Row) => templates.find((t) => inMatch(where, t)) ?? null),
      findMany: jest.fn(async ({ where, select }: Row) => templates.filter((t) => inMatch(where, t)).map((t) => pick(t, select))),
      create: jest.fn(async ({ data }: Row) => {
        const row = { id: `tpl-new-${++seq}`, archived_at: null, ...data };
        templates.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: Row) => Object.assign(templates.find((t) => t.id === where.id)!, data)),
    },
    dailyMealPlan: {
      findFirst: jest.fn(async ({ where }: Row) => plans.find((p) => p.id === where.id && p.coach_id === where.coach_id) ?? null),
      update: jest.fn(async ({ where, data }: Row) => {
        track('dailyMealPlan.update');
        return Object.assign(plans.find((p) => p.id === where.id)!, data);
      }),
      findUnique: jest.fn(async ({ where }: Row) => ({ ...plans.find((p) => p.id === where.id), slots: slots.filter((s) => s.daily_meal_plan_id === where.id).map(withTemplate) })),
    },
    dailyMealPlanSlot: {
      findMany: jest.fn(async ({ where }: Row) => {
        if (where.id?.in) {
          // lists: a slot of a plan assigned to where.daily_meal_plan.assignments.some.client_id
          const client = where.daily_meal_plan.assignments.some.client_id;
          return slots
            .filter((s) => where.id.in.includes(s.id))
            .filter((s) => assignments.some((a) => a.daily_meal_plan_id === s.daily_meal_plan_id && a.client_id === client))
            .map((s) => ({ id: s.id }));
        }
        // FIX-1221R2: updateTemplate's lookup of the plans whose slots hold a meal.
        if (where.meal_template_id) return slots.filter((s) => s.meal_template_id === where.meal_template_id).map((s) => ({ ...s }));
        return slots.filter((s) => s.daily_meal_plan_id === where.daily_meal_plan_id).map((s) => ({ ...s }));
      }),
      deleteMany: jest.fn(async ({ where }: Row) => {
        track('dailyMealPlanSlot.deleteMany');
        for (const id of where.id.in) slots.splice(slots.findIndex((s) => s.id === id), 1);
        return { count: where.id.in.length };
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        track('dailyMealPlanSlot.update');
        return Object.assign(slots.find((s) => s.id === where.id)!, data);
      }),
      createMany: jest.fn(async ({ data }: Row) => {
        track('dailyMealPlanSlot.createMany');
        for (const d of data) slots.push({ id: `slot-new-${++seq}`, ...d });
        return { count: data.length };
      }),
    },
    dailyMealPlanRevision: {
      createMany: jest.fn(async ({ data }: Row) => {
        track('dailyMealPlanRevision.createMany');
        revisions.push(...data);
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where, take }: Row) =>
        where.OR
          // FIX-1221R2: updateTemplate's lookup of the plans whose changes name a meal.
          ? revisions.filter((r) => (where.OR as Row[]).some((w) => Object.entries(w).every(([k, v]) => r[k] === v)))
          : revisions
            .filter((r) => where.plan_id.in.includes(r.plan_id) && r.changed_at >= where.changed_at.gte && r.changed_at <= where.changed_at.lte)
            .sort((a, b) => a.changed_at - b.changed_at)
            .slice(0, take),
      ),
    },
    dailyMealPlanAssignment: {
      // Every client of plan-a is treated as still the coach's here, so no edit freezes a copy
      // (the frozen copy is the live suites' job: test/rls/food-entry-plan-link-rls.spec.ts).
      findMany: jest.fn(async ({ where }: Row) => {
        if (!where.client_id) return [];
        return assignments
          .filter((a) => a.client_id === where.client_id)
          .map((a) => {
            const plan = plans.find((p) => p.id === a.daily_meal_plan_id)!;
            return { ...a, daily_meal_plan: { ...plan, slots: slots.filter((s) => s.daily_meal_plan_id === plan.id).map(withTemplate) } };
          });
      }),
    },
    loggedFoodEntry: { updateMany: jest.fn(async () => ({ count: 0 })) },
    listItem: {
      create: jest.fn((args: Row) => {
        listItems.push(args.data);
        return args;
      }),
    },
  };
  prisma.$transaction = jest.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return arg;
    inTx.depth++;
    try {
      return await (arg as (tx: Row) => unknown)(prisma);
    } finally {
      inTx.depth--;
    }
  });
  const meals = new RealMealPlansService(stub<PrismaService>(prisma));
  const lists = new ListsService(stub<PrismaService>(prisma));
  return { prisma, meals, lists, templates, plans, slots, revisions, listItems, writesOutsideTx, assignments };
}

const base = { name: 'Bowl', calories_kcal: 500, protein_g: 30, carbs_g: 50, fats_g: 15 };
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { getResponse?: () => Row }).getResponse?.()?.code ?? String(e);
  }
};

afterEach(() => jest.useRealTimers());

describe('PLAN-SWAPS-BE 1: a meal template carries the coach\'s own swaps and recipe', () => {
  it('stores swaps and a recipe of the coach\'s own on create and update', async () => {
    const { meals } = world();
    const made = await meals.createTemplate(COACH, { ...base, swap_template_ids: ['tpl-oats', 'tpl-eggs'], recipe_id: 'rec-a' });
    expect(made).toMatchObject({ swap_template_ids: ['tpl-oats', 'tpl-eggs'], recipe_id: 'rec-a' });
    const plain = await meals.createTemplate(COACH, base);
    expect(plain).toMatchObject({ swap_template_ids: [], recipe_id: null });
    const edited = await meals.updateTemplate(COACH, 'tpl-eggs', { swap_template_ids: ['tpl-oats'], recipe_id: null });
    expect(edited).toMatchObject({ swap_template_ids: ['tpl-oats'], recipe_id: null });
  });

  it.each([
    ['another coach\'s template', ['tpl-b']],
    ['an archived template', ['tpl-old']],
    ['a missing template', ['tpl-nope']],
    ['one good and one bad', ['tpl-eggs', 'tpl-b']],
  ])('refuses %s as a swap with MEAL_SWAP_INVALID', async (_what, ids) => {
    const { meals, templates } = world();
    const before = templates.length;
    expect(await codeOf(meals.createTemplate(COACH, { ...base, swap_template_ids: ids }))).toBe(MEAL_SWAP_INVALID);
    // FIX-1221 (LO-1221 C1): the update is on a meal that stores none of these, since a meal's own
    // stored swaps are accepted back (next test).
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-eggs', { swap_template_ids: ids }))).toBe(MEAL_SWAP_INVALID);
    expect(templates.length).toBe(before);
    expect(templates.find((t) => t.id === 'tpl-eggs')!.swap_template_ids).toEqual([]);
  });

  it('FIX-1221 (LO-1221 C1): saves back the swaps a meal already stores, even one archived since', async () => {
    const { meals, templates } = world();
    const oats = templates.find((t) => t.id === 'tpl-oats')!;
    const stored = [...oats.swap_template_ids]; // includes tpl-old, archived after it was linked
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-oats', { name: 'Oats bowl', swap_template_ids: stored, recipe_id: oats.recipe_id }))).toBe('no error');
    expect(oats).toMatchObject({ name: 'Oats bowl', swap_template_ids: stored });
    // Adding an archived one is still refused, and a stored list cannot smuggle in a new bad id.
    oats.swap_template_ids = ['tpl-eggs'];
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-oats', { swap_template_ids: ['tpl-eggs', 'tpl-old'] }))).toBe(MEAL_SWAP_INVALID);
    expect(oats.swap_template_ids).toEqual(['tpl-eggs']);
  });

  it('FIX-1221 (LO-1221 C2): an empty recipe id is MEAL_RECIPE_INVALID, not a database error', async () => {
    const { meals } = world();
    expect(await codeOf(meals.createTemplate(COACH, { ...base, recipe_id: '' }))).toBe(MEAL_RECIPE_INVALID);
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-eggs', { recipe_id: '' }))).toBe(MEAL_RECIPE_INVALID);
  });

  it('refuses a meal as its own swap', async () => {
    const { meals } = world();
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-eggs', { swap_template_ids: ['tpl-eggs'] }))).toBe(MEAL_SWAP_INVALID);
  });

  it.each([
    ['another coach\'s recipe', 'rec-b'],
    ['a missing recipe', 'rec-nope'],
  ])('refuses %s with MEAL_RECIPE_INVALID', async (_what, id) => {
    const { meals } = world();
    expect(await codeOf(meals.createTemplate(COACH, { ...base, recipe_id: id }))).toBe(MEAL_RECIPE_INVALID);
    expect(await codeOf(meals.updateTemplate(COACH, 'tpl-oats', { recipe_id: id }))).toBe(MEAL_RECIPE_INVALID);
  });

  // FIX-1221R2 (LO-1221R2B C2): swap_template_ids is optional string[] (CONTRACT 6641656549); a null is
  // refused by the global pipe (main.ts) with a 400, before the service, never a database error (500).
  it.each([
    ['PATCH /coach/meal-templates/:id', UpdateMealTemplateDto, {}],
    ['POST /coach/meal-templates', CreateMealTemplateDto, base],
  ])('%s with swap_template_ids: null is a 400, and [] still clears', async (_route, metatype, body) => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const run = (value: Row) => pipe.transform({ ...body, ...value }, { type: 'body', metatype: metatype as never });
    await expect(run({ swap_template_ids: null })).rejects.toBeInstanceOf(BadRequestException);
    await expect(run({ swap_template_ids: [] })).resolves.toMatchObject({ swap_template_ids: [] });
    await expect(run({})).resolves.not.toHaveProperty('swap_template_ids');
  });

  it('the DTO bounds the swap list and refuses repeats', async () => {
    const errs = async (body: Row) => (await validate(plainToInstance(CreateMealTemplateDto, { ...base, ...body }))).map((e) => e.property);
    expect(await errs({ swap_template_ids: ['a', 'a'] })).toEqual(['swap_template_ids']);
    expect(await errs({ swap_template_ids: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toEqual(['swap_template_ids']);
    expect(await errs({ swap_template_ids: ['a'], recipe_id: 'r' })).toEqual([]);
  });
});

describe('FIX-1221R2 (LS-1221R2B B1): updateTemplate holds every plan that depends on the meal', () => {
  // Live proof (moved client, real freeze, RLS): test/rls/fix-1221r2-history-dependency-live.spec.ts.
  it.each<[string, string, Row | null, string[]]>([
    ['in a slot', 'tpl-oats', null, ['plan-a']],
    ['named only as from in a change', 'tpl-eggs-old', { from_template_id: 'tpl-eggs-old', to_template_id: 'tpl-eggs' }, ['plan-a', 'plan-h']],
    ['named only as to in a change', 'tpl-eggs-old', { from_template_id: 'tpl-eggs', to_template_id: 'tpl-eggs-old' }, ['plan-a', 'plan-h']],
  ])('a meal %s reaches the moved-client freeze first', async (_what, target, change, want) => {
    const { meals, revisions, templates } = world();
    templates.push({ id: 'tpl-eggs-old', coach_id: COACH, name: 'Eggs old', archived_at: null, swap_template_ids: [], recipe_id: null });
    if (change) {
      revisions.push(
        { id: 'rev-a', plan_id: 'plan-a', slot_id: 'slot-l', slot_label: 'lunch', changed_at: new Date(), ...change },
        { id: 'rev-h', plan_id: 'plan-h', slot_id: 'gone', slot_label: 'lunch', changed_at: new Date(), ...change },
      );
    }
    const freeze = jest
      .spyOn(meals as unknown as { freezeForMovedClients: (...a: unknown[]) => Promise<void> }, 'freezeForMovedClients')
      .mockResolvedValue(undefined);
    await meals.updateTemplate(COACH, target, { name: 'Renamed' });
    expect(freeze).toHaveBeenCalledTimes(1);
    expect((freeze.mock.calls[0][2] as string[]).slice().sort()).toEqual(want);
  });
});

describe('PLAN-SWAPS-BE 2: a meal change in a plan edit writes one revision in the same transaction', () => {
  it('a changed meal writes exactly one from -> to revision, inside the transaction', async () => {
    const { meals, revisions, writesOutsideTx, plans } = world();
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-eggs' },
        { slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    });
    expect(revisions).toEqual([
      expect.objectContaining({ plan_id: 'plan-a', slot_id: 'slot-b', slot_label: 'breakfast', from_template_id: 'tpl-oats', to_template_id: 'tpl-eggs' }),
    ]);
    expect(writesOutsideTx).toEqual([]);
    expect(plans[0].updated_at).toBeInstanceOf(Date);
  });

  it('a removed meal and an added meal each write one revision; a time-only change writes none', async () => {
    const { meals, revisions, slots } = world();
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats', time_of_day: '07:30' },
        { slot_label: 'dinner', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    });
    const dinner = slots.find((s) => s.slot_label === 'dinner')!;
    expect(revisions.map((r) => [r.slot_id, r.slot_label, r.from_template_id, r.to_template_id])).toEqual([
      ['slot-l', 'lunch', 'tpl-eggs', null],
      [dinner.id, 'dinner', null, 'tpl-eggs'],
    ]);
    expect(new Set(revisions.map((r) => r.changed_at.getTime())).size).toBe(1);
  });

  it('an edit with no meal change (name only, or the same slots) writes no revision', async () => {
    const { meals, revisions } = world();
    await meals.updatePlan(COACH, 'plan-a', { name: 'Renamed' });
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats' },
        { slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    });
    expect(revisions).toEqual([]);
  });

  it('revisionsFor is the one rule: changed, removed, added', () => {
    let n = 0;
    const at = new Date('2026-11-04T15:00:00Z');
    const rows = revisionsFor(
      'p',
      [
        { before: { id: 's1', slot_label: 'breakfast', meal_template_id: 'a' }, afterTemplateId: 'b' },
        { before: { id: 's2', slot_label: 'lunch', meal_template_id: 'c' }, afterTemplateId: 'c' },
      ],
      [{ id: 's3', slot_label: 'snack', meal_template_id: 'd' }],
      [{ id: 's4', slot_label: 'dinner', meal_template_id: 'e' }],
      at,
      () => `r${++n}`,
    );
    expect(rows.map((r) => [r.id, r.slot_id, r.from_template_id, r.to_template_id])).toEqual([
      ['r1', 's1', 'a', 'b'],
      ['r2', 's3', 'd', null],
      ['r3', 's4', null, 'e'],
    ]);
  });

  it('FIX-1221 (LO-1221 C3): a meal that only moved (same label and meal, new slot row) writes nothing', () => {
    let n = 0;
    const rows = revisionsFor(
      'p',
      [],
      [{ id: 's1', slot_label: 'breakfast', meal_template_id: 'a' }, { id: 's2', slot_label: 'lunch', meal_template_id: 'c' }],
      [{ id: 's5', slot_label: 'breakfast', meal_template_id: 'a' }, { id: 's6', slot_label: 'lunch', meal_template_id: 'd' }],
      new Date('2026-11-04T15:00:00Z'),
      () => `r${++n}`,
    );
    // FIX-1221R2 (LO-1221R2B C1): what is left under one label pairs as one change.
    expect(rows.map((r) => [r.slot_id, r.from_template_id, r.to_template_id])).toEqual([
      ['s6', 'c', 'd'],
    ]);
  });

  // FIX-1221R2 (LO-1221R2B C1): rows are keyed by label#order, so a removal shifts later meals onto other
  // rows; one removal is still one change. Each case is the plan before and after, as the coach saves it
  // (order is the index across the whole plan, mobile MealPickerScreen), diffed the way updatePlan does.
  it.each<[string, [string, string][], [string, string][], [string, string | null, string | null][]]>([
    ['the first of two snacks removed',
      [['snack', 'apple'], ['snack', 'yogurt']], [['snack', 'yogurt']],
      [['snack', 'apple', null]]],
    ['lunch removed from breakfast, lunch, snack, snack, dinner',
      [['breakfast', 'oats'], ['lunch', 'soup'], ['snack', 'apple'], ['snack', 'yogurt'], ['dinner', 'fish']],
      [['breakfast', 'oats'], ['snack', 'apple'], ['snack', 'yogurt'], ['dinner', 'fish']],
      [['lunch', 'soup', null]]],
    ['a meal added before two snacks',
      [['snack', 'apple'], ['snack', 'yogurt']], [['breakfast', 'oats'], ['snack', 'apple'], ['snack', 'yogurt']],
      [['breakfast', null, 'oats']]],
    ['one snack changed, the other kept',
      [['snack', 'apple'], ['snack', 'yogurt']], [['snack', 'pear'], ['snack', 'yogurt']],
      [['snack', 'apple', 'pear']]],
    ['the second snack removed and the first changed',
      [['snack', 'apple'], ['snack', 'yogurt']], [['snack', 'pear']],
      [['snack', 'apple', 'pear'], ['snack', 'yogurt', null]]],
    ['the two snacks swapped round', [['snack', 'apple'], ['snack', 'yogurt']], [['snack', 'yogurt'], ['snack', 'apple']], []],
  ])('one change per meal: %s', (_what, beforePlan, afterPlan, want) => {
    let n = 0;
    const key = (label: string, order: number) => `${label}#${order}`;
    const before = beforePlan.map(([slot_label, meal_template_id], order) => ({ id: `old-${order}`, slot_label, order, meal_template_id }));
    const after = new Map(afterPlan.map(([slot_label, meal_template_id], order) => [key(slot_label, order), { slot_label, order, meal_template_id }]));
    const kept = before.filter((b) => after.has(key(b.slot_label, b.order)))
      .map((b) => ({ before: b, afterTemplateId: after.get(key(b.slot_label, b.order))!.meal_template_id }));
    const removed = before.filter((b) => !after.has(key(b.slot_label, b.order)));
    const had = new Set(before.map((b) => key(b.slot_label, b.order)));
    const added = [...after.entries()].filter(([k]) => !had.has(k)).map(([k, a]) => ({ id: `new-${k}`, ...a }));
    const rows = revisionsFor('p', kept, removed, added, new Date('2026-11-04T15:00:00Z'), () => `r${++n}`);
    expect(rows.map((r) => [r.slot_label, r.from_template_id, r.to_template_id])).toEqual(want);
  });

  it('FIX-1221R2 (LO-1221R2B C1): removing the first of two snacks through the coach route writes one removal', async () => {
    const { meals, revisions, slots } = world();
    slots.push(
      { id: 'slot-s0', daily_meal_plan_id: 'plan-a', slot_label: 'snack', order: 2, meal_template_id: 'tpl-oats', time_of_day: null },
      { id: 'slot-s1', daily_meal_plan_id: 'plan-a', slot_label: 'snack', order: 3, meal_template_id: 'tpl-eggs', time_of_day: null },
    );
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats' },
        { slot_label: 'lunch', order: 1, meal_template_id: 'tpl-eggs' },
        { slot_label: 'snack', order: 2, meal_template_id: 'tpl-eggs' },
      ],
    });
    expect(revisions.map((r) => [r.slot_label, r.from_template_id, r.to_template_id])).toEqual([
      ['snack', 'tpl-oats', null],
    ]);
  });

  it('FIX-1221 (LO-1221 C3): reordering a plan through the coach route writes no revision', async () => {
    const { meals, revisions } = world();
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 1, meal_template_id: 'tpl-oats' },
        { slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    });
    expect(revisions).toEqual([]);
  });
});

describe('PLAN-SWAPS-BE 3: GET /me/meal-plan/today adds swaps, the recipe and changes_today', () => {
  it('returns the coach\'s live swaps (name, kcal, protein) for the client\'s own plan, never another coach\'s template', async () => {
    const { meals } = world();
    const today = await meals.getTodayForClient(CLIENT);
    const [breakfast, lunch] = today.assignments[0].daily_meal_plan.slots;
    expect(breakfast.swaps).toEqual([{ id: 'tpl-eggs', name: 'Eggs', calories_kcal: 300, protein_g: 25 }]);
    expect(breakfast.recipe_id).toBe('rec-a');
    // The template's raw ids (an archived meal, another coach's id) never reach the client.
    expect(breakfast.meal_template).not.toHaveProperty('swap_template_ids');
    expect(breakfast.meal_template).not.toHaveProperty('recipe_id');
    expect(lunch.swaps).toEqual([]);
    // rec-private is the coach's but not shared with clients: no dead-end link.
    expect(lunch.recipe_id).toBeNull();
  });

  it('a client who moved to another coach gets no swaps and no recipe from the earlier coach\'s plan', async () => {
    const { meals } = world();
    const today = await meals.getTodayForClient(MOVED);
    for (const s of today.assignments[0].daily_meal_plan.slots) {
      expect(s.swaps).toEqual([]);
      expect(s.recipe_id).toBeNull();
    }
  });

  it('a plan change shows in changes_today until midnight in the client\'s zone, then not', async () => {
    const { meals } = world();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    // 22:00 in New York on Nov 4 (EST) is 03:00 UTC on Nov 5: the UTC day has already turned.
    jest.setSystemTime(new Date('2026-11-05T03:00:00Z'));
    await meals.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-eggs' },
        { slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    });
    jest.setSystemTime(new Date('2026-11-05T04:30:00Z')); // 23:30 New York, still Nov 4 there
    const late = await meals.getTodayForClient(CLIENT);
    expect(late.changes_today).toEqual([
      expect.objectContaining({ plan_id: 'plan-a', slot_id: 'slot-b', slot_label: 'breakfast', from_name: 'Oats', to_template_id: 'tpl-eggs', to_name: 'Eggs' }),
    ]);
    jest.setSystemTime(new Date('2026-11-05T05:01:00Z')); // 00:01 New York, Nov 5
    expect((await meals.getTodayForClient(CLIENT)).changes_today).toEqual([]);
  });

  it('changes_today is empty when ?date names another day than the client\'s today', async () => {
    const { meals, revisions } = world();
    revisions.push({ id: 'r', plan_id: 'plan-a', slot_id: 'slot-b', slot_label: 'breakfast', from_template_id: 'tpl-oats', to_template_id: 'tpl-eggs', changed_at: new Date() });
    const now = new Date();
    expect((await meals.getTodayForClient(CLIENT, localDateKey(now, ZONE))).changes_today).toHaveLength(1);
    expect((await meals.getTodayForClient(CLIENT, '2020-01-01')).changes_today).toEqual([]);
  });
});

describe('PLAN-SWAPS-BE 4: plan items on the grocery list keep source_plan_slot_id', () => {
  it('keeps the slot of the caller\'s own plan and drops another plan\'s or a made-up one', async () => {
    const { lists, slots, plans, assignments, listItems } = world();
    plans.push({ id: 'plan-x', coach_id: OTHER, archived_at: null });
    slots.push({ id: 'slot-x', daily_meal_plan_id: 'plan-x', slot_label: 'dinner', order: 0, meal_template_id: 'tpl-b' });
    assignments.push({ id: 'as-x', daily_meal_plan_id: 'plan-x', client_id: MOVED });
    const out = await lists.bulkAddItems(CLIENT, 'grocery', [
      { name: 'Oats', quantity: 80, unit: 'g', source_plan_slot_id: 'slot-b' },
      { name: 'Steak', source_plan_slot_id: 'slot-x' },
      { name: 'Milk', source_plan_slot_id: 'slot-nope' },
      { name: 'Salt' },
    ]);
    expect(out).toEqual({ added: 4 });
    expect(listItems.map((i) => [i.name, i.source_plan_slot_id])).toEqual([
      ['Oats', 'slot-b'],
      ['Steak', null],
      ['Milk', null],
      ['Salt', null],
    ]);
  });
});

describe('PLAN-SWAPS-BE 5: POST /lists/:type/bulk body', () => {
  const errs = async (body: unknown) =>
    (await validate(plainToInstance(BulkAddListItemsDto, body), { whitelist: true, forbidNonWhitelisted: true }))
      .map((e) => e.property);
  it('today\'s phone payload (PrepGuideScreen) still validates', async () => {
    expect(await errs({ items: [{ name: 'Oats', quantity: 80.5, unit: 'g' }, { name: 'Salt', quantity: 1 }] })).toEqual([]);
    expect(await errs({ items: [{ name: 'Oats', source_recipe_id: 'r1' }] })).toEqual([]);
  });
  it('accepts a plan meal id and refuses a bad item', async () => {
    expect(await errs({ items: [{ name: 'Oats', source_plan_slot_id: 'slot-b' }] })).toEqual([]);
    expect(await errs({ items: [{ name: 'Oats', source_plan_slot_id: 7 }] })).toEqual(['items']);
    expect(await errs({ items: [] })).toEqual(['items']);
    expect(await errs({ items: [{ quantity: 1 }] })).toEqual(['items']);
  });
});

describe('LS-1221 C1: the bounded feed caps today, not yesterday', () => {
  it('does not let 100 revisions from yesterday hide one revision today', async () => {
    const { meals, revisions } = world();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-04T05:01:00Z')); // Nov 4 00:01 New York
    const change = {
      plan_id: 'plan-a', slot_id: 'slot-b', slot_label: 'breakfast',
      from_template_id: 'tpl-oats', to_template_id: 'tpl-eggs',
    };
    for (let n = 0; n < 100; n++) {
      revisions.push({
        ...change, id: `yesterday-${n}`,
        changed_at: new Date('2026-11-04T04:30:00Z'), // Nov 3 23:30 New York
      });
    }
    revisions.push({
      ...change, id: 'today',
      changed_at: new Date('2026-11-04T05:00:30Z'),
    });
    expect((await meals.getTodayForClient(CLIENT)).changes_today).toEqual([
      expect.objectContaining({ plan_id: 'plan-a', changed_at: new Date('2026-11-04T05:00:30Z') }),
    ]);
  });
});

describe('FIX-1221: localDayStartBefore is the local midnight, across DST', () => {
  it.each([
    ['2026-11-04T05:01:00Z', 'America/New_York', '2026-11-04T05:00:00.000Z'],
    ['2026-11-01T20:00:00Z', 'America/New_York', '2026-11-01T04:00:00.000Z'], // 25-hour day (DST ends)
    ['2026-03-08T20:00:00Z', 'America/New_York', '2026-03-08T05:00:00.000Z'], // 23-hour day (DST starts)
    ['2026-11-04T12:00:00Z', 'UTC', '2026-11-04T00:00:00.000Z'],
    ['2026-11-04T12:00:00Z', 'Asia/Kolkata', '2026-11-03T18:30:00.000Z'],
  ])('%s in %s starts at %s', (now, tz, start) => {
    expect(localDayStartBefore(new Date(now), tz).toISOString()).toBe(start);
  });
});

// FIX-1221 (LS-1221 N1): every changed route, called through its controller as the other coach (OTHER)
// and as a client who does not hold the plan or no longer belongs to its coach (MOVED, STRANGER).
describe('FIX-1221: the changed routes as another coach and another client', () => {
  const STRANGER = 'client-3';
  const as = (id: string) => ({ user: { id } }) as never;
  const setup = () => {
    const w = world();
    return {
      ...w,
      templatesRoute: new CoachMealTemplatesController(w.meals),
      plansRoute: new CoachDailyMealPlansController(w.meals),
      todayRoute: new ClientMealPlanController(w.meals),
      listsRoute: new ListsController(w.lists),
    };
  };
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      const r = (e as { getResponse?: () => Row }).getResponse?.();
      return r?.code ?? (e as { getStatus?: () => number }).getStatus?.() ?? String(e);
    }
  };

  it('POST /coach/meal-templates as another coach cannot link this coach\'s meal or recipe', async () => {
    const { templatesRoute, templates } = setup();
    const before = templates.length;
    expect(await status(templatesRoute.create(as(OTHER), { ...base, swap_template_ids: ['tpl-eggs'] } as never))).toBe(MEAL_SWAP_INVALID);
    expect(await status(templatesRoute.create(as(OTHER), { ...base, recipe_id: 'rec-a' } as never))).toBe(MEAL_RECIPE_INVALID);
    expect(templates.length).toBe(before);
  });

  it('GET and PATCH /coach/meal-templates/:id as another coach are 404 and change nothing', async () => {
    const { templatesRoute, templates } = setup();
    expect(await status(templatesRoute.get(as(OTHER), 'tpl-oats'))).toBe(404);
    expect(await status(templatesRoute.update(as(OTHER), 'tpl-oats', { swap_template_ids: ['tpl-b'] } as never))).toBe(404);
    expect(templates.find((t) => t.id === 'tpl-oats')!.swap_template_ids).toEqual(['tpl-eggs', 'tpl-old', 'tpl-b']);
  });

  it('PATCH /coach/daily-meal-plans/:id as another coach is 404 and writes no revision', async () => {
    const { plansRoute, revisions, slots } = setup();
    expect(await status(plansRoute.update(as(OTHER), 'plan-a', {
      slots: [{ slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-b' }],
    } as never))).toBe(404);
    expect(revisions).toEqual([]);
    expect(slots.find((s) => s.id === 'slot-b')!.meal_template_id).toBe('tpl-oats');
  });

  it('GET /me/meal-plan/today: a moved client gets no swaps or recipe; another coach and a stranger get nothing', async () => {
    const { todayRoute, plansRoute } = setup();
    await plansRoute.update(as(COACH), 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-eggs' },
        { slot_label: 'lunch', order: 0, meal_template_id: 'tpl-eggs' },
      ],
    } as never);
    const own = await todayRoute.today(as(CLIENT));
    expect(own.changes_today).toHaveLength(1);
    const moved = await todayRoute.today(as(MOVED));
    for (const a of moved.assignments as Row[]) {
      for (const s of a.daily_meal_plan.slots) expect(s).toMatchObject({ swaps: [], recipe_id: null });
    }
    for (const id of [OTHER, STRANGER]) {
      const view = await todayRoute.today(as(id));
      expect(view.assignments).toEqual([]);
      expect(view.changes_today).toEqual([]);
    }
  });

  it('POST /lists/:type/bulk as another coach or a stranger keeps the item but not the plan meal', async () => {
    const { listsRoute, listItems } = setup();
    for (const id of [OTHER, STRANGER]) {
      await listsRoute.bulkAdd(as(id), 'grocery', { items: [{ name: 'Oats', source_plan_slot_id: 'slot-b' }] } as never);
    }
    expect(listItems.map((i) => [i.user_id, i.source_plan_slot_id])).toEqual([[OTHER, null], [STRANGER, null]]);
  });
});
