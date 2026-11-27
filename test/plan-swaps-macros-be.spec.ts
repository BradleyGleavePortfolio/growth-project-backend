/**
 * PLAN-SWAPS-MACROS-BE (C2 Style C, C2-C-09): every swap GET /me/meal-plan/today and its alias GET /me/meal-plan
 * send for a plan meal carries that swap meal's own stored numbers, all four: calories_kcal, protein_g, carbs_g
 * and fats_g, under the meal's own names. The picked frame's portion sheet draws
 * "{kcal} kcal, {p} g protein, {c} g carbs, {f} g fat." for a swap, and the phone's food log refuses a food
 * without its macros, so a swap without carbs and fat could be neither drawn nor logged.
 *
 * Written first. At main 31b489c5 M1, M2 (its select) and M3 fail on the missing carbs_g and fats_g; M2's where,
 * M4 and M5 pass, because which swaps a client is sent, and everything else in the answer, stay main's.
 *   M1 GET /me/meal-plan/today: each swap is { id, name, calories_kcal, protein_g, carbs_g, fats_g }, in the
 *      coach's stored order; a 0 is sent as 0; an archived meal, another coach's meal and the meal itself never;
 *   M2 the swap read itself: main's where, and a select of exactly those six keys;
 *   M3 GET /me/meal-plan: the same swaps (against M1's literals), and the same answer as /today for every viewer;
 *   M4 a moved client, another coach and a stranger get main's answers; the plan meal keeps its own columns;
 *   M5 additive: with carbs_g and fats_g taken off every swap, the answer is main's, byte for byte.
 *
 * The fake follows test/plan-swaps-be.spec.ts's world(), with three changes: a read returns only the columns its
 * select names (an unselected column is absent, never undefined); every meal row carries every MealTemplate
 * column; and a call the fake does not model throws. The answer is read as the phone reads it: the JSON a route
 * sends. Fictional people; the shake, both drawn swaps and the dinner are the frames' own (MOCK-C2 data.py).
 */
import { RealMealPlansService } from '../src/real-meal-plans/real-meal-plans.service';
import { ClientMealPlanController } from '../src/real-meal-plans/real-meal-plans.controller';
import { ClientMealPlanAliasController } from '../src/meal-plans/client-meal-plans.controller';

type Row = Record<string, any>;
const stub = <T>(o: unknown) => o as T;

const COACH = 'coach-sam';
const OTHER = 'coach-other';
const CLIENT = 'client-jordan';
const MOVED = 'client-moved';
const STRANGER = 'client-stranger';
const ZONE = 'America/Los_Angeles';
const NOW = new Date('2026-11-27T18:00:00Z'); // 10:00 in Los Angeles
const CREATED = new Date('2026-11-01T12:00:00Z');

// What each route must send for a swap: the swap meal's own stored numbers (kcal / protein / carbs / fat).
const GRANOLA = {
  id: 'tpl-granola',
  name: 'Greek yoghurt and granola',
  calories_kcal: 260,
  protein_g: 22,
  carbs_g: 34,
  fats_g: 5,
};
const RICE_CAKES = {
  id: 'tpl-rice-cakes',
  name: 'Rice cakes, honey and whey',
  calories_kcal: 240,
  protein_g: 26,
  carbs_g: 30,
  fats_g: 2,
};
const EGG_WHITES = {
  id: 'tpl-egg-whites',
  name: 'Egg whites, scrambled',
  calories_kcal: 120,
  protein_g: 26,
  carbs_g: 0,
  fats_g: 0,
};

/** A MealTemplate row with every column, in the schema's order. */
function meal(
  id: string,
  coach_id: string,
  name: string,
  [kcal, protein, carbs, fats]: number[],
  extra: Row = {},
): Row {
  return {
    id,
    coach_id,
    name,
    description: null,
    calories_kcal: kcal,
    protein_g: protein,
    carbs_g: carbs,
    fats_g: fats,
    fiber_g: null,
    items: null,
    created_at: CREATED,
    archived_at: null,
    swap_template_ids: [],
    recipe_id: null,
    ...extra,
  };
}

