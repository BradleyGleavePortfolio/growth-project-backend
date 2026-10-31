/**
 * EXID-BE (#189-D4 op 1): a routine exercise keeps the library exercise it came from, over real HTTP.
 *
 * The real WorkoutController and WorkoutService behind the app's strict ValidationPipe and
 * HttpExceptionFilter, on an in-memory Prisma double that keeps the two routine tables the way Postgres
 * keeps them: a column nothing writes reads null, and a catalog id with no library row is refused the way
 * the foreign key refuses it. test/rls/routine-catalog-exercise-id-rls.spec.ts runs the same paths on the
 * real migration chain. Watch video on the phone (m#917) opens a library video only from this id.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import { stub } from './utils/trial-fakes';

const H_USER = 'x-test-user';
const ME = 'client-exid-a';
const OTHER = 'client-exid-b';
// Two library exercises (ExerciseCatalogItem ids) and a uuid that is not one (removed, or never was).
const LIBRARY = '7f0c1a52-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const LIBRARY_2 = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const NOT_IN_LIBRARY = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';

type Row = Record<string, unknown>;
type Where = { id?: string | { in: string[] }; routine_id?: string; OR?: Array<{ creator_id?: string }> };

class HeaderUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'client' };
    return true;
  }
}

function makeDb() {
  const library = new Set([LIBRARY, LIBRARY_2]);
  const routines: Row[] = [{ id: 'template-1', creator_id: 'tgp-admin', name: 'Starter', is_template: true }];
  const exercises: Row[] = [];
  const lookups: string[][] = [];
  let seq = 0;
  // Postgres: the new column reads null when nothing writes it; the foreign key refuses an id with no row.
  const insert = (routine_id: string, rows: Row[]) => {
    for (const e of rows) {
      const id = e.catalog_exercise_id ?? null;
      if (id !== null && !library.has(String(id))) {
        throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
          code: 'P2003',
          clientVersion: 'test',
        });
      }
    }
    for (const e of rows) {
      exercises.push({ id: `ex-${++seq}`, video_url: null, ...e, routine_id, catalog_exercise_id: e.catalog_exercise_id ?? null });
    }
    return { count: rows.length };
  };
  const full = (r: Row) => ({
    ...r,
    exercises: exercises
      .filter((x) => x.routine_id === r.id)
      .sort((a, b) => Number(a.order_index) - Number(b.order_index)),
  });
  const db = {
    workoutRoutine: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        routines.filter((r) => r.creator_id === where.OR?.[0]?.creator_id || r.is_template === true).map(full),
      ),
      findUnique: jest.fn(async ({ where, include }: { where: Where; include?: unknown }) => {
        const r = routines.find((x) => x.id === where.id);
        if (!r) return null;
        return include ? full(r) : { ...r };
      }),
      create: jest.fn(async ({ data }: { data: Row & { exercises?: { create: Row[] } } }) => {
        const { exercises: nested, ...rest } = data;
        const r: Row = { id: `routine-${++seq}`, is_template: false, ...rest };
        insert(String(r.id), nested?.create ?? []);
        routines.push(r);
        return full(r);
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const r = routines.find((x) => x.id === where.id);
        if (!r) throw new Error('no routine');
        for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
        return { ...r };
      }),
    },
    routineExercise: {
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = exercises.length;
        for (let i = exercises.length - 1; i >= 0; i--) if (exercises[i].routine_id === where.routine_id) exercises.splice(i, 1);
        return { count: before - exercises.length };
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => insert(String(data[0]?.routine_id), data)),
    },
    exerciseCatalogItem: {
      findMany: jest.fn(async ({ where }: { where: Where }) => {
        const ids = typeof where.id === 'object' ? where.id.in : [];
        lookups.push(ids);
        return ids.filter((id) => library.has(id)).map((id) => ({ id }));
      }),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  };
  return { db, routines, exercises, lookups };
}

type HttpResult = { status: number; body: Row & { exercises?: Row[] } };

describe('EXID-BE: catalog_exercise_id on each routine exercise (POST, PUT and GET /routines)', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  let state: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    state = makeDb();
    const service = new WorkoutService(stub(state.db), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }));
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkoutController],
      providers: [{ provide: WorkoutService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderUser)
      .overrideGuard(ClientEntitlementGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // As src/main.ts sets them.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${stub<AddressInfo>(app.getHttpServer().address()).port}`;
  });
  afterEach(async () => {
    await app?.close();
  });

  function call(method: 'GET' | 'POST' | 'PUT', path: string, user: string, body?: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: { [H_USER]: user, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  const exercise = (name: string, order_index: number, extra: Row = {}) => ({
    exercise_name: name,
    muscle_group: 'chest',
    default_sets: 3,
    default_reps: 8,
    order_index,
    ...extra,
  });
  const ids = (r: HttpResult) => (r.body.exercises ?? []).map((e) => e.catalog_exercise_id);
  const mine = async (user = ME) => {
    const got = await call('GET', '/routines', user);
    expect(got.status).toBe(200);
    return stub<Array<Row & { exercises: Row[] }>>(got.body).filter((r) => r.creator_id === user);
  };

  it('a routine saved with a library exercise keeps its id on the next GET /routines', async () => {
    const saved = await call('POST', '/routines', ME, {
      name: 'Push day',
      exercises: [exercise('Barbell Bench Press', 0, { catalog_exercise_id: LIBRARY })],
    });
    expect(saved.status).toBe(201);
    const [routine] = await mine();
    expect(routine.exercises.map((e) => [e.exercise_name, e.catalog_exercise_id])).toEqual([
      ['Barbell Bench Press', LIBRARY],
    ]);
  });

  it('an id with no library row saves as null and the rest of the routine still saves', async () => {
    const saved = await call('POST', '/routines', ME, {
      name: 'Push day',
      exercises: [
        exercise('Barbell Bench Press', 0, { catalog_exercise_id: LIBRARY }),
        exercise('Removed library move', 1, { catalog_exercise_id: NOT_IN_LIBRARY }),
        exercise('My own press', 2),
        exercise('Incline Press', 3, { catalog_exercise_id: LIBRARY }),
      ],
    });
    expect(saved.status).toBe(201);
    expect(ids(saved)).toEqual([LIBRARY, null, null, LIBRARY]);
    const [routine] = await mine();
    expect(routine.exercises.map((e) => e.exercise_name)).toEqual([
      'Barbell Bench Press',
      'Removed library move',
      'My own press',
      'Incline Press',
    ]);
    expect(routine.exercises.map((e) => e.catalog_exercise_id)).toEqual([LIBRARY, null, null, LIBRARY]);
    // One read of the library for the save, each id once.
    expect(state.lookups).toEqual([[LIBRARY, NOT_IN_LIBRARY]]);
  });

  it('an edit (PUT /routines/:id) sets, changes and clears the id; an id gone from the library saves null', async () => {
    const saved = await call('POST', '/routines', ME, {
      name: 'Legs',
      exercises: [exercise('Squat', 0, { catalog_exercise_id: LIBRARY }), exercise('Lunge', 1, { catalog_exercise_id: LIBRARY })],
    });
    const edited = await call('PUT', `/routines/${saved.body.id}`, ME, {
      exercises: [
        exercise('Squat', 0, { catalog_exercise_id: LIBRARY_2 }),
        exercise('Lunge', 1, { catalog_exercise_id: null }),
        exercise('Split squat', 2, { catalog_exercise_id: NOT_IN_LIBRARY }),
        exercise('Leg press', 3),
      ],
    });
    expect(edited.status).toBe(200);
    expect(ids(edited)).toEqual([LIBRARY_2, null, null, null]);
    const [routine] = await mine();
    expect(routine.exercises.map((e) => e.catalog_exercise_id)).toEqual([LIBRARY_2, null, null, null]);
  });

  it('a save that sends no id (an older phone) reads null and makes no library read', async () => {
    const saved = await call('POST', '/routines', ME, { name: 'Pull', exercises: [exercise('Row', 0)] });
    expect(saved.status).toBe(201);
    expect(ids(saved)).toEqual([null]);
    const renamed = await call('PUT', `/routines/${saved.body.id}`, ME, { name: 'Pull day' });
    expect(renamed.status).toBe(200);
    expect(ids(renamed)).toEqual([null]);
    expect(state.db.exerciseCatalogItem.findMany).not.toHaveBeenCalled();
  });

  it('a value that is not a uuid is refused with 400 and nothing is saved', async () => {
    const saved = await call('POST', '/routines', ME, {
      name: 'Push day',
      exercises: [exercise('Bench', 0, { catalog_exercise_id: 'barbell-bench-press' })],
    });
    expect(saved.status).toBe(400);
    expect(state.routines.filter((r) => r.creator_id === ME)).toHaveLength(0);
    expect(state.exercises).toHaveLength(0);
  });

  it('another member cannot write a routine through the field, nor a client a template', async () => {
    const saved = await call('POST', '/routines', ME, {
      name: 'Push day',
      exercises: [exercise('Bench', 0, { catalog_exercise_id: LIBRARY })],
    });
    const theirs = await call('PUT', `/routines/${saved.body.id}`, OTHER, {
      exercises: [exercise('Bench', 0, { catalog_exercise_id: LIBRARY_2 })],
    });
    expect(theirs.status).toBe(404);
    const template = await call('PUT', '/routines/template-1', ME, {
      exercises: [exercise('Bench', 0, { catalog_exercise_id: LIBRARY })],
    });
    expect(template.status).toBe(404);
    const publish = await call('POST', '/routines', ME, {
      name: 'Mine for everyone',
      is_template: true,
      exercises: [exercise('Bench', 0, { catalog_exercise_id: LIBRARY })],
    });
    expect(publish.status).toBe(400);
    const [routine] = await mine();
    expect(routine.exercises.map((e) => e.catalog_exercise_id)).toEqual([LIBRARY]);
    expect(state.exercises.filter((e) => e.routine_id === 'template-1')).toHaveLength(0);
    expect(await mine(OTHER)).toHaveLength(0);
  });
});
