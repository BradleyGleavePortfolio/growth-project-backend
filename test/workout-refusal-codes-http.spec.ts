/**
 * WORKOUT-REFUSAL-CODES-BE (owner 203-P1, Style 2 "Tells you why"), over real HTTP.
 *
 * A workout the server refuses on POST /workouts or PUT /workouts/:id answers with a stable `code` and one
 * plain `next_step` sentence beside everything it sends today, so the phone's refused-workout card can say
 * what to do. Two refusals a client can meet are coded: the ValidationPipe's array (WORKOUT_INVALID) and the
 * update's "Workout not found" (WORKOUT_NOT_FOUND). Every other answer, on these two routes and every other
 * route, stays exactly main's: the phone reads `message` (workoutSaveKey.ts refusesPlanRows) and `error`.
 *
 * The real WorkoutController and WorkoutService on an in-memory store, the pipe and both global filters as
 * src/main.ts:97-103 and :118 set them, the real JwtAuthGuard (built as test/auth-guard-deletion-lockout
 * .spec.ts builds it) and the real RolesGuard. Expected answers are main's literals, written out.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type CanActivate, type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerException } from '@nestjs/throttler';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import type { JwksVerifierService } from '../src/auth/jwks.service';
import { RolesGuard } from '../src/auth/roles.guard';
import { ClientEntitlementGuard } from '../src/common/guards/client-entitlement.guard';
import { pickErrorDetails } from '../src/filters/error-details';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { ThrottlerExceptionFilter } from '../src/filters/throttler-exception.filter';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import { stub } from './utils/trial-fakes';

// The two next steps, word for word (WORKOUT-REFUSAL-W2, -W3).
const NEXT_INVALID = 'If an app update is waiting, install it, then send it again.';
const NEXT_NOT_FOUND = 'This workout is no longer in your history. Remove it from this phone.';
const SCHEDULED = 'Account is scheduled for deletion; cancel the deletion to regain access';
const REQUEST_ID = 'wr-request-1';
const H_THROTTLE = 'x-test-throttle';

type Row = Record<string, unknown>;
type Person = { id: string; supabase_id: string; role: string; dob: Date | null; deleted_at: Date | null; deletion_scheduled_at: Date | null };
const person = (id: string, extra: Partial<Person> = {}): Person => ({
  id,
  supabase_id: `sub-${id}`,
  role: 'student',
  dob: new Date('1990-01-01T00:00:00Z'),
  deleted_at: null,
  deletion_scheduled_at: null,
  ...extra,
});
const ME = person('client-wr-a');
const OTHER = person('client-wr-b');
const LEAVING = person('client-wr-leaving', { deletion_scheduled_at: new Date('2026-11-20T00:00:00Z') });
const GONE = person('client-wr-gone', { deleted_at: new Date('2026-11-20T00:00:00Z') });
const YOUNG = person('client-wr-young', { dob: null });
const ODD_ROLE = person('client-wr-odd', { role: 'visitor' });
const PEOPLE = [ME, OTHER, LEAVING, GONE, YOUNG, ODD_ROLE];

function makeStore() {
  const sessions: Row[] = [];
  const sets: Row[] = [];
  let seq = 0;
  const failing = { create: false };
  const full = (s: Row) => ({ ...s, exercises: sets.filter((x) => x.workout_id === s.id) });
  type Where = { id?: string; user_id_client_key?: { user_id: string; client_key: string }; workout_id?: string; supabase_id?: string; user_id?: string };
  const tables = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => PEOPLE.find((p) => p.supabase_id === where.supabase_id) ?? null),
    },
    userProfile: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => ({ date_of_birth: PEOPLE.find((p) => p.id === where.user_id)?.dob ?? null })),
    },
    workoutSession: {
      findUnique: jest.fn(async ({ where, include, select }: { where: Where; include?: unknown; select?: unknown }) => {
        const k = where.user_id_client_key;
        const s = k ? sessions.find((r) => r.user_id === k.user_id && r.client_key === k.client_key) : sessions.find((r) => r.id === where.id);
        if (!s) return null;
        if (select) return { id: s.id, user_id: s.user_id };
        return include ? full(s) : { ...s };
      }),
      create: jest.fn(async ({ data }: { data: Row & { exercises?: { create: Row[] } } }) => {
        if (failing.create) throw new Error('store unavailable');
        const { exercises, ...rest } = data;
        const s: Row = { id: `workout-${++seq}`, ...rest };
        sessions.push(s);
        for (const e of exercises?.create ?? []) sets.push({ id: `set-${++seq}`, workout_id: s.id, ...e });
        return full(s);
      }),
      update: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const s = sessions.find((r) => r.id === where.id);
        if (!s) throw new Error('no workout');
        for (const [k, v] of Object.entries(data)) if (v !== undefined) s[k] = v;
        return { ...s };
      }),
    },
    exerciseSet: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async ({ where }: { where: Where }) => {
        const before = sets.length;
        for (let i = sets.length - 1; i >= 0; i--) if (sets[i].workout_id === where.workout_id) sets.splice(i, 1);
        return { count: before - sets.length };
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        for (const e of data) sets.push({ id: `set-${++seq}`, ...e });
        return { count: data.length };
      }),
    },
    clientWorkoutAssignment: { findMany: jest.fn(async () => []) },
    workoutRoutine: { findUnique: jest.fn(async () => null) },
  };
  const db = { ...tables, $transaction: jest.fn(async (cb: (tx: typeof tables) => unknown) => cb(tables)) };
  const seed = (user_id: string, workout_name: string) => {
    const s: Row = { id: `workout-${++seq}`, user_id, date: '2026-11-20T00:00:00.000Z', workout_name, workout_type: 'strength', intensity: 'moderate' };
    sessions.push(s);
    sets.push({ id: `set-${++seq}`, workout_id: s.id, exercise_name: 'Squat', muscle_group: 'legs', sets_completed: 1, reps_per_set: [5], weight_per_set: [100] });
    return String(s.id);
  };
  return { db, sessions, sets, full, seed, failing };
}

/** Throws the throttler's own exception when the test asks for it, as UserThrottlerGuard does (global). */
class ThrottleWhenAsked implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[H_THROTTLE]) throw new ThrottlerException();
    return true;
  }
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: Row };

