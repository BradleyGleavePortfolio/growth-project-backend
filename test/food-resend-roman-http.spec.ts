/**
 * FOOD-RESEND-ROMAN-BE (LO-1209 B1 and N1): a keyed save the phone sends again
 * after a lost answer stores nothing new, so it keeps Roman's context.
 *
 * The three keyed save paths that answer a stored row: POST /log/food
 * (client_uuid), POST /me/foods/saved-meals/:id/log (client_uuid, one key per
 * item) and POST /workouts (Idempotency-Key). A first save resets the member's
 * Roman context (the global RomanContextInvalidationInterceptor, as RomanModule
 * registers it, plus the service's own invalidateForUser) and runs its signals
 * once. A resend, and the loser of two sends at once (the P2002 read-back),
 * answer with the stored row, exactly as the first answer, and reset nothing.
 * Another member's key answers 404 and resets nothing (food and saved meals; a
 * workout key is per member, so the same key from another member is that
 * member's own first save). Saves with no key are each a new save that resets.
 *
 * Real Nest HTTP app: the real controllers and services, the global interceptor
 * as APP_INTERCEPTOR, the whitelist ValidationPipe and real fetch. A fake table
 * holds the unique keys: an insert of a stored key throws P2002, and a tick
 * before each read and write lets two sends at once both miss the lookup.
 */
import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { FoodService } from '../src/food/food.service';
import type { AnalyticsService } from '../src/analytics/analytics.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { LogController } from '../src/log/log.controller';
import { LogService } from '../src/log/log.service';
import { SavedFoodsController } from '../src/log/saved-foods.controller';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import {
  RomanContextInvalidationInterceptor,
  _resetRomanContextListeners,
  onRomanContextInvalidate,
} from '../src/roman/context/roman-context-invalidation';

function stub<T>(value: unknown): T {
  return value as T;
}

const A = 'frr-member-a';
const B = 'frr-member-b';
const OATS = { id: 'food-oats', name: 'Oats', calories: 380, protein_g: 13, carbs_g: 68, fat_g: 7 };
const EGGS = { id: 'food-eggs', name: 'Eggs', calories: 140, protein_g: 12, carbs_g: 1, fat_g: 10 };
const FOODS: Record<string, typeof OATS> = { [OATS.id]: OATS, [EGGS.id]: EGGS };

const tick = () => new Promise((r) => setImmediate(r));
let uniqueViolations = 0;
const p2002 = () => {
  uniqueViolations += 1;
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
};

/**
 * Two sends at once: while armed, the first two lookups of a "-race" key wait for each other, so both
 * miss the stored row and the second insert is the P2002 the read-back answers.
 */
let raceGate: { waiting: (() => void)[] } | null = null;
async function lookup(key: string) {
  await tick();
  const gate = raceGate;
  if (!gate || !key.includes('-race')) return;
  await new Promise<void>((release) => {
    gate.waiting.push(release);
    if (gate.waiting.length === 2) {
      raceGate = null;
      gate.waiting.forEach((go) => go());
    }
  });
}

type Row = Record<string, unknown> & { id: string; user_id: string };

/**
 * loggedFoodEntry with its unique client_uuid. create is lazy like a PrismaPromise, so a
 * $transaction of creates stores all of them or none.
 */
function foodTable() {
  const rows: (Row & { client_uuid: string | null; food_item_id: string })[] = [];
  let n = 0;
  const withFood = (r: (typeof rows)[number]) => ({ ...r, food_item: FOODS[r.food_item_id] });
  const insertAll = (batch: Record<string, unknown>[]) => {
    const keys = batch.map((d) => (d.client_uuid as string | undefined) ?? null).filter((k) => k !== null);
    if (keys.some((k) => rows.some((r) => r.client_uuid === k))) throw p2002();
    return batch.map((d) => {
      n += 1;
      const row = {
        id: `entry-${n}`,
        quantity_multiplier: 1,
        logged_at: new Date(1_800_000_000_000 + n),
        ...d,
        client_uuid: (d.client_uuid as string | undefined) ?? null,
      } as unknown as (typeof rows)[number];
      rows.push(row);
      return withFood(row);
    });
  };
  const lazyCreate = (data: Record<string, unknown>) => ({
    data,
    then<R1, R2>(ok: (v: unknown) => R1, fail?: (e: unknown) => R2) {
      return tick()
        .then(() => insertAll([data])[0])
        .then(ok, fail);
    },
  });
  return {
    rows,
    findUnique: jest.fn(async ({ where }: { where: { client_uuid: string } }) => {
      await lookup(where.client_uuid);
      const row = rows.find((r) => r.client_uuid === where.client_uuid);
      return row ? withFood(row) : null;
    }),
    findMany: jest.fn(async ({ where }: { where: { client_uuid: { in: string[] } } }) => {
      await lookup(where.client_uuid.in[0] ?? '');
      return rows.filter((r) => r.client_uuid !== null && where.client_uuid.in.includes(r.client_uuid)).map(withFood);
    }),
    // logFood reaches the upsert only after its own lookup missed; two sends at once both get here and
    // the second insert of the key is a P2002 (what Prisma's read-then-insert upsert throws in that race).
    upsert: jest.fn(async ({ create }: { where: { client_uuid: string }; create: Record<string, unknown> }) => {
      await tick();
      return insertAll([create])[0];
    }),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => lazyCreate(data)),
    transaction: async (ops: { data: Record<string, unknown> }[]) => {
      await tick();
      return insertAll(ops.map((o) => o.data));
    },
  };
}

