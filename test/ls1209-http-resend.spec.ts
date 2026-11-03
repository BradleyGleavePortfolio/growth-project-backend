/**
 * LS-1209 B1: a no-op resend must stay a no-op through the installed HTTP
 * interceptor, not only when the save service is called directly.
 * Real controllers, services, validation, exception filter and interceptor;
 * only authentication and the persistence adapter are test doubles.
 */
import 'reflect-metadata';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { FoodService } from '../src/food/food.service';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { LogController } from '../src/log/log.controller';
import { LogService } from '../src/log/log.service';
import { SavedFoodsController } from '../src/log/saved-foods.controller';
import { SavedFoodsService } from '../src/log/saved-foods.service';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import {
  _resetRomanContextListeners,
  onRomanContextInvalidate,
  RomanContextInvalidationInterceptor,
} from '../src/roman/context/roman-context-invalidation';
import { stub } from './utils/trial-fakes';

type Row = Record<string, any>;
const A = 'client-a';
const B = 'client-b';
const FOOD = { id: 'food-1', name: 'Oats', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 };
const KEY = 'offline-key-1209';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const collision = () => new Prisma.PrismaClientKnownRequestError('Unique key', { code: 'P2002', clientVersion: 'test' });

class HeaderUser implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const id = req.headers['x-test-user'];
    if (!id) throw new UnauthorizedException();
    req.user = { id, role: 'student' };
    return true;
  }
}

function database() {
  const entries: Row[] = [];
  const workouts: Row[] = [];
  let seq = 0;
  const withFood = (row: Row) => ({ ...row, food_item: FOOD });
  const create = async ({ data }: Row) => {
    await tick();
    if (data.client_uuid && entries.some((r) => r.client_uuid === data.client_uuid)) throw collision();
    const row = { id: `entry-${++seq}`, logged_at: new Date(), plan_slot_id: null, fills_usual_meal: false, ...data };
    entries.push(row);
    return withFood(row);
  };
  const db = {
    loggedFoodEntry: {
      create: jest.fn(create),
      findUnique: jest.fn(async ({ where }: Row) => {
        await tick();
        const row = entries.find((r) => r.client_uuid === where.client_uuid);
        return row ? withFood(row) : null;
      }),
      findMany: jest.fn(async ({ where }: Row) => entries.filter((r) => where.client_uuid.in.includes(r.client_uuid)).map(withFood)),
      // Kept for an exact base comparison, where food still uses upsert.
      upsert: jest.fn(async ({ where, create: data }: Row) => {
        const row = entries.find((r) => r.client_uuid === where.client_uuid);
        return row ? withFood(row) : create({ data });
      }),
    },
    savedMeal: {
      findFirst: jest.fn(async ({ where }: Row) => where.user_id === A ? {
        id: 'meal-1', user_id: A,
        items: [{ food_item_id: FOOD.id, quantity_multiplier: 1, position: 0 }],
      } : null),
    },
    workoutSession: {
      findUnique: jest.fn(async ({ where }: Row) => {
        const k = where.user_id_client_key;
        return workouts.find((r) => r.user_id === k.user_id && r.client_key === k.client_key) ?? null;
      }),
      create: jest.fn(async ({ data }: Row) => {
        if (data.client_key && workouts.some((r) => r.user_id === data.user_id && r.client_key === data.client_key)) throw collision();
        const row = { ...data, id: `workout-${++seq}`, exercises: [] };
        workouts.push(row);
        return row;
      }),
    },
    $transaction: jest.fn(async (writes: Promise<unknown>[]) => Promise.all(writes)),
  };
  return { db, entries, workouts };
}

const SAVES = [
  { path: '/log/food', body: { date: '2026-11-03', meal_type: 'breakfast', food_item_id: FOOD.id }, headerKey: false },
  // This is the actual mounted path, not /log/saved-meals/:id/log.
  { path: '/me/foods/saved-meals/meal-1/log', body: { date: '2026-11-03', meal_type: 'breakfast' }, headerKey: false },
  { path: '/workouts', body: { date: '2026-11-03', workout_name: 'Push day', workout_type: 'strength', duration_minutes: 30 }, headerKey: true },
];

