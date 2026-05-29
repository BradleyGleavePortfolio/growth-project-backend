import { Prisma } from '@prisma/client';
import { MealPlanAssetResolver } from '../src/packages/asset-resolvers/meal-plan.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import {
  MealPlanNotFoundError,
  SubCoachOutOfScopeError,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

function makeScope(allowed: boolean, isSub = false, headId: string | null = null) {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () => (isSub ? headId : null)),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0]);
}

interface PrismaStubOpts {
  plan?: { id: string } | null;
  priorByDrop?: { id: string } | null;
  // The fallback "latest assignment" probe used by the back-compat (no-drop) path.
  latestForPair?: { id: string } | null;
  // Create result OR an error to throw (e.g. P2002).
  createResult?: { id: string };
  createError?: unknown;
  // Optional override for the post-P2002 winner re-read.
  winnerAfterP2002?: { id: string } | null;
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function makePrismaStub(opts: PrismaStubOpts) {
  // findUnique handles BOTH paths (prior probe + post-P2002 winner re-read);
  // both are keyed by drip_drop_id so a single shared response is fine for
  // the back-compat and missing-prior cases. The P2002 race test overrides
  // by call ordering.
  let nthCall = 0;
  const findUnique = jest.fn(async (_args: unknown) => {
    nthCall += 1;
    if (nthCall === 1) return opts.priorByDrop ?? null;
    return opts.winnerAfterP2002 ?? null;
  });
  const findFirst = jest.fn(async () => opts.latestForPair ?? null);
  const create = opts.createError
    ? jest.fn(async (_args: unknown) => {
        throw opts.createError;
      })
    : jest.fn(async (_args: unknown) => opts.createResult ?? { id: 'mpa-new' });
  const planFindFirst = jest.fn(async (_args: unknown) => opts.plan ?? null);
  return {
    dailyMealPlan: { findFirst: planFindFirst },
    dailyMealPlanAssignment: {
      findUnique,
      findFirst,
      create,
    },
    __mocks: { findFirst, create, planFindFirst },
  };
}

describe('MealPlanAssetResolver', () => {
  it('canHandle is narrow to meal_plan', () => {
    const stub = makePrismaStub({});
    const r = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    expect(r.canHandle('meal_plan')).toBe(true);
    expect(r.canHandle('workout_plan')).toBe(false);
    expect(r.canHandle('pdf')).toBe(false);
  });

  it('drip path: writes drip_drop_id and the head coach id as assigned_by_coach_id', async () => {
    const stub = makePrismaStub({
      plan: { id: 'dmp-42' },
      createResult: { id: 'mpa-new' },
    });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true, true, 'head-77'),
    );

    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'sub-coach-1',
      assetId: 'dmp-42',
      scheduledDropId: 'drop-99',
    });