describe('WORKOUT-REFUSAL-CODES-BE: a refused workout answers with a code and a plain next step', () => {
  let app: INestApplication | undefined;
  let baseUrl = '';
  let store: ReturnType<typeof makeStore>;

  beforeEach(async () => {
    store = makeStore();
    const service = new WorkoutService(stub(store.db), stub({ emit: jest.fn() }), stub({ invalidateForUser: jest.fn() }));
    // The real guard, its token check standing in for Supabase's JWKS: the token is the subject.
    const jwt = new JwtAuthGuard(
      stub<PrismaService>(store.db),
      stub<JwksVerifierService>({ verify: async (token: string) => ({ sub: token }) }),
      new Reflector(),
      stub<PtmService>({ emit: jest.fn() }),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkoutController],
      providers: [{ provide: WorkoutService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwt)
      // @OpenToCoachlessClient: the guard returns true on these routes (client-entitlement.guard.ts:51-55).
      .overrideGuard(ClientEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = REQUEST_ID;
      next();
    });
    // As src/main.ts sets them.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter(), new ThrottlerExceptionFilter());
    app.useGlobalGuards(new ThrottleWhenAsked());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${stub<AddressInfo>(app.getHttpServer().address()).port}`;
  });
  afterEach(async () => {
    await app?.close();
  });

  function call(method: string, path: string, who: Person | null, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            ...(who ? { authorization: `Bearer ${who.supabase_id}` } : {}),
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : {} }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  /** The envelope less its per-request keys, after checking they are there. */
  function fixed(a: Answer, path: string): Row {
    const { timestamp, path: got, request_id, ...rest } = a.body;
    expect(typeof timestamp).toBe('string');
    expect(got).toBe(path);
    expect(request_id).toBe(REQUEST_ID);
    return rest;
  }

  /** C6: main's literal plus `code` and `next_step`, nothing else. */
  function expectCoded(a: Answer, path: string, main: Row, code: string, nextStep: string): void {
    const { code: gotCode, next_step, ...rest } = fixed(a, path);
    expect(rest).toStrictEqual(main);
    expect({ code: gotCode, next_step }).toStrictEqual({ code, next_step: nextStep });
  }

  /** Byte for byte main's (per-request keys apart): no `code` it did not have, no `next_step`. */
  function expectMain(a: Answer, path: string, main: Row): void {
    expect(fixed(a, path)).toStrictEqual(main);
  }

  const exercise = (extra: Row = {}) => ({
    exercise_name: 'Back Squat',
    muscle_group: 'legs',
    sets_completed: 2,
    reps_per_set: [5, 5],
    weight_per_set: [135, 135],
    ...extra,
  });
  const workout = (extra: Row = {}) => ({
    date: '2026-11-21',
    workout_name: 'Lower body A',
    workout_type: 'strength',
    duration_minutes: 45,
    exercises: [exercise()],
    ...extra,
  });
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));

  const MAIN_SCHEDULED = { statusCode: 403, message: SCHEDULED, error: 'Forbidden' };
  const MAIN_NOT_FOUND = { statusCode: 404, message: 'Workout not found', error: 'Not Found' };
  const invalid = (...lines: string[]) => ({ statusCode: 400, message: lines, error: 'Bad Request' });

  describe('A: the deletion-scheduled 403 is not coded (operator ruling (1): no live writer of deletion_scheduled_at)', () => {
    it('A1 POST /workouts through the real JwtAuthGuard answers exactly main\'s 403', async () => {
      const a = await call('POST', '/workouts', LEAVING, workout());
      expect(a.status).toBe(403);
      expectMain(a, '/workouts', MAIN_SCHEDULED);
      expect(store.sessions).toHaveLength(0);
    });

    it('A2 PUT /workouts/:id answers exactly main\'s 403', async () => {
      const id = store.seed(LEAVING.id, 'Kept');
      const a = await call('PUT', `/workouts/${id}`, LEAVING, { workout_name: 'Changed' });
      expect(a.status).toBe(403);
      expectMain(a, `/workouts/${id}`, MAIN_SCHEDULED);
    });
  });

  describe('B: the ValidationPipe refusal answers WORKOUT_INVALID beside main\'s array', () => {
    it('C3 POST with an unknown top-level field: the same array, still an array, plus the code and next step', async () => {
      const a = await call('POST', '/workouts', ME, workout({ surprise: true }));
      expect(a.status).toBe(400);
      expect(Array.isArray(a.body.message)).toBe(true);
      expectCoded(a, '/workouts', invalid('property surprise should not exist'), 'WORKOUT_INVALID', NEXT_INVALID);
      expect(store.sessions).toHaveLength(0);
    });

    it('C4 POST with a nested value past a limit: each line of main\'s array, plus the code and next step', async () => {
      const neck = await call('POST', '/workouts', ME, workout({ exercises: [exercise({ muscle_group: 'neck' })] }));
      expect(neck.status).toBe(400);
      expectCoded(
        neck,
        '/workouts',
        invalid('exercises.0.muscle_group must be one of the following values: chest, back, legs, shoulders, arms, core, cardio, full_body'),
        'WORKOUT_INVALID',
        NEXT_INVALID,
      );
      const long = await call('POST', '/workouts', ME, workout({ exercises: [exercise({ reps_per_set: Array.from({ length: 101 }, () => 5) })] }));
      expect(long.status).toBe(400);
      expectCoded(long, '/workouts', invalid('exercises.0.reps_per_set must contain no more than 100 elements'), 'WORKOUT_INVALID', NEXT_INVALID);
      expect(store.sessions).toHaveLength(0);
    });

    it('C5 PUT with an unknown field: as C3', async () => {
      const id = store.seed(ME.id, 'Mine');
      const before = json(store.full(store.sessions[0]));
      const a = await call('PUT', `/workouts/${id}`, ME, { workout_name: 'Renamed', surprise: 1 });
      expect(a.status).toBe(400);
      expect(Array.isArray(a.body.message)).toBe(true);
      expectCoded(a, `/workouts/${id}`, invalid('property surprise should not exist'), 'WORKOUT_INVALID', NEXT_INVALID);
      expect(json(store.full(store.sessions[0]))).toStrictEqual(before);
    });
  });

  describe('C: the update\'s 404 answers WORKOUT_NOT_FOUND, the same for a missing and another member\'s workout', () => {
    it('C7 PUT a missing id and another member\'s id: two equal answers, and the other member\'s workout is unchanged', async () => {
      const theirs = store.seed(OTHER.id, 'Their workout');
      const before = json(store.full(store.sessions[0]));
      const missing = await call('PUT', '/workouts/no-such-workout', ME, { workout_name: 'Mine now' });
      const other = await call('PUT', `/workouts/${theirs}`, ME, { workout_name: 'Mine now' });
      expect([missing.status, other.status]).toStrictEqual([404, 404]);
      expectCoded(missing, '/workouts/no-such-workout', MAIN_NOT_FOUND, 'WORKOUT_NOT_FOUND', NEXT_NOT_FOUND);
      expectCoded(other, `/workouts/${theirs}`, MAIN_NOT_FOUND, 'WORKOUT_NOT_FOUND', NEXT_NOT_FOUND);
      // No existence leak: key for key the same, the path apart.
      expect(fixed(missing, '/workouts/no-such-workout')).toStrictEqual(fixed(other, `/workouts/${theirs}`));
      expect(json(store.full(store.sessions[0]))).toStrictEqual(before);
      expect(store.db.workoutSession.update).not.toHaveBeenCalled();
    });
  });

  describe('negatives: every other answer is exactly main\'s', () => {
    it('N1 DELETE /workouts/:id on a missing id: 404 "Workout not found", no code', async () => {
      const a = await call('DELETE', '/workouts/no-such-workout', ME);
      expect(a.status).toBe(404);
      expectMain(a, '/workouts/no-such-workout', MAIN_NOT_FOUND);
    });

    it('N2 the routines keep their answers: POST /routines with an unknown field, PUT /routines/:id on a missing id', async () => {
      const post = await call('POST', '/routines', ME, { name: 'Push day', surprise: true });
      expect(post.status).toBe(400);
      expectMain(post, '/routines', invalid('property surprise should not exist'));
      const put = await call('PUT', '/routines/no-such-routine', ME, { name: 'Pull day' });
      expect(put.status).toBe(404);
      expectMain(put, '/routines/no-such-routine', { statusCode: 404, message: 'Routine not found', error: 'Not Found' });
    });

    it('N3 GET /workouts for the deletion-scheduled client: the guard\'s 403, no code', async () => {
      const a = await call('GET', '/workouts', LEAVING);
      expect(a.status).toBe(403);
      expectMain(a, '/workouts', MAIN_SCHEDULED);
    });

    it('N4 POST /workouts for a deleted account: exactly the ACCOUNT_DELETED body, no next_step', async () => {
      const a = await call('POST', '/workouts', GONE, workout());
      expect(a.status).toBe(403);
      expectMain(a, '/workouts', { statusCode: 403, code: 'ACCOUNT_DELETED', message: 'Account has been deleted', error: 'Forbidden' });
    });

    it('N5 POST /workouts before the age step: AGE_CONFIRMATION_REQUIRED as main, no next_step', async () => {
      const a = await call('POST', '/workouts', YOUNG, workout());
      expect(a.status).toBe(403);
      expectMain(a, '/workouts', { statusCode: 403, code: 'AGE_CONFIRMATION_REQUIRED', message: 'Age confirmation required', error: 'Forbidden' });
    });

    it('N6 POST /workouts with Idempotency-Key "short": the key refusal as main, no code', async () => {
      const a = await call('POST', '/workouts', ME, workout(), { 'idempotency-key': 'short' });
      expect(a.status).toBe(400);
      expectMain(a, '/workouts', {
        statusCode: 400,
        message: 'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -',
        error: 'IDEMPOTENCY_KEY_INVALID',
      });
    });

    it('N7 no bearer token: 401 as main; a role the route refuses, through the real RolesGuard: 403 "Insufficient role", no code', async () => {
      const none = await call('POST', '/workouts', null, workout());
      expect(none.status).toBe(401);
      expectMain(none, '/workouts', { statusCode: 401, message: 'No authentication token provided', error: 'Unauthorized' });
      const odd = await call('POST', '/workouts', ODD_ROLE, workout());
      expect(odd.status).toBe(403);
      expectMain(odd, '/workouts', { statusCode: 403, message: 'Insufficient role', error: 'Forbidden' });
    });

    it('N8 a ThrottlerException on POST /workouts: the 429 body and its Retry-After as main', async () => {
      const a = await call('POST', '/workouts', ME, workout(), { [H_THROTTLE]: '1' });
      expect(a.status).toBe(429);
      expect(a.headers['retry-after']).toBe('3600');
      expect(a.body).toStrictEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many attempts. Please wait before trying again.',
        retryAfter: 3600,
      });
    });

    it('N9 the store throwing on POST: 500 with the generic envelope as main', async () => {
      store.failing.create = true;
      const a = await call('POST', '/workouts', ME, workout());
      expect(a.status).toBe(500);
      expectMain(a, '/workouts', { statusCode: 500, message: 'Internal server error', error: 'Internal Server Error' });
    });

    it('N10 saves answer as main: POST 201 and PUT 200 with the stored workout; one Idempotency-Key twice answers the same workout', async () => {
      const key = { 'idempotency-key': `${ME.id}:1763700000000` };
      const first = await call('POST', '/workouts', ME, workout(), key);
      expect(first.status).toBe(201);
      expect(first.body).toStrictEqual(json(store.full(store.sessions[0])));
      expect(first.body).not.toHaveProperty('code');
      const again = await call('POST', '/workouts', ME, workout(), key);
      expect(again.status).toBe(201);
      expect(again.body).toStrictEqual(first.body);
      expect(store.sessions).toHaveLength(1);
      const put = await call('PUT', `/workouts/${String(first.body.id)}`, ME, { workout_name: 'Lower body B', exercises: [exercise()] });
      expect(put.status).toBe(200);
      expect(put.body).toStrictEqual(json(store.full(store.sessions[0])));
      expect(put.body.workout_name).toBe('Lower body B');
    });

    it('N11 a workout dated 2019-01-01 is saved (plan references and coachless saves: test/set-asked-be.spec.ts, test/coachless-logging-entitlement.spec.ts)', async () => {
      const a = await call('POST', '/workouts', ME, workout({ date: '2019-01-01' }));
      expect(a.status).toBe(201);
      expect(a.body.date).toBe('2019-01-01T00:00:00.000Z');
    });

    it('N12 the router\'s 404 for PUT /workouts/ (no id): as main, no code', async () => {
      const a = await call('PUT', '/workouts/', ME, { workout_name: 'x' });
      expect(a.status).toBe(404);
      expectMain(a, '/workouts/', { statusCode: 404, message: 'Cannot PUT /workouts/', error: 'Not Found' });
    });

    it('N13 no coded answer echoes the request: next_step is one fixed sentence with no id, name, date or field value', async () => {
      const theirs = store.seed(OTHER.id, 'Zq private name');
      const answers = [
        await call('POST', '/workouts', ME, workout({ workout_name: 'Zq session', date: '2019-03-04', zq_field: 'zq-value' })),
        await call('POST', '/workouts', ME, workout({ exercises: [exercise({ muscle_group: 'zq-group' })] })),
        await call('PUT', '/workouts/zq-missing-id', ME, { workout_name: 'Zq session' }),
        await call('PUT', `/workouts/${theirs}`, ME, { notes: 'zq note' }),
      ];
      for (const a of answers) {
        expect([400, 404]).toContain(a.status);
        if (a.body.next_step === undefined) continue;
        expect([NEXT_INVALID, NEXT_NOT_FOUND]).toContain(a.body.next_step);
        expect(String(a.body.next_step)).not.toMatch(/zq|2019|workout-\d/i);
        expect(String(a.body.code)).not.toMatch(/zq|2019|workout-\d/i);
      }
    });
  });

  describe('the allowlist (error-details.ts) lets each next step through for its own code only', () => {
    it('N14a pickErrorDetails returns the next step under its code', () => {
      expect(pickErrorDetails(400, 'WORKOUT_INVALID', { next_step: NEXT_INVALID })).toStrictEqual({ next_step: NEXT_INVALID });
      expect(pickErrorDetails(404, 'WORKOUT_NOT_FOUND', { next_step: NEXT_NOT_FOUND })).toStrictEqual({ next_step: NEXT_NOT_FOUND });
    });

    it('N14b any other string, another code, the other code\'s sentence or a 5xx returns {}', () => {
      expect(pickErrorDetails(400, 'WORKOUT_INVALID', { next_step: 'Something else.' })).toStrictEqual({});
      expect(pickErrorDetails(400, 'WORKOUT_INVALID', { next_step: NEXT_NOT_FOUND })).toStrictEqual({});
      expect(pickErrorDetails(404, 'WORKOUT_NOT_FOUND', { next_step: NEXT_INVALID })).toStrictEqual({});
      expect(pickErrorDetails(403, 'ROMAN_REQUIRES_COACH', { next_step: NEXT_INVALID })).toStrictEqual({});
      expect(pickErrorDetails(400, undefined, { next_step: NEXT_INVALID })).toStrictEqual({});
      expect(pickErrorDetails(500, 'WORKOUT_INVALID', { next_step: NEXT_INVALID })).toStrictEqual({});
    });

    it('N15 with WorkoutController loaded before anything under src/filters/, the allowlist still holds both codes', () => {
      let picked: unknown[] = [];
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../src/workout/workout.controller');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const details: typeof import('../src/filters/error-details') = require('../src/filters/error-details');
        picked = [
          details.pickErrorDetails(400, 'WORKOUT_INVALID', { next_step: NEXT_INVALID }),
          details.pickErrorDetails(404, 'WORKOUT_NOT_FOUND', { next_step: NEXT_NOT_FOUND }),
        ];
      });
      expect(picked).toStrictEqual([{ next_step: NEXT_INVALID }, { next_step: NEXT_NOT_FOUND }]);
    });
  });
});
