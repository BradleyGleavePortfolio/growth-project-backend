/**
 * FOOD-RESEND-BE (agent 193): one rule for every client save that takes a key.
 *
 * The phone resends a save when its answer is lost (a time-out, a crash, the
 * background sync). The same key gets the first answer back and fires nothing:
 * one row, the same answer both times, and each side effect once (the analytics
 * event, the PTM signal the leaderboard counts over 30 days, the AI context
 * reset). Two sends at the same moment with one key: one row, each effect once.
 * Another person's key (where keys are global) is not found and fires nothing.
 * No key: a plain create, so two sends are two saves.
 *
 * The saves with a key at this head:
 *   POST /log/food                 client_uuid (body)      LogService.logFood
 *   POST /log/saved-meals/:id/log  client_uuid (body)      SavedFoodsService.logSavedMeal
 *   POST /workouts                 Idempotency-Key header  WorkoutService.createWorkout
 * Water and weight (client_uuid, b#1206) join this table when b#1206 merges.
 *
 * The side effects are the real AnalyticsService, PtmService and
 * ClientAIContextService, spied on. PtmService writes its signals into the fake
 * store below, so `signals` is exactly what the leaderboard would count. The
 * store keeps the schema's unique rules: LoggedFoodEntry.client_uuid unique
 * across all users; WorkoutSession (user_id, client_key) unique. A broken
 * unique rule throws Prisma's real P2002 error, and every call yields once so
 * two sends at the same moment interleave as they would on the server.
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { FoodService } from '../src/food/food.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { Events } from '../src/analytics/events';
import { PtmService } from '../src/ptm/ptm.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { LogService } from '../src/log/log.service';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import { WorkoutService } from '../src/workout/workout.service';

function stub<T>(value: unknown): T {
  return value as T;
}

type Row = Record<string, unknown> & { id: string; user_id: string };
type Where = Record<string, unknown>;

const A = 'client-a';
const B = 'client-b';
const OATS = { id: 'food-oats', name: 'Oats', calories: 380, protein_g: 13, carbs_g: 68, fat_g: 7 };
const BANANA = { id: 'food-banana', name: 'Banana', calories: 89, protein_g: 1, carbs_g: 23, fat_g: 0 };
const FOODS: Record<string, typeof OATS> = { [OATS.id]: OATS, [BANANA.id]: BANANA };

const tick = () => new Promise((resolve) => setImmediate(resolve));
const p2002 = (field: string) =>
  new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (\`${field}\`)`, {
    code: 'P2002',
    clientVersion: 'test',
  });

function fakeStore() {
  const entries: Row[] = [];
  const workouts: Row[] = [];
  const signals: Row[] = [];
  let n = 0;
  const withFood = (e: Row) => ({ ...e, food_item: FOODS[String(e.food_item_id)] });
  const insertEntry = (data: Row | Where) => {
    const key = typeof data.client_uuid === 'string' ? data.client_uuid : null;
    if (key !== null && entries.some((e) => e.client_uuid === key)) throw p2002('client_uuid');
    const row = {
      quantity_multiplier: 1,
      plan_slot_id: null,
      fills_usual_meal: false,
      notes: null,
      ...data,
      client_uuid: key,
      id: `entry-${++n}`,
      logged_at: data.logged_at ?? new Date(1_800_000_000_000 + n),
    } as Row;
    entries.push(row);
    return withFood(row);
  };
  const entryWhere = (where: Where) => (e: Row) =>
    'client_uuid' in where ? e.client_uuid === where.client_uuid : e.id === where.id;

  const loggedFoodEntry = {
    create: jest.fn(async ({ data }: { data: Where }) => {
      await tick();
      return insertEntry(data);
    }),
    // main's POST /log/food wrote through an upsert with an empty update; kept so the base runs.
    upsert: jest.fn(async ({ where, create }: { where: Where; create: Where }) => {
      const found = entries.find(entryWhere(where));
      await tick();
      return found ? withFood(found) : insertEntry(create);
    }),
    findUnique: jest.fn(async ({ where }: { where: Where }) => {
      await tick();
      const found = entries.find(entryWhere(where));
      return found ? withFood(found) : null;
    }),
    findMany: jest.fn(async ({ where }: { where: { client_uuid: { in: string[] } } }) => {
      await tick();
      return entries.filter((e) => where.client_uuid.in.includes(String(e.client_uuid))).map(withFood);
    }),
  };

  const workoutSession = {
    findUnique: jest.fn(async ({ where }: { where: { user_id_client_key: { user_id: string; client_key: string } } }) => {
      await tick();
      const k = where.user_id_client_key;
      return workouts.find((w) => w.user_id === k.user_id && w.client_key === k.client_key) ?? null;
    }),
    create: jest.fn(async ({ data }: { data: Where & { user_id: string; client_key?: string } }) => {
      await tick();
      if (data.client_key != null && workouts.some((w) => w.user_id === data.user_id && w.client_key === data.client_key)) {
        throw p2002('user_id`,`client_key');
      }
      const { exercises, ...rest } = data as Where & { exercises?: { create: Where[] } };
      const id = `workout-${++n}`;
      const row = {
        ...rest,
        id,
        user_id: data.user_id,
        client_key: data.client_key ?? null,
        exercises: (exercises?.create ?? []).map((e, i) => ({ id: `${id}-ex-${i}`, workout_id: id, ...e })),
      } as Row;
      workouts.push(row);
      return row;
    }),
  };

  const meals: Record<string, Row> = {
    'meal-a': {
      id: 'meal-a',
      user_id: A,
      name: 'Usual breakfast',
      items: [
        { food_item_id: OATS.id, quantity_multiplier: 0.5, original_quantity: null, original_unit: null, position: 0 },
        { food_item_id: BANANA.id, quantity_multiplier: 1, original_quantity: null, original_unit: null, position: 1 },
      ],
    },
    'meal-b': {
      id: 'meal-b',
      user_id: B,
      name: 'Usual breakfast',
      items: [{ food_item_id: OATS.id, quantity_multiplier: 1, original_quantity: null, original_unit: null, position: 0 }],
    },
  };
  const savedMeal = {
    findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) => {
      const meal = meals[where.id];
      return meal && meal.user_id === where.user_id ? meal : null;
    }),
  };

  const clientSignal = {
    create: jest.fn(async ({ data }: { data: Where }) => {
      const row = { id: `signal-${++n}`, ...data } as Row;
      signals.push(row);
      return row;
    }),
  };

  // logSavedMeal writes its items in one transaction: all or none (a failed one keeps none of its rows).
  const $transaction = jest.fn(async (writes: Promise<unknown>[]) => {
    const settled = await Promise.allSettled(writes);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (!failed) return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
    const written = new Set(settled.flatMap((s) => (s.status === 'fulfilled' ? [(s.value as Row).id] : [])));
    for (let i = entries.length - 1; i >= 0; i--) if (written.has(entries[i].id)) entries.splice(i, 1);
    throw failed.reason;
  });

  const prisma = stub<PrismaService>({ loggedFoodEntry, workoutSession, savedMeal, clientSignal, $transaction });
  return { prisma, entries, workouts, signals };
}

function setup() {
  const store = fakeStore();
  const previousKey = process.env.POSTHOG_KEY;
  delete process.env.POSTHOG_KEY; // no-op mode: the real service, no network
  const analytics = new AnalyticsService();
  if (previousKey !== undefined) process.env.POSTHOG_KEY = previousKey;
  const ptm = new PtmService(store.prisma);
  const aiContext = new ClientAIContextService(store.prisma);
  const spies = {
    capture: jest.spyOn(analytics, 'capture'),
    emit: jest.spyOn(ptm, 'emit'),
    invalidate: jest.spyOn(aiContext, 'invalidateForUser'),
  };
  const food = stub<FoodService>({ resolveOrImportId: jest.fn(async (id: string) => id) });
  const log = new LogService(store.prisma, food, analytics, ptm, aiContext);
  const saved = new SavedFoodsService(store.prisma, food, analytics, ptm, aiContext);
  const workout = new WorkoutService(store.prisma, ptm, aiContext);
  return { ...store, ...spies, log, saved, workout };
}

type World = ReturnType<typeof setup>;

/** Every side effect a save fires, counted. */
async function effects(w: World) {
  await tick(); // PtmService.emit writes its signal on a later turn
  await tick();
  return {
    analytics: w.capture.mock.calls.length,
    signals: w.signals.length,
    emits: w.emit.mock.calls.length,
    aiResets: w.invalidate.mock.calls.length,
  };
}

