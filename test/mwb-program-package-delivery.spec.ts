/**
 * S-MWB Programs — "Add to package": a `workout_program` content whose
 * asset_id is a master WorkoutProgram delivers the whole program through the
 * same fan-out that paid checkout, $0 invite grants and free-package claims
 * use (PurchaseFanoutService -> WorkoutAssetResolver).
 */
import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { PackageContentsService } from '../src/packages/package-contents.service';

/** Test seam: hand a hand-rolled fake to a constructor/method param of type T. */
function fake<T>(value: unknown): T {
  return value as T;
}

function scope() {
  return new ResolverSubCoachScope(
    fake({
      canAccessClient: jest.fn(async () => true),
      getHeadCoachIdForSubCoach: jest.fn(async () => null),
    }),
  );
}

function delivered(over: Record<string, unknown> = {}) {
  return {
    program_id: 'copy-1',
    assignment_ids: ['asg-1', 'asg-2'],
    first_assignment_id: 'asg-1',
    first_plan_id: 'plan-1',
    first_scheduled_for: 'x',
    last_scheduled_for: 'y',
    replayed: false,
    ...over,
  };
}

describe('WorkoutAssetResolver program delivery', () => {
  it('inline fan-out (tx present): delivers the program inside the purchase/grant transaction with the stable (purchase, content) key', async () => {
    const wb = { assignPlan: jest.fn() };
    const programDelivery = {
      findDeliverableMaster: jest.fn(async () => ({ id: 'master-1', name: 'Intro' })),
      deliverInTx: jest.fn(async () => delivered()),
      deliver: jest.fn(),
    };
    const resolver = new WorkoutAssetResolver(fake(wb), scope(), fake(programDelivery));
    const tx = { marker: 'outer-tx' };
    const before = Date.now();
    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'coach-1',
      assetId: 'master-1',
      scheduledDropId: 'drop-1',
      clientPurchaseId: 'purchase-1',
      contentId: 'content-1',
      tx: fake(tx),
    });
    expect(res.materialisedRef).toBe('asg-1');
    expect(programDelivery.findDeliverableMaster).toHaveBeenCalledWith('coach-1', 'master-1', tx);
    expect(programDelivery.deliverInTx).toHaveBeenCalledTimes(1);
    const [passedTx, input] = fake<[unknown, Record<string, unknown>]>(
      programDelivery.deliverInTx.mock.calls[0],
    );
    expect(passedTx).toBe(tx);
    expect(input).toMatchObject({
      masterProgramId: 'master-1',
      tenantCoachId: 'coach-1',
      clientId: 'client-1',
      deliveryKey: 'pkg:p=purchase-1:c=content-1',
      source: 'package',
    });
    expect((input.startAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(programDelivery.deliver).not.toHaveBeenCalled();
    expect(wb.assignPlan).not.toHaveBeenCalled();
  });

  it('cron re-send (no pair, no tx): opens its own transaction with a per-drop key', async () => {
    const programDelivery = {
      findDeliverableMaster: jest.fn(async () => ({ id: 'master-1', name: 'Intro' })),
      deliverInTx: jest.fn(),
      deliver: jest.fn(async () => delivered({ first_assignment_id: 'asg-9' })),
    };
    const resolver = new WorkoutAssetResolver(
      fake({ assignPlan: jest.fn() }),
      scope(),
      fake(programDelivery),
    );
    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'coach-1',
      assetId: 'master-1',
      scheduledDropId: 'drop-7',
    });
    expect(res.materialisedRef).toBe('asg-9');
    expect(programDelivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryKey: 'pkg:drop=drop-7' }),
    );
  });

  it('a legacy asset_id that is a WorkoutPlan keeps the single-plan assignPlan path', async () => {
    const wb = { assignPlan: jest.fn(async () => ({ id: 'assignment-123' })) };
    const programDelivery = {
      findDeliverableMaster: jest.fn(async () => null),
      deliverInTx: jest.fn(),
      deliver: jest.fn(),
    };
    const resolver = new WorkoutAssetResolver(fake(wb), scope(), fake(programDelivery));
    const res = await resolver.materialise({
      clientId: 'c',
      coachId: 'coach-1',
      assetId: 'plan-1',
      scheduledDropId: 'd',
    });
    expect(res.materialisedRef).toBe('assignment-123');
    expect(wb.assignPlan).toHaveBeenCalledTimes(1);
    expect(programDelivery.deliverInTx).not.toHaveBeenCalled();
  });

  it('a delivery failure propagates so the fan-out rolls back and the grant/purchase reports it (never a silent empty package)', async () => {
    const programDelivery = {
      findDeliverableMaster: jest.fn(async () => ({ id: 'master-1', name: 'Intro' })),
      deliverInTx: jest.fn(async () => {
        throw new Error('boom');
      }),
      deliver: jest.fn(),
    };
    const resolver = new WorkoutAssetResolver(
      fake({ assignPlan: jest.fn() }),
      scope(),
      fake(programDelivery),
    );
    await expect(
      resolver.materialise({
        clientId: 'c',
        coachId: 'coach-1',
        assetId: 'master-1',
        tx: fake({}),
      }),
    ).rejects.toThrow('boom');
  });
});

