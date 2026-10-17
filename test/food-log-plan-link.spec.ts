/**
 * FOODLINK (decisions 141-3, 141-4) — a food log entry carries the plan meal it was logged for.
 *
 * The real LogService and RealMealPlansService run against one in-memory store that keeps the
 * schema rules that matter here: column defaults (plan_slot_id null, fills_usual_meal false),
 * client_uuid unique across all users, and ON DELETE SET NULL from a deleted DailyMealPlanSlot.
 * The slot lookup honours the service's own `where` (slot id, plan assigned to this client on
 * this date), so the tenant rule is the service's, not the double's.
 * Live row security for the same columns: test/rls/food-entry-plan-link-rls.spec.ts.
 */
import { ValidationPipe } from '@nestjs/common';
import { LogService } from '../src/log/log.service';
import { LogFoodDto, UpdateLogEntryDto } from '../src/log/log.dto';
import { RealMealPlansService } from '../src/real-meal-plans/real-meal-plans.service';
import type { FoodService } from '../src/food/food.service';
import type { PrismaService } from '../src/prisma.service';

const A = 'client-a';
const B = 'client-b';
const COACH = 'coach-1';
const SLOT_A = '11111111-1111-4111-8111-111111111111';
const SLOT_B = '22222222-2222-4222-8222-222222222222';
const SLOT_SHARED = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '44444444-4444-4444-8444-444444444444';
const day = (d: string) => new Date(d);

type Row = Record<string, any>;
const stub = <T>(value: unknown): T => value as T;