// plan-swaps-be.spec.ts's inMatch, plus OR: equality (null included) and `in`; other object filters pass.
function inMatch(where: Row | undefined, row: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as Row[]).every((w) => inMatch(w, row));
    if (k === 'OR') return (v as Row[]).some((w) => inMatch(w, row));
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
    if (v && typeof v === 'object') return true; // relation filters are checked by the test's own setup
    return row[k] === v;
  });
}

/** Only the selected columns; a selected column the row lacks is a fake that does not model the read. */
function pick(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => {
        if (!(k in row)) throw new Error(`the fake has no column ${k}`);
        return [k, row[k]];
      }),
  );
}

/** Any model or method the fake does not name throws, so an unmodelled read can never pass quietly. */
function strict<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(o, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop in o)
        return Reflect.get(o, prop, receiver);
      throw new Error(`the fake does not model ${name}.${prop}`);
    },
  });
}

function world() {
  const users: Row[] = [
    { id: COACH, role: 'coach', coach_id: null },
    { id: OTHER, role: 'coach', coach_id: null },
    { id: CLIENT, role: 'student', coach_id: COACH },
    { id: MOVED, role: 'student', coach_id: OTHER },
  ];
  const templates: Row[] = [
    meal('tpl-shake', COACH, 'Banana and whey shake', [250, 25, 32, 3], {
      description: 'Before training',
      fiber_g: 4,
      // The coach's stored order. An archived meal, another coach's meal and the meal itself are never sent.
      swap_template_ids: [
        'tpl-granola',
        'tpl-rice-cakes',
        'tpl-egg-whites',
        'tpl-old',
        'tpl-theirs',
        'tpl-shake',
      ],
    }),
    meal('tpl-granola', COACH, 'Greek yoghurt and granola', [260, 22, 34, 5], { fiber_g: 2 }),
    meal('tpl-rice-cakes', COACH, 'Rice cakes, honey and whey', [240, 26, 30, 2]),
    meal('tpl-egg-whites', COACH, 'Egg whites, scrambled', [120, 26, 0, 0]),
    meal('tpl-old', COACH, 'Old swap', [300, 20, 30, 10], {
      archived_at: new Date('2026-11-20T12:00:00Z'),
    }),
    meal('tpl-theirs', OTHER, 'Theirs CANARY', [500, 30, 45, 18]),
    meal('tpl-salmon', COACH, 'Salmon, potatoes and green beans', [620, 42, 55, 22], {
      fiber_g: 7,
      swap_template_ids: ['tpl-rice-cakes'],
      recipe_id: 'rec-salmon',
    }),
  ];
  const recipes: Row[] = [{ id: 'rec-salmon', created_by_id: COACH, is_public: true }];
  const plan = {
    id: 'plan-training',
    coach_id: COACH,
    name: 'Training day',
    notes: null,
    created_at: CREATED,
    archived_at: null,
    updated_at: CREATED,
  };
  const slots: Row[] = [
    {
      id: 'slot-pre',
      daily_meal_plan_id: plan.id,
      meal_template_id: 'tpl-shake',
      slot_label: 'preworkout',
      order: 0,
      time_of_day: '17:30',
    },
    {
      id: 'slot-dinner',
      daily_meal_plan_id: plan.id,
      meal_template_id: 'tpl-salmon',
      slot_label: 'dinner',
      order: 0,
      time_of_day: '19:30',
    },
  ];
  const assignment = (id: string, client_id: string): Row => ({
    id,
    daily_meal_plan_id: plan.id,
    client_id,
    assigned_by_coach_id: COACH,
    starts_on: new Date('2026-11-01T00:00:00Z'),
    ends_on: null,
    created_at: CREATED,
    ai_draft_id: null,
    drip_drop_id: null,
  });
  const assignments = [assignment('as-jordan', CLIENT), assignment('as-moved', MOVED)];
  const revisions: Row[] = [
    // Today in Los Angeles (08:30): in changes_today. Yesterday (12:00 on the 26th): not.
    {
      id: 'rev-today',
      plan_id: plan.id,
      slot_id: 'slot-dinner',
      slot_label: 'dinner',
      from_template_id: 'tpl-rice-cakes',
      to_template_id: 'tpl-salmon',
      changed_at: new Date('2026-11-27T16:30:00Z'),
    },
    {
      id: 'rev-yesterday',
      plan_id: plan.id,
      slot_id: 'slot-pre',
      slot_label: 'preworkout',
      from_template_id: 'tpl-granola',
      to_template_id: 'tpl-shake',
      changed_at: new Date('2026-11-26T20:00:00Z'),
    },
  ];
  const bySlot = (a: Row, b: Row) => a.slot_label.localeCompare(b.slot_label) || a.order - b.order;
  const templateReads: Row[] = []; // every mealTemplate.findMany argument, in call order

  const prisma = strict('prisma', {
    user: strict('user', {
      findFirst: async ({ where, select }: Row) => {
        const u = users.find((x) => x.id === where.id);
        return u ? pick(u, select) : null;
      },
    }),
    notificationPreferences: strict('notificationPreferences', {
      findUnique: async () => ({ timezone: ZONE, timezone_updated_at: CREATED }),
    }),
    userProfile: strict('userProfile', { findUnique: async () => null }),
    recipe: strict('recipe', {
      findMany: async ({ where, select }: Row) =>
        recipes.filter((r) => inMatch(where, r)).map((r) => pick(r, select)),
    }),
    mealTemplate: strict('mealTemplate', {
      findMany: async (arg: Row) => {
        templateReads.push(arg);
        return templates.filter((t) => inMatch(arg.where, t)).map((t) => pick(t, arg.select));
      },
    }),
    dailyMealPlanAssignment: strict('dailyMealPlanAssignment', {
      // The include of getTodayForClient: the plan, its slots in slot_label then order, each slot's whole meal.
      findMany: async ({ where }: Row) =>
        assignments
          .filter((a) => a.client_id === where.client_id)
          .map((a) => ({
            ...a,
            daily_meal_plan: {
              ...plan,
              slots: slots
                .filter((s) => s.daily_meal_plan_id === plan.id)
                .sort(bySlot)
                .map((s) => ({
                  ...s,
                  meal_template: { ...templates.find((t) => t.id === s.meal_template_id)! },
                })),
            },
          })),
    }),
    dailyMealPlanRevision: strict('dailyMealPlanRevision', {
      findMany: async ({ where, take }: Row) =>
        revisions
          .filter((r) => where.plan_id.in.includes(r.plan_id))
          .filter(
            (r) => r.changed_at >= where.changed_at.gte && r.changed_at <= where.changed_at.lte,
          )
          .sort((a, b) => a.changed_at - b.changed_at)
          .slice(0, take),
    }),
  });
  const meals = new RealMealPlansService(
    stub<ConstructorParameters<typeof RealMealPlansService>[0]>(prisma),
  );
  return {
    templateReads,
    todayRoute: new ClientMealPlanController(meals),
    aliasRoute: new ClientMealPlanAliasController(meals),
  };
}