describe('PackageContentsService authoring check for workout_program', () => {
  function svcWith(prisma: Record<string, unknown>) {
    const svc = new PackageContentsService(
      fake(prisma),
      fake({}),
      fake({}),
      fake({ write: jest.fn() }),
    );
    const check = Reflect.get(svc, 'assertAssetOwnedByCoach') as (
      tenant: string,
      type: string,
      input: { asset_id: string },
    ) => Promise<void>;
    return (tenant: string, type: string, id: string) =>
      check.call(svc, tenant, type, { asset_id: id });
  }

  it('accepts a live master program of the tenant that has workouts', async () => {
    const prisma = {
      workoutProgram: {
        findFirst: jest.fn(async () => ({ id: 'master-1', archived_at: null, is_regime: false })),
      },
      workoutPlan: { count: jest.fn(async () => 3), findFirst: jest.fn() },
    };
    await expect(
      svcWith(prisma)('coach-1', 'workout_program', 'master-1'),
    ).resolves.toBeUndefined();
    expect(prisma.workoutProgram.findFirst).toHaveBeenCalledWith({
      where: { id: 'master-1', coach_id: 'coach-1', is_template: true },
      select: { id: true, archived_at: true, is_regime: true },
    });
    expect(prisma.workoutPlan.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an archived program (program_archived) and an empty one (program_empty)', async () => {
    const archived = {
      workoutProgram: {
        findFirst: jest.fn(async () => ({ id: 'm', archived_at: new Date(), is_regime: false })),
      },
      workoutPlan: { count: jest.fn(async () => 3), findFirst: jest.fn() },
    };
    await expect(svcWith(archived)('coach-1', 'workout_program', 'm')).rejects.toMatchObject({
      response: { code: 'program_archived' },
    });
    const empty = {
      workoutProgram: {
        findFirst: jest.fn(async () => ({ id: 'm', archived_at: null, is_regime: true })),
      },
      workoutPlan: { count: jest.fn(async () => 0), findFirst: jest.fn() },
    };
    await expect(svcWith(empty)('coach-1', 'workout_program', 'm')).rejects.toMatchObject({
      response: { code: 'program_empty' },
    });
  });

  it('a foreign or unknown id falls through to the legacy plan check (ASSET_NOT_FOUND)', async () => {
    const prisma = {
      workoutProgram: { findFirst: jest.fn(async () => null) },
      workoutPlan: { count: jest.fn(), findFirst: jest.fn(async () => null) },
    };
    await expect(svcWith(prisma)('coach-1', 'workout_program', 'x')).rejects.toMatchObject({
      response: { error: 'ASSET_NOT_FOUND' },
    });
  });
});