function setup() {
  const entries: Row[] = [];
  const slots: Row[] = [
    { id: SLOT_A, daily_meal_plan_id: 'plan-a', slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats' },
    { id: SLOT_B, daily_meal_plan_id: 'plan-b', slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats' },
    { id: SLOT_SHARED, daily_meal_plan_id: 'plan-shared', slot_label: 'lunch', order: 0, meal_template_id: 'tpl-oats' },
  ];
  const plans: Row[] = ['plan-a', 'plan-b', 'plan-shared'].map((id) => ({ id, coach_id: COACH, archived_at: null }));
  const assignments: Row[] = [
    { daily_meal_plan_id: 'plan-a', client_id: A, starts_on: day('2026-10-10'), ends_on: day('2026-10-20') },
    { daily_meal_plan_id: 'plan-b', client_id: B, starts_on: day('2026-10-01'), ends_on: null },
    // One plan assigned to both clients, over different dates.
    { daily_meal_plan_id: 'plan-shared', client_id: A, starts_on: day('2026-10-01'), ends_on: day('2026-10-05') },
    { daily_meal_plan_id: 'plan-shared', client_id: B, starts_on: day('2026-10-06'), ends_on: null },
  ];
  const food = { id: 'food-1', name: 'Oats', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 };
  const withFood = (e: Row) => ({ ...e, food_item: food });
  let seq = 0;
  const insert = (data: Row) => {
    if (data.client_uuid && entries.some((r) => r.client_uuid === data.client_uuid)) throw new Error('P2002');
    const row = {
      quantity_multiplier: 1,
      plan_slot_id: null,
      fills_usual_meal: false,
      client_uuid: null,
      ...data,
      id: `entry-${++seq}`,
    };
    entries.push(row);
    return row;
  };
  const covers = (a: Row, userId: string, d: Date) =>
    a.client_id === userId && a.starts_on <= d && (a.ends_on === null || a.ends_on >= d);
  const slotLookup = jest.fn(async ({ where }: { where: any }) => {
    const some = where.daily_meal_plan.assignments.some;
    const d: Date = some.starts_on.lte;
    expect(some.OR).toEqual([{ ends_on: null }, { ends_on: { gte: d } }]);
    const slot = slots.find((s) => s.id === where.id);
    const assigned = (id: string) => assignments.some((a) => a.daily_meal_plan_id === id && covers(a, some.client_id, d));
    return slot && assigned(slot.daily_meal_plan_id) ? { id: slot.id } : null;
  });
  const deleteSlots = (ids: string[]) => {
    for (const id of ids) slots.splice(slots.findIndex((s) => s.id === id), 1);
    for (const e of entries) if (ids.includes(e.plan_slot_id)) e.plan_slot_id = null; // ON DELETE SET NULL
  };
  const prisma: Row = {
    loggedFoodEntry: {
      create: jest.fn(async ({ data }: Row) => withFood(insert(data))),
      upsert: jest.fn(async ({ where, create }: Row) =>
        withFood(entries.find((r) => r.client_uuid === where.client_uuid) ?? insert(create)),
      ),
      findMany: jest.fn(async ({ where }: Row) =>
        entries
          .filter((e) => e.user_id === where.user_id && e.date.getTime() === where.date.getTime())
          .map(withFood),
      ),
    },
    userProfile: { findUnique: jest.fn(async () => null) },
    macroTarget: { findFirst: jest.fn(async () => null) },
    dailyMealPlan: {
      findFirst: jest.fn(async ({ where }: Row) => plans.find((p) => p.id === where.id && p.coach_id === where.coach_id) ?? null),
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async ({ where }: Row) => ({ id: where.id, slots: slots.filter((s) => s.daily_meal_plan_id === where.id) })),
    },
    mealTemplate: { findMany: jest.fn(async ({ where }: Row) => where.id.in.map((id: string) => ({ id }))) },
    dailyMealPlanSlot: {
      findFirst: slotLookup,
      findMany: jest.fn(async ({ where }: Row) => slots.filter((s) => s.daily_meal_plan_id === where.daily_meal_plan_id).map((s) => ({ ...s }))),
      deleteMany: jest.fn(async ({ where }: Row) => {
        const ids = where.id ? where.id.in : slots.filter((s) => s.daily_meal_plan_id === where.daily_meal_plan_id).map((s) => s.id);
        deleteSlots(ids);
        return { count: ids.length };
      }),
      update: jest.fn(async ({ where, data }: Row) => Object.assign(slots.find((s) => s.id === where.id)!, data)),
      createMany: jest.fn(async ({ data }: Row) => {
        for (const d of data) slots.push({ id: `slot-new-${++seq}`, ...d });
        return { count: data.length };
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: Row) => unknown) => fn(prisma));
  const log = new LogService(
    stub<PrismaService>(prisma),
    stub<FoodService>({ resolveOrImportId: jest.fn(async (id: string) => id) }),
    stub({ capture: jest.fn() }),
    stub({ emit: jest.fn() }),
    stub({ invalidateForUser: jest.fn() }),
  );
  const plansService = new RealMealPlansService(stub<PrismaService>(prisma));
  const entry = (extra: Partial<LogFoodDto> = {}): LogFoodDto => ({
    food_item_id: 'food-1',
    date: '2026-10-12',
    meal_type: 'breakfast',
    ...extra,
  });
  return { log, plansService, prisma, entries, slots, entry, slotLookup };
}

describe('FOODLINK — POST /log/food keeps the plan link only for the caller\'s own plan meal', () => {
  it('1. own slot on a date its assignment covers: saved and returned', async () => {
    const { log, entries, entry } = setup();
    const saved = await log.logFood(A, entry({ plan_slot_id: SLOT_A }));
    expect(saved.plan_slot_id).toBe(SLOT_A);
    expect(entries[0]).toMatchObject({ user_id: A, plan_slot_id: SLOT_A });
  });

  it("2. another client's real slot: saved with no link, answered exactly like an unknown id", async () => {
    const { log, entries, entry } = setup();
    await log.logFood(B, entry({ notes: 'b own' }));
    const foreign = await log.logFood(A, entry({ plan_slot_id: SLOT_B }));
    const unknown = await log.logFood(A, entry({ plan_slot_id: UNKNOWN }));
    expect(foreign.plan_slot_id).toBeNull();
    const shape = ({ id: _id, ...rest }: Row) => rest;
    expect(shape(foreign)).toEqual(shape(unknown));
    expect(entries.filter((e) => e.user_id === B)).toEqual([expect.objectContaining({ notes: 'b own', plan_slot_id: null })]);
  });

  it('3. own slot on a date before starts_on or after ends_on: no link', async () => {
    const { log, entry } = setup();
    expect((await log.logFood(A, entry({ date: '2026-10-09', plan_slot_id: SLOT_A }))).plan_slot_id).toBeNull();
    expect((await log.logFood(A, entry({ date: '2026-10-21', plan_slot_id: SLOT_A }))).plan_slot_id).toBeNull();
    expect((await log.logFood(A, entry({ date: '2026-10-20', plan_slot_id: SLOT_A }))).plan_slot_id).toBe(SLOT_A);
  });

  it("4. one plan assigned to A and B: B's assignment never vouches for A's entry", async () => {
    const { log, entry } = setup();
    expect((await log.logFood(A, entry({ date: '2026-10-12', plan_slot_id: SLOT_SHARED }))).plan_slot_id).toBeNull();
    expect((await log.logFood(A, entry({ date: '2026-10-03', plan_slot_id: SLOT_SHARED }))).plan_slot_id).toBe(SLOT_SHARED);
    expect((await log.logFood(B, entry({ date: '2026-10-12', plan_slot_id: SLOT_SHARED }))).plan_slot_id).toBe(SLOT_SHARED);
  });

  it('5. a retry with the same client_uuid returns the first row, link and flag unchanged', async () => {
    const { log, entries, entry } = setup();
    const first = await log.logFood(A, entry({ client_uuid: 'pfl_a-1', plan_slot_id: SLOT_A }));
    const retry = await log.logFood(A, entry({ client_uuid: 'pfl_a-1', fills_usual_meal: true }));
    expect(retry).toEqual(first);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ plan_slot_id: SLOT_A, fills_usual_meal: false });
  });

  it('8. without the new fields the write is exactly today\'s, with no slot lookup', async () => {
    const { log, prisma, entry, slotLookup } = setup();
    await log.logFood(A, entry({ notes: 'n' }));
    expect(slotLookup).not.toHaveBeenCalled();
    expect(prisma.loggedFoodEntry.create).toHaveBeenCalledWith({
      data: {
        user_id: A,
        date: day('2026-10-12'),
        meal_type: 'breakfast',
        food_item_id: 'food-1',
        quantity_multiplier: 1,
        original_quantity: undefined,
        original_unit: undefined,
        notes: 'n',
      },
      include: { food_item: true },
    });
  });

  it('A7. fills_usual_meal: saved and returned true; false by default', async () => {
    const { log, entry } = setup();
    expect((await log.logFood(A, entry({ fills_usual_meal: true }))).fills_usual_meal).toBe(true);
    expect((await log.logFood(A, entry({ fills_usual_meal: false }))).fills_usual_meal).toBe(false);
    expect((await log.logFood(A, entry())).fills_usual_meal).toBe(false);
  });
});

