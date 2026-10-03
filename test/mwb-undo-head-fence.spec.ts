/**
 * S-MWB-3 (B-328-6, backend half): POST /workout-plans/:id/undo accepts an
 * optional `expected_head_index`. When the head has moved (for example the
 * first attempt of this same undo committed and its response was lost), the
 * undo is refused with a typed 409 `undo_head_moved` carrying the current head
 * and a fresh lock token, and NOTHING is written. Without the fence, or with a
 * matching fence, the undo applies as before.
 */
import { ConflictException } from '@nestjs/common';
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
const COACH_ID = 'coach-fence-1';

describe('MWB undo head fence (S-MWB-3 B-328-6)', () => {
  const ORIGINAL_SECRET = process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
  const ORIGINAL_FLAG = process.env.FEATURE_MWB_AUTOSAVE_UNDO;

  beforeEach(() => {
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = 'mwb-fence-secret-aaaaaaaaaaaaaaaaaaaaaa';
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
    return { service, tx };
  }

  it('refuses with undo_head_moved, the current head and a fresh token, and writes nothing', async () => {
    const { service, tx } = build(5);
    const err = await service
      .applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 3, expected_head_index: 4 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ConflictException);
    const body = fake<ConflictException>(err).getResponse();
    expect(body).toMatchObject({
      code: 'undo_head_moved',
      head_revision_index: 5,
      lock_token: computeLockToken(PLAN_ID, 7, 'head-rev'),
    });
    expect(tx.workoutPlanRevision.create).not.toHaveBeenCalled();
    expect(tx.workoutPlan.update).not.toHaveBeenCalled();
  });

  it('applies when the fence matches the head', async () => {
    const { service, tx } = build(4);
    const res = await service.applyUndo(
      PLAN_ID,
      { userId: COACH_ID },
      { to_revision_index: 3, expected_head_index: 4 },
    );
    expect(res.head_revision_index).toBe(5);
    expect(tx.workoutPlanRevision.create).toHaveBeenCalledTimes(1);
  });

  it('still applies without a fence (older clients)', async () => {
    const { service } = build(4);
    const res = await service.applyUndo(PLAN_ID, { userId: COACH_ID }, { to_revision_index: 3 });
    expect(res.head_revision_index).toBe(5);
  });
});