/** workoutSession with its unique (user_id, client_key). */
function workoutTable() {
  const rows: (Row & { client_key: string | null })[] = [];
  let n = 0;
  return {
    rows,
    findUnique: jest.fn(
      async ({ where }: { where: { user_id_client_key: { user_id: string; client_key: string } } }) => {
        const { user_id, client_key } = where.user_id_client_key;
        await lookup(client_key);
        const row = rows.find((r) => r.user_id === user_id && r.client_key === client_key);
        return row ? { ...row, exercises: [] } : null;
      },
    ),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> & { user_id: string; client_key?: string } }) => {
      await tick();
      const key = data.client_key ?? null;
      if (key !== null && rows.some((r) => r.user_id === data.user_id && r.client_key === key)) throw p2002();
      n += 1;
      const { exercises: _nested, ...fields } = data;
      const row = { id: `workout-${n}`, created_at: new Date('2026-11-04T10:00:00.000Z'), ...fields, client_key: key };
      rows.push(row);
      return { ...row, exercises: [] };
    }),
  };
}

/** Signs in as the member named in the x-test-member header (stands in for the auth and client guards). */
class HeaderMember implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    req.user = { id: req.headers['x-test-member'] ?? A, role: 'student' };
    return true;
  }
}

let app: INestApplication;
let base: string;
const food = foodTable();
const workouts = workoutTable();
const interceptorResets: string[] = [];
const serviceResets = jest.fn();
const capture = jest.fn();
const emit = jest.fn();