interface KeyedSave {
  route: string;
  /** Sends the save once as `userId`, with `key` (or none). */
  send: (w: World, userId: string, key?: string) => Promise<unknown>;
  /** The rows this save writes for `userId`. */
  rows: (w: World, userId: string) => Row[];
  /** What one first save fires. */
  first: { analytics: number; signals: number; signalType: string; aiResets: number };
  /** Keys are global (client_uuid): another person's key is not found. Per person (Idempotency-Key): their own save. */
  globalKey: boolean;
}

const SAVES: KeyedSave[] = [
  {
    route: 'POST /log/food',
    send: (w, userId, key) =>
      w.log.logFood(userId, {
        food_item_id: OATS.id,
        date: '2026-11-03',
        meal_type: 'breakfast',
        quantity_multiplier: 1.5,
        ...(key ? { client_uuid: key } : {}),
      }),
    rows: (w, userId) => w.entries.filter((e) => e.user_id === userId),
    first: { analytics: 1, signals: 1, signalType: 'meal_logged', aiResets: 1 },
    globalKey: true,
  },
  {
    route: 'POST /log/saved-meals/:id/log',
    send: (w, userId, key) =>
      w.saved.logSavedMeal(userId, userId === A ? 'meal-a' : 'meal-b', {
        date: '2026-11-03',
        meal_type: 'breakfast',
        ...(key ? { client_uuid: key } : {}),
      }),
    rows: (w, userId) => w.entries.filter((e) => e.user_id === userId),
    // meal-a has two foods: one event and one signal per food, one AI reset per save.
    first: { analytics: 2, signals: 2, signalType: 'meal_logged', aiResets: 1 },
    globalKey: true,
  },
  {
    route: 'POST /workouts',
    send: (w, userId, key) =>
      w.workout.createWorkout(
        userId,
        {
          workout_name: 'Push day',
          workout_type: 'strength',
          date: '2026-11-03',
          duration_minutes: 45,
          exercises: [{ exercise_name: 'Bench press', muscle_group: 'chest', sets_completed: 2, reps_per_set: [8, 8], weight_per_set: [135, 135] }],
        },
        key,
      ),
    rows: (w, userId) => w.workouts.filter((r) => r.user_id === userId),
    // Workouts fire no analytics event at this head.
    first: { analytics: 0, signals: 1, signalType: 'workout_logged', aiResets: 1 },
    globalKey: false,
  },
];