    expect(res.materialisedRef).toBe('mpa-new');
    expect(stub.__mocks.planFindFirst).toHaveBeenCalledWith({
      where: { id: 'dmp-42', coach_id: 'head-77', archived_at: null },
      select: { id: true },
    });
    const created = stub.__mocks.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      daily_meal_plan_id: 'dmp-42',
      client_id: 'client-1',
      assigned_by_coach_id: 'head-77',
      drip_drop_id: 'drop-99',
    });
    expect(created.data.starts_on).toBeInstanceOf(Date);
  });

  it('drip path: prior fire short-circuit returns existing id WITHOUT plan check or INSERT', async () => {
    const stub = makePrismaStub({
      priorByDrop: { id: 'mpa-prior' },
      // create / planFindFirst would throw if invoked.
      createError: new Error('should not insert'),
    });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-1',
      scheduledDropId: 'drop-1',
    });
    expect(res.materialisedRef).toBe('mpa-prior');
    expect(stub.__mocks.create).not.toHaveBeenCalled();
    expect(stub.__mocks.planFindFirst).not.toHaveBeenCalled();
  });

  it('drip path: P2002 race recovery — loser re-reads winner by drip_drop_id and returns its id', async () => {
    // P1 audit fix: two concurrent materialise calls for the same drop must
    // result in EXACTLY ONE assignment row. The first call's INSERT wins;
    // the second's INSERT trips the new UNIQUE(drip_drop_id) and falls
    // through to a re-read by drop id.
    const stub = makePrismaStub({
      plan: { id: 'dmp-42' },
      priorByDrop: null,
      createError: p2002(),
      winnerAfterP2002: { id: 'mpa-winner' },
    });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );

    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-42',
      scheduledDropId: 'drop-race',
    });

    expect(res.materialisedRef).toBe('mpa-winner');
    expect(stub.__mocks.create).toHaveBeenCalledTimes(1);
    // Two findUnique calls: prior probe (null) + post-P2002 winner re-read.
    expect(stub.dailyMealPlanAssignment.findUnique).toHaveBeenCalledTimes(2);
    const winnerLookup = stub.dailyMealPlanAssignment.findUnique.mock.calls[1][0];
    expect(winnerLookup).toEqual({
      where: { drip_drop_id: 'drop-race' },
      select: { id: true },
    });
  });

  it('drip path: simulating two concurrent retries of the same drop yields exactly ONE create attempt that succeeds and one P2002 recovery', async () => {
    // End-to-end concurrency simulation: a single shared "DB" tracks which
    // INSERT wins on drip_drop_id. The losing call gets P2002 from
    // create() and recovers via findUnique. Both calls return the SAME
    // materialisedRef — exactly the property the audit asked us to prove.
    const winnerId = 'mpa-only-one';
    const dropId = 'drop-shared';
    let inserted: string | null = null;
    const shared = {
      dailyMealPlan: {
        findFirst: jest.fn(async () => ({ id: 'dmp-1' })),
      },
      dailyMealPlanAssignment: {
        findUnique: jest.fn(async (args: { where: { drip_drop_id: string } }) => {
          if (args.where.drip_drop_id === dropId && inserted) {
            return { id: winnerId };
          }
          return null;
        }),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (args: { data: { drip_drop_id: string } }) => {
          if (inserted === args.data.drip_drop_id) {
            throw p2002();
          }
          inserted = args.data.drip_drop_id;
          return { id: winnerId };
        }),
      },
    };
    const resolver = new MealPlanAssetResolver(
      shared as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );

    const both = await Promise.all([
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach1',
        assetId: 'dmp-1',
        scheduledDropId: dropId,
      }),
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach1',
        assetId: 'dmp-1',
        scheduledDropId: dropId,
      }),
    ]);
    expect(both[0].materialisedRef).toBe(winnerId);
    expect(both[1].materialisedRef).toBe(winnerId);
    // Exactly one INSERT attempt succeeded.
    expect(shared.dailyMealPlanAssignment.create).toHaveBeenCalledTimes(2);
    expect(inserted).toBe(dropId);
  });

  it('drip path: missing / archived / cross-tenant plan throws MealPlanNotFoundError before INSERT', async () => {
    const stub = makePrismaStub({ plan: null });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach1',
        assetId: 'dmp-archived',
        scheduledDropId: 'drop-1',
      }),
    ).rejects.toThrow(MealPlanNotFoundError);
    expect(stub.__mocks.create).not.toHaveBeenCalled();
  });

  it('drip path: honours ambient tx for ALL reads + writes (PrismaService is NEVER touched)', async () => {
    const tx = makePrismaStub({
      plan: { id: 'dmp-1' },
      createResult: { id: 'mpa-tx' },
    });
    const prisma = makePrismaStub({
      plan: { id: 'dmp-1' },
      createResult: { id: 'should-not-be-used' },
    });
    const resolver = new MealPlanAssetResolver(
      prisma as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-1',
      scheduledDropId: 'drop-tx',
      tx: tx as unknown as Parameters<MealPlanAssetResolver['materialise']>[0]['tx'],
    });
    expect(res.materialisedRef).toBe('mpa-tx');
    expect(tx.__mocks.create).toHaveBeenCalledTimes(1);
    expect(prisma.__mocks.create).not.toHaveBeenCalled();
    expect(prisma.__mocks.planFindFirst).not.toHaveBeenCalled();
    expect(prisma.dailyMealPlanAssignment.findUnique).not.toHaveBeenCalled();
  });

  it('back-compat (no scheduledDropId): returns latest existing assignment without inserting', async () => {
    const stub = makePrismaStub({ latestForPair: { id: 'mpa-existing' } });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-1',
    });
    expect(res.materialisedRef).toBe('mpa-existing');
    expect(stub.__mocks.create).not.toHaveBeenCalled();
    expect(stub.__mocks.findFirst).toHaveBeenCalledWith({
      where: { client_id: 'c1', daily_meal_plan_id: 'dmp-1' },
      select: { id: true },
      orderBy: { starts_on: 'desc' },
    });
  });

  it('back-compat (no scheduledDropId): inserts when no existing assignment, NOT setting drip_drop_id', async () => {
    const stub = makePrismaStub({
      plan: { id: 'dmp-1' },
      latestForPair: null,
      createResult: { id: 'mpa-fresh' },
    });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-1',
    });
    expect(res.materialisedRef).toBe('mpa-fresh');
    const data = (stub.__mocks.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.drip_drop_id).toBeUndefined();
  });

  it('refuses out-of-scope sub-coaches before any DB call', async () => {
    const stub = makePrismaStub({});
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(false),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'sub-1',
        assetId: 'dmp-3',
        scheduledDropId: 'drop-1',
      }),
    ).rejects.toThrow(SubCoachOutOfScopeError);
    expect(stub.__mocks.planFindFirst).not.toHaveBeenCalled();
    expect(stub.__mocks.create).not.toHaveBeenCalled();
  });
});