describe('FOODLINK — GET /log/daily', () => {
  it('6. returns plan_slot_id and fills_usual_meal on every entry', async () => {
    const { log, entry } = setup();
    await log.logFood(A, entry({ plan_slot_id: SLOT_A }));
    await log.logFood(A, entry({ fills_usual_meal: true }));
    await log.logFood(A, entry());
    const { entries } = await log.getDaily(A, '2026-10-12');
    expect(entries.map((e) => [e.plan_slot_id, e.fills_usual_meal])).toEqual([
      [SLOT_A, false],
      [null, true],
      [null, false],
    ]);
  });

  it("13. client B's day never includes client A's entries, links or totals (same date)", async () => {
    const { log, entry } = setup();
    await log.logFood(A, entry({ plan_slot_id: SLOT_A, notes: 'a private', quantity_multiplier: 2 }));
    await log.logFood(A, entry({ fills_usual_meal: true }));
    await log.logFood(B, entry({ plan_slot_id: SLOT_B }));
    const dayB = await log.getDaily(B, '2026-10-12');
    expect(dayB.entries).toHaveLength(1);
    expect(dayB.entries[0]).toMatchObject({ user_id: B, plan_slot_id: SLOT_B });
    expect(JSON.stringify(dayB)).not.toMatch(/a private|client-a|1111/);
    expect(dayB.total_calories).toBe(300);
    const dayA = await log.getDaily(A, '2026-10-12');
    expect(dayA.entries.every((e) => e.user_id === A)).toBe(true);
    expect(dayA.total_calories).toBe(900);
  });
});