const as = (id: string) => stub<Parameters<ClientMealPlanController['today']>[0]>({ user: { id } });
/** What the phone receives: the JSON the route sends. */
const wire = (answer: unknown): Row => JSON.parse(JSON.stringify(answer));
const slotsByLabel = (answer: Row): Row =>
  Object.fromEntries(
    answer.assignments[0].daily_meal_plan.slots.map((s: Row) => [s.slot_label, s]),
  );

describe('PLAN-SWAPS-MACROS-BE: each plan meal swap carries its carbs and fat', () => {
  const zoneBefore = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC'; // the server's zone, as on CI and Fly: `date` is the server's day (planDay)
  });
  afterAll(() => {
    if (zoneBefore === undefined) delete process.env.TZ;
    else process.env.TZ = zoneBefore;
  });
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it("M1 GET /me/meal-plan/today: each swap is the swap meal's id, name and four numbers, in the coach's order", async () => {
    const { todayRoute } = world();
    const answer = wire(await todayRoute.today(as(CLIENT)));
    // Which swaps: main's. Never the archived meal, never another coach's meal.
    expect(JSON.stringify(answer)).not.toContain('CANARY');
    expect(JSON.stringify(answer)).not.toContain('Old swap');
    const slots = slotsByLabel(answer);
    // The meal itself is not its own swap; the egg whites' 0 g carbs and 0 g fat are sent as 0.
    expect(slots.preworkout.swaps).toStrictEqual([GRANOLA, RICE_CAKES, EGG_WHITES]);
    // The same swap on a second slot carries the same four numbers.
    expect(slots.dinner.swaps).toStrictEqual([RICE_CAKES]);
  });

  it("M2 the swap read: main's where, and a select of exactly the six keys a swap sends", async () => {
    const { todayRoute, templateReads } = world();
    await todayRoute.today(as(CLIENT));
    const [swapRead] = templateReads;
    // The ids as main collects them: the own slots in slot order (dinner, then preworkout), each id once.
    expect(swapRead.where).toStrictEqual({
      id: {
        in: [
          'tpl-rice-cakes',
          'tpl-granola',
          'tpl-egg-whites',
          'tpl-old',
          'tpl-theirs',
          'tpl-shake',
        ],
      },
      coach_id: COACH,
      archived_at: null,
    });
    expect(swapRead.select).toStrictEqual({
      id: true,
      name: true,
      calories_kcal: true,
      protein_g: true,
      carbs_g: true,
      fats_g: true,
    });
  });

  it('M3 GET /me/meal-plan sends the same swaps, and the same answer as /today for every viewer', async () => {
    const { todayRoute, aliasRoute } = world();
    const slots = slotsByLabel(wire(await aliasRoute.current(as(CLIENT))));
    expect(slots.preworkout.swaps).toStrictEqual([GRANOLA, RICE_CAKES, EGG_WHITES]);
    expect(slots.dinner.swaps).toStrictEqual([RICE_CAKES]);
    for (const id of [CLIENT, MOVED, OTHER, STRANGER]) {
      expect(wire(await aliasRoute.current(as(id)))).toStrictEqual(
        wire(await todayRoute.today(as(id))),
      );
    }
  });

  it("M4 a moved client, another coach and a stranger get main's answers; the plan meal keeps its own columns", async () => {
    const { todayRoute } = world();
    // A plan kept from an earlier coach: no swaps and no recipe on any slot.
    const moved = wire(await todayRoute.today(as(MOVED)));
    expect(moved.assignments).toHaveLength(1);
    expect(moved.assignments[0].daily_meal_plan.slots).toHaveLength(2);
    for (const s of moved.assignments[0].daily_meal_plan.slots) {
      expect(s.swaps).toStrictEqual([]);
      expect(s.recipe_id).toBeNull();
    }
    for (const id of [OTHER, STRANGER]) {
      const view = wire(await todayRoute.today(as(id)));
      expect(view.assignments).toStrictEqual([]);
      expect(view.changes_today).toStrictEqual([]);
    }
    // The plan meal itself: every column it had at main (its own carbs, fat and fiber), never the raw ids.
    const slots = slotsByLabel(wire(await todayRoute.today(as(CLIENT))));
    expect(slots.preworkout.meal_template).toStrictEqual({
      id: 'tpl-shake',
      coach_id: COACH,
      name: 'Banana and whey shake',
      description: 'Before training',
      calories_kcal: 250,
      protein_g: 25,
      carbs_g: 32,
      fats_g: 3,
      fiber_g: 4,
      items: null,
      created_at: CREATED.toISOString(),
      archived_at: null,
    });
    expect(slots.dinner.meal_template).not.toHaveProperty('swap_template_ids');
    expect(slots.dinner.meal_template).not.toHaveProperty('recipe_id');
    expect(slots.dinner.recipe_id).toBe('rec-salmon');
  });

  it("M5 additive: with carbs_g and fats_g taken off every swap, the answer is main's, byte for byte", async () => {
    const { todayRoute } = world();
    const answer = wire(await todayRoute.today(as(CLIENT)));
    for (const a of answer.assignments) {
      for (const s of a.daily_meal_plan.slots) {
        for (const swap of s.swaps) {
          delete swap.carbs_g;
          delete swap.fats_g;
        }
      }
    }
    expect(JSON.stringify(answer, null, 2)).toBe(MAIN_ANSWER);
  });
});

