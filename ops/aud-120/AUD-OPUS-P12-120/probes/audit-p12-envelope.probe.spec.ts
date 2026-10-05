/**
 * AUD-OPUS-P12-120 probe (backend, read-only evidence for mobile #355/#356). Never merge.
 *
 * The mobile builder depends on two 409 bodies carrying head_revision_index +
 * lock_token: the autosave bootstrap `autosave_lock_stale`
 * (workout-builder-autosave.service.ts:209-213) and the undo fence
 * `undo_head_moved` (:316-327). Every existing spec reads
 * exception.getResponse() directly; none runs the global HttpExceptionFilter
 * (main.ts:118). This probe sends the real service exception through the real
 * filter and checks what the app would receive.
 */
import { ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import {
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
  computeLockToken,
} from '../src/workout-builder/lock-token.helper';
import { AnalyticsService } from '../src/analytics/analytics.service';

function fake<T>(value: unknown): T {
  return value as T;
}

const PLAN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COACH_ID = 'coach-probe-1';

function throughFilter(exception: unknown, url: string) {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status(s: number) {
      status = s;
      return res;
    },
    json(b: Record<string, unknown>) {
      body = b;
      return res;
    },
  };
  const req = { method: 'POST', url, route: { path: url } };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  new HttpExceptionFilter().catch(exception, fake(host));
  // eslint-disable-next-line no-console
  console.log(`${url} -> ${status} ${JSON.stringify(body)}`);
  return { status, body };
}

describe('AUD-OPUS-P12-120: autosave/undo 409 bodies through HttpExceptionFilter', () => {
  const ORIGINAL_SECRET = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;
  beforeEach(() => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = 'mwb-probe-secret-aaaaaaaaaaaaaaaaaaaaaa';
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    else process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = ORIGINAL_SECRET;
    if (ORIGINAL_FLAG === undefined) delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    else process.env.FEATURE_MWB_AUTOSAVE_UNDO = ORIGINAL_FLAG;
  });

  function build(headIndex: number) {
    const tx = {
      $queryRaw: jest.fn(async () => [{ head_revision_id: 'head-rev', version: 7 }]),
      workoutPlanRevision: {
        findUnique: jest.fn(async (args: { where: { id?: string } }) =>
          args.where.id
            ? { revision_index: headIndex }
            : { exercises_json: [], plan_meta_json: { name: 'Day 1', type: 'strength' } },
        ),
        create: jest.fn(async () => ({ id: 'rev-new' })),
      },
      workoutPlan: { update: jest.fn(async () => ({})) },
      workoutPlanExercise: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ coach_id: null })) },
      workoutPlan: { findUnique: jest.fn(async () => ({ coach_id: COACH_ID })) },
      $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const service = new WorkoutBuilderAutosaveService(
      fake(prisma),
      fake(undefined),
      new AnalyticsService(),
      fake(undefined),
    );
    return { service };
  }

  it('undo_head_moved: the service exception carries head + token (control)', async () => {
    const { service } = build(5);
    const err = await service
      .applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 3, expected_head_index: 4 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ConflictException);
    expect(fake<ConflictException>(err).getResponse()).toMatchObject({
      head_revision_index: 5,
      lock_token: computeLockToken(PLAN_ID, 7, 'head-rev'),
    });
  });

  it('undo_head_moved: the HTTP body the app receives still carries head + token', async () => {
    const { service } = build(5);
    const err = await service
      .applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 3, expected_head_index: 4 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const { status, body } = throughFilter(err, `/workout-plans/${PLAN_ID}/undo`);
    expect(status).toBe(409);
    expect(body.code).toBe('undo_head_moved');
    expect(body.head_revision_index).toBe(5);
    expect(body.lock_token).toBe(computeLockToken(PLAN_ID, 7, 'head-rev'));
  });

  it('autosave_lock_stale (bootstrap): the HTTP body the app receives still carries head + token', () => {
    // Same constructor call as workout-builder-autosave.service.ts:209-213.
    const token = computeLockToken(PLAN_ID, 7, 'head-rev');
    const exception = new ConflictException({
      error: 'autosave_lock_stale',
      head_revision_index: 5,
      lock_token: token,
    });
    const { status, body } = throughFilter(exception, `/workout-plans/${PLAN_ID}/autosave`);
    expect(status).toBe(409);
    expect(body.error).toBe('autosave_lock_stale');
    expect(body.head_revision_index).toBe(5);
    expect(body.lock_token).toBe(token);
  });
});
