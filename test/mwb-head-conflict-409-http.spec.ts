/**
 * B-MWB409 — the workout-builder autosave and undo 409 answers over real HTTP:
 * the real WorkoutBuilderAutosaveController, the real
 * WorkoutBuilderAutosaveService on an in-memory Prisma double, the real
 * feature guard and RolesGuard, and the real global HttpExceptionFilter.
 *
 * Before this fix the filter sent only the fixed envelope, so the app never
 * received the head index and fresh lock token of `autosave_lock_stale` (the
 * first save of every editing session), `autosave_conflict_retry` or
 * `undo_head_moved`. Autosave never completed and Undo reported "nothing was
 * undone" even when it had worked. Those two fields now pass for exactly these
 * three codes, with a checked shape; every other field and every other error
 * is still reduced to the envelope.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  ConflictException,
  Controller,
  type ExecutionContext,
  type INestApplication,
  InternalServerErrorException,
  Param,
  Post,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { WorkoutBuilderAutosaveController } from '../src/workout-builder/workout-builder-autosave.controller';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import {
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
  computeLockToken,
} from '../src/workout-builder/lock-token.helper';

function fake<T>(value: unknown): T {
  return value as T;
}

const PLAN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COACH_ID = 'coach-mwb409-1';
const H_USER = 'x-test-user';
const HEAD = 5;
const VERSION = 7;
const HEAD_REV = 'head-rev';
/** What the app sends before it knows the token (mobile #355 bootstrap). */
const PLACEHOLDER_TOKEN = '0000000000000000';
const ENVELOPE = ['code', 'error', 'message', 'path', 'statusCode', 'timestamp'];

class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: 'coach' };
    return true;
  }
}

/**
 * Exceptions shaped like the head conflicts but NOT allowed through: another
 * code, the pre-fix body without `code`, the right code with wrong shapes and
 * internal fields, and a 5xx.
 */
const GOOD_TOKEN = 'abcdef0123456789';
const CRAFTED: Readonly<Record<string, () => Error>> = {
  other_code: () =>
    new ConflictException({
      code: 'program_name_taken',
      error: 'program_name_taken',
      head_revision_index: 5,
      lock_token: GOOD_TOKEN,
    }),
  no_code: () =>
    new ConflictException({
      error: 'autosave_lock_stale',
      head_revision_index: 5,
      lock_token: GOOD_TOKEN,
    }),
  bad_shapes: () =>
    new ConflictException({
      code: 'undo_head_moved',
      error: 'undo_head_moved',
      head_revision_index: -1,
      lock_token: 'ABCDEF0123456789',
      plan_id: PLAN_ID,
      version: 7,
      head_revision_id: HEAD_REV,
      statusCode: 200,
    }),
  bad_index_type: () =>
    new ConflictException({
      code: 'autosave_conflict_retry',
      error: 'autosave_conflict_retry',
      head_revision_index: '5',
      lock_token: `${GOOD_TOKEN}00`,
    }),
  server_error: () =>
    new InternalServerErrorException({
      code: 'autosave_lock_stale',
      error: 'autosave_lock_stale',
      head_revision_index: 5,
      lock_token: GOOD_TOKEN,
    }),
};