describe.each(SAVES)('FOOD-RESEND-BE — $route: the same key twice is one save', (save) => {
  const KEY = 'queue-key-0001';
  const once = (s: KeyedSave) => ({
    analytics: s.first.analytics,
    signals: s.first.signals,
    emits: s.first.signals,
    aiResets: s.first.aiResets,
  });

  it('a first save fires each effect once', async () => {
    const w = setup();
    await save.send(w, A, KEY);
    expect(await effects(w)).toEqual(once(save));
    expect(w.signals.every((s) => s.signal_type === save.first.signalType && s.user_id === A)).toBe(true);
    if (save.first.analytics) expect(w.capture).toHaveBeenCalledWith(A, Events.CLIENT_FOOD_LOGGED, { meal_type: 'breakfast' });
  });

  it('a resend returns the first answer, writes nothing and fires nothing', async () => {
    const w = setup();
    const first = await save.send(w, A, KEY);
    const rowsAfterFirst = save.rows(w, A).length;
    const fired = await effects(w);

    const again = await save.send(w, A, KEY);

    expect(again).toEqual(first);
    expect(save.rows(w, A)).toHaveLength(rowsAfterFirst);
    expect(await effects(w)).toEqual(fired);
  });

  it('two sends at the same moment: one save, the same answer, each effect once', async () => {
    const w = setup();
    const [one, two] = await Promise.all([save.send(w, A, KEY), save.send(w, A, KEY)]);

    expect(two).toEqual(one);
    expect(save.rows(w, A)).toHaveLength(save.route === 'POST /log/saved-meals/:id/log' ? 2 : 1);
    expect(await effects(w)).toEqual(once(save));
  });

  it("another person's key never returns or touches their save", async () => {
    const w = setup();
    await save.send(w, A, KEY);
    const theirs = JSON.stringify(save.rows(w, A));
    const fired = await effects(w);

    if (save.globalKey) {
      await expect(save.send(w, B, KEY)).rejects.toThrow('Entry not found');
      expect(save.rows(w, B)).toHaveLength(0);
      expect(await effects(w)).toEqual(fired);
    } else {
      const mine = (await save.send(w, B, KEY)) as Row;
      expect(mine.user_id).toBe(B);
      expect(save.rows(w, B)).toHaveLength(1);
    }
    expect(JSON.stringify(save.rows(w, A))).toBe(theirs);
  });

  it('no key: a plain create, so two sends are two saves', async () => {
    const w = setup();
    await save.send(w, A);
    await save.send(w, A);
    const per = once(save);
    expect(await effects(w)).toEqual({
      analytics: per.analytics * 2,
      signals: per.signals * 2,
      emits: per.emits * 2,
      aiResets: per.aiResets * 2,
    });
  });
});

describe('FOOD-RESEND-BE — POST /log/food answers a resend exactly as the first time', () => {
  it('the stored entry with its food, unchanged by what the resend carries', async () => {
    const w = setup();
    const first = await w.log.logFood(A, {
      food_item_id: OATS.id,
      date: '2026-11-03',
      meal_type: 'lunch',
      quantity_multiplier: 2,
      notes: 'first',
      client_uuid: 'pfl_a-77',
    });
    const again = await w.log.logFood(A, {
      food_item_id: BANANA.id,
      date: '2026-11-04',
      meal_type: 'dinner',
      quantity_multiplier: 9,
      notes: 'second',
      client_uuid: 'pfl_a-77',
    });
    expect(again).toEqual(first);
    expect(again).toMatchObject({ food_item: { name: 'Oats', calories: 380 }, quantity_multiplier: 2, notes: 'first' });
    // The leaderboard counts meal_logged signals: one meal, one signal, the first one's calories.
    expect(w.signals).toEqual([expect.objectContaining({ user_id: A, signal_type: 'meal_logged', value: 760 })]);
  });
});