describe('LS-1209: keyed saves through real HTTP and the global context interceptor', () => {
  let app: INestApplication;
  let url: string;
  let state: ReturnType<typeof database>;
  let seen: string[];
  let effects: { capture: jest.Mock; emit: jest.Mock };
  let invalidate: jest.SpyInstance;

  beforeEach(async () => {
    _resetRomanContextListeners();
    state = database();
    seen = [];
    onRomanContextInvalidate((id) => seen.push(id));
    effects = { capture: jest.fn(), emit: jest.fn() };
    const context = new ClientAIContextService(stub(state.db));
    invalidate = jest.spyOn(context, 'invalidateForUser');
    const food = stub<FoodService>({ resolveOrImportId: jest.fn(async () => FOOD.id) });
    const prisma = stub<PrismaService>(state.db);
    const moduleRef = await Test.createTestingModule({
      controllers: [LogController, SavedFoodsController, WorkoutController],
      providers: [
        { provide: LogService, useValue: new LogService(prisma, food, stub(effects), stub(effects), context) },
        { provide: SavedFoodsService, useValue: new SavedFoodsService(prisma, food, stub(effects), stub(effects), context) },
        { provide: WorkoutService, useValue: new WorkoutService(prisma, stub(effects), context) },
        { provide: APP_INTERCEPTOR, useClass: RomanContextInvalidationInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard).useClass(HeaderUser)
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .overrideGuard(ClientEntitlementGuard).useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterEach(async () => {
    await app?.close();
    _resetRomanContextListeners();
  });

  async function post(save: typeof SAVES[number], key: string | undefined = KEY, user = A, extra: Row = {}) {
    const res = await fetch(`${url}${save.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-test-user': user,
        ...(save.headerKey && key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify({ ...save.body, ...(!save.headerKey && key ? { client_uuid: key } : {}), ...extra }),
    });
    return { status: res.status, body: await res.json() };
  }

  it.each(SAVES)('$path: resend returns the stored HTTP answer and emits zero context invalidations', async (save) => {
    const first = await post(save);
    expect(first.status).toBe(201);
    expect(seen.length).toBeGreaterThan(0); // First-save freshness must not be disabled.
    const captures = effects.capture.mock.calls.length;
    const emits = effects.emit.mock.calls.length;
    const resets = invalidate.mock.calls.length;
    const rows = state.entries.length + state.workouts.length;
    seen.length = 0;

    const retry = await post(save);

    expect(retry).toEqual(first);
    expect(state.entries.length + state.workouts.length).toBe(rows);
    expect(effects.capture).toHaveBeenCalledTimes(captures);
    expect(effects.emit).toHaveBeenCalledTimes(emits);
    expect(invalidate).toHaveBeenCalledTimes(resets);
    expect(seen).toEqual([]);
  });

  it('foreign food key: HTTP 404, unchanged row and zero side effects', async () => {
    await post(SAVES[0]);
    const before = JSON.stringify(state.entries);
    const captures = effects.capture.mock.calls.length;
    const emits = effects.emit.mock.calls.length;
    seen.length = 0;
    const rejected = await post(SAVES[0], KEY, B);
    expect(rejected.status).toBe(404);
    expect(JSON.stringify(rejected.body)).toContain('Entry not found');
    expect(JSON.stringify(rejected.body)).not.toContain(A);
    expect(JSON.stringify(state.entries)).toBe(before);
    expect(effects.capture).toHaveBeenCalledTimes(captures);
    expect(effects.emit).toHaveBeenCalledTimes(emits);
    expect(seen).toEqual([]);
  });

  it('invalid DTO: HTTP 400 writes nothing and invalidates nothing', async () => {
    expect((await post(SAVES[0], KEY, A, { meal_type: 'invalid' })).status).toBe(400);
    expect(state.entries).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it('no food key: two ordinary HTTP creates preserve first-save effects', async () => {
    // Empty string is intentionally treated as absent by the existing API.
    expect((await post(SAVES[0], '')).status).toBe(201);
    expect((await post(SAVES[0], '')).status).toBe(201);
    expect(state.entries).toHaveLength(2);
    expect(effects.capture).toHaveBeenCalledTimes(2);
    expect(effects.emit).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([A, A, A, A]); // Direct plus global, unchanged on first saves.
  });
});