@Controller('mwb409-crafted')
class CraftedErrorController {
  @Post(':kind')
  raise(@Param('kind') kind: string): never {
    throw CRAFTED[kind]();
  }
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

describe('B-MWB409: autosave/undo 409 bodies through the real filter over HTTP', () => {
  const ORIGINAL_SECRET = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  let app: INestApplication;
  let baseUrl: string;

  function makeDoubles(opts: { transactionError?: Error } = {}) {
    const plan = {
      name: 'Day 1',
      type: 'strength',
      duration_estimate_minutes: null,
      week_index: 0,
      day_index: 0,
    };
    const tx = {
      $queryRaw: jest.fn(async () => [{ head_revision_id: HEAD_REV, version: VERSION }]),
      workoutPlanRevision: {
        findUnique: jest.fn(async (args: { where: { id?: string } }) =>
          args.where.id
            ? { revision_index: HEAD }
            : { exercises_json: [], plan_meta_json: { name: 'Day 1', type: 'strength' } },
        ),
        create: jest.fn(async () => ({
          id: 'rev-new',
          created_at: new Date('2026-10-05T12:00:00.000Z'),
        })),
      },
      workoutPlan: {
        update: jest.fn(async () => plan),
        findUniqueOrThrow: jest.fn(async () => plan),
      },
      workoutPlanExercise: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ coach_id: null })) },
      workoutPlan: { findUnique: jest.fn(async () => ({ coach_id: COACH_ID, program_id: null })) },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => {
        if (opts.transactionError) throw opts.transactionError;
        return cb(tx);
      }),
    };
    return { tx, prisma };
  }

  async function boot(opts: { transactionError?: Error } = {}) {
    const { tx, prisma } = makeDoubles(opts);
    const service = new WorkoutBuilderAutosaveService(
      fake(prisma),
      fake(undefined),
      new AnalyticsService(),
      fake(undefined),
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkoutBuilderAutosaveController, CraftedErrorController],
      providers: [{ provide: WorkoutBuilderAutosaveService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const addr = fake<AddressInfo>(app.getHttpServer().address());
    baseUrl = `http://127.0.0.1:${addr.port}`;
    return { tx };
  }

  function call(method: 'PATCH' | 'POST', path: string, body: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            [H_USER]: COACH_ID,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  const autosavePath = `/workout-plans/${PLAN_ID}/autosave`;
  const undoPath = `/workout-plans/${PLAN_ID}/undo`;
  const rename = { op: 'plan_meta', meta: { name: 'Day 1 Push' } };
  const token = () => computeLockToken(PLAN_ID, VERSION, HEAD_REV);

  beforeEach(() => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = 'mwb409-secret-aaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  });
  afterEach(async () => {
    await app?.close();
    if (ORIGINAL_SECRET === undefined) delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    else process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = ORIGINAL_SECRET;
    if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL_FLAG;
  });

  describe('the three head conflicts carry head_revision_index and lock_token', () => {
    it('autosave_lock_stale: the first save of a session gets the head and token, then saves', async () => {
      const { tx } = await boot();
      const first = await call('PATCH', autosavePath, {
        base_revision_index: 0,
        lock_token: PLACEHOLDER_TOKEN,
        ops: [rename],
        cause: 'autosave',
      });
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({
        statusCode: 409,
        code: 'autosave_lock_stale',
        error: 'autosave_lock_stale',
        head_revision_index: HEAD,
        lock_token: token(),
        path: autosavePath,
      });
      expect(Object.keys(first.body).sort()).toEqual(
        [...ENVELOPE, 'head_revision_index', 'lock_token'].sort(),
      );
      expect(tx.workoutPlanRevision.create).not.toHaveBeenCalled();

      // The app adopts the head and token from the 409 and retries once.
      const second = await call('PATCH', autosavePath, {
        base_revision_index: first.body.head_revision_index,
        lock_token: first.body.lock_token,
        ops: [rename],
        cause: 'autosave',
      });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ head_revision_index: HEAD + 1 });
      expect(tx.workoutPlanRevision.create).toHaveBeenCalledTimes(1);
    });

    it('autosave_conflict_retry: a stale base index gets the head and token', async () => {
      const { tx } = await boot();
      const r = await call('PATCH', autosavePath, {
        base_revision_index: HEAD - 2,
        lock_token: token(),
        ops: [rename],
        cause: 'autosave',
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        statusCode: 409,
        code: 'autosave_conflict_retry',
        error: 'autosave_conflict_retry',
        head_revision_index: HEAD,
        lock_token: token(),
      });
      expect(Object.keys(r.body).sort()).toEqual(
        [...ENVELOPE, 'head_revision_index', 'lock_token'].sort(),
      );
      expect(tx.workoutPlanRevision.create).not.toHaveBeenCalled();
    });

    it('undo_head_moved: a fenced undo on a moved head gets the head, token and copy', async () => {
      const { tx } = await boot();
      const r = await call('POST', undoPath, {
        to_revision_index: 3,
        expected_head_index: HEAD - 1,
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({
        statusCode: 409,
        code: 'undo_head_moved',
        error: 'undo_head_moved',
        message:
          'This workout changed after the undo was requested. Showing the latest saved version.',
        head_revision_index: HEAD,
        lock_token: token(),
        path: undoPath,
      });
      expect(Object.keys(r.body).sort()).toEqual(
        [...ENVELOPE, 'head_revision_index', 'lock_token'].sort(),
      );
      expect(tx.workoutPlanRevision.create).not.toHaveBeenCalled();
    });
  });

  describe('every other error still carries only the envelope', () => {
    it('a serialization conflict (P2034) is a plain 409 with no head or token', async () => {
      await boot({
        transactionError: new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      });
      const r = await call('PATCH', autosavePath, {
        base_revision_index: HEAD,
        lock_token: token(),
        ops: [rename],
        cause: 'autosave',
      });
      expect(r.status).toBe(409);
      expect(r.body.message).toBe('autosave_conflict_retry');
      expect(r.body).not.toHaveProperty('head_revision_index');
      expect(r.body).not.toHaveProperty('lock_token');
      expect(r.body).not.toHaveProperty('code');
    });

    it.each([
      ['other_code', 409],
      ['no_code', 409],
      ['server_error', 500],
    ])('%s: head and token are dropped', async (kind, status) => {
      await boot();
      const r = await call('POST', `/mwb409-crafted/${kind}`, {});
      expect(r.status).toBe(status);
      expect(r.body).not.toHaveProperty('head_revision_index');
      expect(r.body).not.toHaveProperty('lock_token');
      expect(Object.keys(r.body).every((k) => [...ENVELOPE, 'request_id'].includes(k))).toBe(true);
    });

    it('a listed code with wrong shapes or internal fields passes none of them', async () => {
      await boot();
      for (const kind of ['bad_shapes', 'bad_index_type']) {
        const r = await call('POST', `/mwb409-crafted/${kind}`, {});
        expect(r.status).toBe(409);
        expect(r.body.statusCode).toBe(409);
        for (const field of [
          'head_revision_index',
          'lock_token',
          'plan_id',
          'version',
          'head_revision_id',
        ]) {
          expect(r.body).not.toHaveProperty(field);
        }
      }
    });
  });
});