describe('FOODLINK — validation (the real ValidationPipe)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const body = { date: '2026-10-12', meal_type: 'breakfast', food_item_id: 'food-1' };
  const post = (extra: Row) => pipe.transform({ ...body, ...extra }, { type: 'body', metatype: LogFoodDto });
  const put = (extra: Row) => pipe.transform({ notes: 'x', ...extra }, { type: 'body', metatype: UpdateLogEntryDto });

  it('7. POST accepts a uuid link and a boolean flag; rejects a non-uuid link and a non-boolean flag', async () => {
    await expect(post({ plan_slot_id: SLOT_A, fills_usual_meal: true })).resolves.toMatchObject({ plan_slot_id: SLOT_A });
    await expect(post({ plan_slot_id: 'breakfast' })).rejects.toThrow();
    await expect(post({ fills_usual_meal: 'yes' })).rejects.toThrow();
  });

  it('7. PUT /log/food/:id can never move or set either field', async () => {
    await expect(put({ plan_slot_id: SLOT_A })).rejects.toThrow();
    await expect(put({ fills_usual_meal: true })).rejects.toThrow();
    await expect(put({})).resolves.toEqual({ notes: 'x' });
  });
});

describe('FOODLINK — a coach editing a plan keeps the meals already logged', () => {
  it('9. a kept (label, order) keeps its id and links; a removed slot unlinks; a new slot gets a new id', async () => {
    const { log, plansService, slots, entries, entry } = setup();
    slots.push({ id: 'slot-a-lunch', daily_meal_plan_id: 'plan-a', slot_label: 'lunch', order: 0, meal_template_id: 'tpl-oats' });
    await log.logFood(A, entry({ plan_slot_id: SLOT_A }));
    await log.logFood(A, entry({ meal_type: 'lunch', plan_slot_id: 'slot-a-lunch' }));

    await plansService.updatePlan(COACH, 'plan-a', {
      slots: [
        { slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-eggs' },
        { slot_label: 'dinner', meal_template_id: 'tpl-oats' },
      ],
    });

    const planA = slots.filter((s) => s.daily_meal_plan_id === 'plan-a');
    expect(planA.find((s) => s.slot_label === 'breakfast')).toMatchObject({ id: SLOT_A, meal_template_id: 'tpl-eggs' });
    expect(planA.find((s) => s.slot_label === 'lunch')).toBeUndefined();
    expect(planA.find((s) => s.slot_label === 'dinner')).toMatchObject({ id: expect.stringMatching(/^slot-new-/), order: 1 });
    expect(entries.map((e) => e.plan_slot_id)).toEqual([SLOT_A, null]);
    expect(slots.filter((s) => s.daily_meal_plan_id !== 'plan-a')).toHaveLength(2);
  });

  it('9. an unchanged slot list writes nothing to the slots', async () => {
    const { plansService, prisma } = setup();
    await plansService.updatePlan(COACH, 'plan-a', {
      slots: [{ slot_label: 'breakfast', order: 0, meal_template_id: 'tpl-oats' }],
    });
    expect(prisma.dailyMealPlanSlot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.dailyMealPlanSlot.update).not.toHaveBeenCalled();
    expect(prisma.dailyMealPlanSlot.createMany).not.toHaveBeenCalled();
  });
});