// CLIENT's answer at main 31b489c5 (JSON.stringify(wire(answer), null, 2), captured by a local run at that commit).
const MAIN_ANSWER = `{
  "date": "2026-11-27",
  "assignments": [
    {
      "id": "as-jordan",
      "daily_meal_plan_id": "plan-training",
      "client_id": "client-jordan",
      "assigned_by_coach_id": "coach-sam",
      "starts_on": "2026-11-01T00:00:00.000Z",
      "ends_on": null,
      "created_at": "2026-11-01T12:00:00.000Z",
      "ai_draft_id": null,
      "drip_drop_id": null,
      "daily_meal_plan": {
        "id": "plan-training",
        "coach_id": "coach-sam",
        "name": "Training day",
        "notes": null,
        "created_at": "2026-11-01T12:00:00.000Z",
        "archived_at": null,
        "updated_at": "2026-11-01T12:00:00.000Z",
        "slots": [
          {
            "id": "slot-dinner",
            "daily_meal_plan_id": "plan-training",
            "meal_template_id": "tpl-salmon",
            "slot_label": "dinner",
            "order": 0,
            "time_of_day": "19:30",
            "meal_template": {
              "id": "tpl-salmon",
              "coach_id": "coach-sam",
              "name": "Salmon, potatoes and green beans",
              "description": null,
              "calories_kcal": 620,
              "protein_g": 42,
              "carbs_g": 55,
              "fats_g": 22,
              "fiber_g": 7,
              "items": null,
              "created_at": "2026-11-01T12:00:00.000Z",
              "archived_at": null
            },
            "swaps": [
              {
                "id": "tpl-rice-cakes",
                "name": "Rice cakes, honey and whey",
                "calories_kcal": 240,
                "protein_g": 26
              }
            ],
            "recipe_id": "rec-salmon"
          },
          {
            "id": "slot-pre",
            "daily_meal_plan_id": "plan-training",
            "meal_template_id": "tpl-shake",
            "slot_label": "preworkout",
            "order": 0,
            "time_of_day": "17:30",
            "meal_template": {
              "id": "tpl-shake",
              "coach_id": "coach-sam",
              "name": "Banana and whey shake",
              "description": "Before training",
              "calories_kcal": 250,
              "protein_g": 25,
              "carbs_g": 32,
              "fats_g": 3,
              "fiber_g": 4,
              "items": null,
              "created_at": "2026-11-01T12:00:00.000Z",
              "archived_at": null
            },
            "swaps": [
              {
                "id": "tpl-granola",
                "name": "Greek yoghurt and granola",
                "calories_kcal": 260,
                "protein_g": 22
              },
              {
                "id": "tpl-rice-cakes",
                "name": "Rice cakes, honey and whey",
                "calories_kcal": 240,
                "protein_g": 26
              },
              {
                "id": "tpl-egg-whites",
                "name": "Egg whites, scrambled",
                "calories_kcal": 120,
                "protein_g": 26
              }
            ],
            "recipe_id": null
          }
        ]
      }
    }
  ],
  "changes_today": [
    {
      "plan_id": "plan-training",
      "slot_id": "slot-dinner",
      "slot_label": "dinner",
      "changed_at": "2026-11-27T16:30:00.000Z",
      "from_template_id": "tpl-rice-cakes",
      "from_name": "Rice cakes, honey and whey",
      "to_template_id": "tpl-salmon",
      "to_name": "Salmon, potatoes and green beans"
    }
  ]
}`;