beforeAll(async () => {
  _resetRomanContextListeners();
  onRomanContextInvalidate((userId) => interceptorResets.push(userId));
  const prisma = stub<PrismaService>({
    loggedFoodEntry: food,
    workoutSession: workouts,
    // Each member owns one saved meal of two foods.
    savedMeal: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; user_id: string } }) =>
        where.id === `meal-${where.user_id}`
          ? {
              id: where.id,
              user_id: where.user_id,
              items: [
                { position: 0, food_item_id: OATS.id, quantity_multiplier: 1, original_quantity: null },
                { position: 1, food_item_id: EGGS.id, quantity_multiplier: 2, original_quantity: 2 },
              ],
            }
          : null,
      ),
    },
    $transaction: food.transaction,
  });
  const aiContext = stub<ClientAIContextService>({ invalidateForUser: serviceResets });
  const analytics = stub<AnalyticsService>({ capture });
  const ptm = stub<PtmService>({ emit });
  const foods = stub<FoodService>({ resolveOrImportId: jest.fn(async (id: string) => id) });
  const mod = await Test.createTestingModule({
    controllers: [LogController, SavedFoodsController, WorkoutController],
    providers: [
      { provide: LogService, useValue: new LogService(prisma, foods, analytics, ptm, aiContext) },
      { provide: SavedFoodsService, useValue: new SavedFoodsService(prisma, foods, analytics, ptm, aiContext) },
      { provide: WorkoutService, useValue: new WorkoutService(prisma, ptm, aiContext) },
      // The production binding from RomanModule.
      { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderMember)
    .overrideGuard(ClientEntitlementGuard)
    .useClass(HeaderMember)
    .overrideGuard(RolesGuard)
    .useClass(HeaderMember)
    .compile();
  app = mod.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  _resetRomanContextListeners();
});

beforeEach(() => clear());

interface RouteCase {
  name: string;
  /** Rows the route's table holds. */
  count: () => number;
  /** One save: `key` goes in the body (food, saved meal) or the Idempotency-Key header (workout). */
  send: (member: string, n: number, key?: string) => Promise<{ status: number; body: unknown }>;
  /** Rows one save stores, and the signals it runs (analytics events, PTM emits). */
  rowsPerSave: number;
  captures: number;
  emits: number;
  /** Another member sending this member's key: 404 (the key is unique across members) or their own first save. */
  otherMemberKey: 404 | 'own-first-save';
}

async function call(path: string, member: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-member': member, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

const ROUTES: RouteCase[] = [
  {
    name: 'POST /log/food',
    count: () => food.rows.length,
    send: (member, n, key) =>
      call('/log/food', member, {
        date: '2026-11-04',
        meal_type: 'breakfast',
        food_item_id: OATS.id,
        quantity_multiplier: n,
        ...(key ? { client_uuid: key } : {}),
      }),
    rowsPerSave: 1,
    captures: 1,
    emits: 1,
    otherMemberKey: 404,
  },
  {
    name: 'POST /me/foods/saved-meals/:id/log',
    count: () => food.rows.length,
    send: (member, n, key) =>
      call(`/me/foods/saved-meals/meal-${member}/log`, member, {
        date: '2026-11-04',
        meal_type: n % 2 ? 'lunch' : 'dinner',
        ...(key ? { client_uuid: key } : {}),
      }),
    rowsPerSave: 2,
    captures: 2,
    emits: 2,
    otherMemberKey: 404,
  },
  {
    name: 'POST /workouts',
    count: () => workouts.rows.length,
    send: (member, n, key) =>
      call(
        '/workouts',
        member,
        { date: '2026-11-04', workout_name: `Push ${n}`, workout_type: 'strength', duration_minutes: 30 + n },
        key ? { 'idempotency-key': key } : {},
      ),
    rowsPerSave: 1,
    captures: 0,
    emits: 1,
    otherMemberKey: 'own-first-save',
  },
];

const effects = (member = A) => ({
  interceptorResets: interceptorResets.filter((u) => u === member).length,
  serviceResets: serviceResets.mock.calls.filter(([u]) => u === member).length,
  captures: capture.mock.calls.length,
  emits: emit.mock.calls.length,
});
const clear = () => {
  interceptorResets.length = 0;
  serviceResets.mockClear();
  capture.mockClear();
  emit.mockClear();
};

describe.each(ROUTES)('FOOD-RESEND-ROMAN-BE: $name', (route) => {
  const key = `frr-${route.name.replace(/[^a-z]/gi, '')}-key`;
  const firstSave = { interceptorResets: 1, serviceResets: 1, captures: route.captures, emits: route.emits };
  const nothing = { interceptorResets: 0, serviceResets: 0, captures: 0, emits: 0 };

  it('the first keyed save resets once; the resend answers the same body and status and resets nothing', async () => {
    const before = route.count();
    const first = await route.send(A, 1, key);
    expect(first.status).toBe(201);
    expect(route.count()).toBe(before + route.rowsPerSave);
    expect(effects()).toEqual(firstSave);

    clear();
    const resend = await route.send(A, 2, key);
    expect(resend).toEqual(first);
    expect(route.count()).toBe(before + route.rowsPerSave);
    expect(effects()).toEqual(nothing);
  });

  it('the mark is for that one request: the next new keyed save still resets once', async () => {
    const next = await route.send(A, 3, `${key}-next`);
    expect(next.status).toBe(201);
    expect(effects()).toEqual(firstSave);
  });

  it('two sends at once: one save, the loser (P2002 read-back) answers the same and resets nothing more', async () => {
    const before = route.count();
    const violations = uniqueViolations;
    raceGate = { waiting: [] };
    const [one, two] = await Promise.all([route.send(A, 4, `${key}-race`), route.send(A, 5, `${key}-race`)]);
    expect(raceGate).toBeNull();
    expect(uniqueViolations).toBe(violations + 1);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(two.body).toEqual(one.body);
    expect(route.count()).toBe(before + route.rowsPerSave);
    expect(effects()).toEqual(firstSave);
  });

  it("another member sending this member's key resets nothing for this member", async () => {
    const before = route.count();
    const theirs = await route.send(B, 6, key);
    expect(effects(A)).toEqual(nothing);
    if (route.otherMemberKey === 404) {
      expect(theirs.status).toBe(404);
      expect(theirs.body).toMatchObject({ message: 'Entry not found' });
      expect(route.count()).toBe(before);
      expect(effects(B)).toEqual(nothing);
    } else {
      // The workout key is unique per member: the same key is B's own first save, with B's own reset.
      expect(theirs.status).toBe(201);
      expect(route.count()).toBe(before + route.rowsPerSave);
      expect(effects(B)).toEqual(firstSave);
    }
  });

  it('two saves with no key are two saves, each resetting', async () => {
    const before = route.count();
    const one = await route.send(A, 7);
    const two = await route.send(A, 7);
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(two.body).not.toEqual(one.body);
    expect(route.count()).toBe(before + 2 * route.rowsPerSave);
    expect(effects()).toEqual({
      interceptorResets: 2,
      serviceResets: 2,
      captures: 2 * route.captures,
      emits: 2 * route.emits,
    });
  });
});
