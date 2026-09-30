import { Prisma } from '@prisma/client';
import {
  DripAssignmentConflictWithoutWinnerError,
  MealPlanAssetResolver,
} from '../src/packages/asset-resolvers/meal-plan.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import {
  MealPlanNotFoundError,
  SubCoachOutOfScopeError,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

function makeScope(allowed: boolean, isSub = false, headId: string | null = null) {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => allowed),
    // D8 round 3: the meal-plan resolver resolves scope INSIDE its write
    // transaction via the locking variant.
    canAccessClientLocked: jest.fn(async () => allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () => (isSub ? headId : null)),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0]);
}

interface PrismaStubOpts {
  plan?: { id: string } | null;
  priorByDrop?: { id: string } | null;
  // The fallback "latest assignment" probe used by the back-compat (no-drop) path.
  latestForPair?: { id: string } | null;
  // Create result OR an error to throw (back-compat path only: the drip path no longer calls create).
  createResult?: { id: string };
  createError?: unknown;
  // S4B-01: the drip path INSERTs through `$queryRaw` with ON CONFLICT ("drip_drop_id") DO NOTHING
  // RETURNING "id" — one row for the winner, NO row for the loser. `undefined` = winner with the
  // createResult id; `[]` = loser (conflict, nothing inserted).
  dripInsertRows?: Array<{ id: string }>;
  dripInsertError?: unknown;
  // Optional override for the post-conflict winner re-read.
  winnerAfterConflict?: { id: string } | null;
}

/** The raw drip INSERT's parameter values (Prisma.Sql.values), in column order. */
function dripInsertValues(queryRaw: jest.Mock, nth = 0): unknown[] {
  const sql = queryRaw.mock.calls[nth][0] as Prisma.Sql;
  // A tagged `Prisma.sql` template: parameterised text + values (never string-interpolated).
  expect(typeof sql.sql).toBe('string');
  expect(Array.isArray(sql.values)).toBe(true);
  return sql.values;
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
    return opts.winnerAfterConflict ?? null;
  });
  const findFirst = jest.fn(async () => opts.latestForPair ?? null);
  const create = opts.createError
    ? jest.fn(async (_args: unknown) => {
        throw opts.createError;
      })
    : jest.fn(async (_args: unknown) => opts.createResult ?? { id: 'mpa-new' });
  const planFindFirst = jest.fn(async (_args: unknown) => opts.plan ?? null);
  const queryRaw = opts.dripInsertError
    ? jest.fn(async (_sql: unknown) => {
        throw opts.dripInsertError;
      })
    : jest.fn(async (_sql: unknown) => opts.dripInsertRows ?? [opts.createResult ?? { id: 'mpa-new' }]);
  const stub: any = {
    $queryRaw: queryRaw,
    dailyMealPlan: { findFirst: planFindFirst },
    dailyMealPlanAssignment: {
      findUnique,
      findFirst,
      create,
    },
    __mocks: { findFirst, create, planFindFirst, queryRaw },
  };
  // D8 round 3 (R593-c7A2-01): without an input.tx the resolver opens its own
  // transaction so the scope check is atomic with the INSERT.
  stub.$transaction = jest.fn(async (fn: (tx: any) => unknown) => fn(stub));
  return stub;
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
    // S4B-01: the drip INSERT is the conflict-safe raw statement, never `create`.
    expect(stub.__mocks.create).not.toHaveBeenCalled();
    expect(stub.__mocks.queryRaw).toHaveBeenCalledTimes(1);
    const sql = stub.__mocks.queryRaw.mock.calls[0][0] as Prisma.Sql;
    const text = sql.sql.replace(/\s+/g, ' ');
    expect(text).toContain('INSERT INTO "DailyMealPlanAssignment"');
    expect(text).toContain('ON CONFLICT ("drip_drop_id") DO NOTHING');
    expect(text).toContain('RETURNING "id"');
    const [id, planId, clientId, coachId, startsOn, dropId] = dripInsertValues(stub.__mocks.queryRaw);
    expect(typeof id).toBe('string');
    expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
    expect([planId, clientId, coachId, dropId]).toEqual(['dmp-42', 'client-1', 'head-77', 'drop-99']);
    expect(startsOn).toBeInstanceOf(Date);
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
    expect(stub.__mocks.queryRaw).not.toHaveBeenCalled();
    expect(stub.__mocks.planFindFirst).not.toHaveBeenCalled();
  });

  it('drip path: race recovery — ON CONFLICT DO NOTHING returns no row, loser re-reads winner by drip_drop_id in the same transaction and returns its id', async () => {
    // P1 audit fix: two concurrent materialise calls for the same drop must
    // result in EXACTLY ONE assignment row. The first call's INSERT wins;
    // the second's INSERT hits the UNIQUE(drip_drop_id) — ON CONFLICT DO
    // NOTHING yields zero rows WITHOUT aborting the transaction (S4B-01) —
    // and falls through to a re-read by drop id.
    const stub = makePrismaStub({
      plan: { id: 'dmp-42' },
      priorByDrop: null,
      dripInsertRows: [],
      winnerAfterConflict: { id: 'mpa-winner' },
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
    expect(stub.__mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(stub.__mocks.create).not.toHaveBeenCalled();
    // Two findUnique calls: prior probe (null) + post-conflict winner re-read.
    expect(stub.dailyMealPlanAssignment.findUnique).toHaveBeenCalledTimes(2);
    const winnerLookup = stub.dailyMealPlanAssignment.findUnique.mock.calls[1][0];
    expect(winnerLookup).toEqual({
      where: { drip_drop_id: 'drop-race' },
      select: { id: true },
    });
  });

  it('drip path: simulating two concurrent retries of the same drop yields exactly ONE inserted row (winner) and one empty ON CONFLICT result (loser) that converges on the winner id', async () => {
    // Concurrency simulation over a single shared "DB" that tracks which
    // INSERT wins on drip_drop_id. The losing call's ON CONFLICT INSERT
    // returns no row and it recovers via findUnique. Both calls return the
    // SAME materialisedRef. (The REAL two-connection proof on PostgreSQL —
    // where a unique violation would abort the transaction — is the live
    // cell in test/rls-d8-service-role-assignment-writers.spec.ts, S4B-01.)
    const winnerId = 'mpa-only-one';
    const dropId = 'drop-shared';
    let inserted: string | null = null;
    const shared: any = {
      // D8 round 3: no input.tx → the resolver opens its own transaction.
      $transaction: async (fn: (tx: any) => unknown) => fn(shared),
      $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
        const drop = sql.values[5] as string;
        if (inserted === drop) return []; // ON CONFLICT DO NOTHING: no row, no error
        inserted = drop;
        return [{ id: winnerId }];
      }),
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
        create: jest.fn(async () => {
          throw new Error('drip path must not call create (S4B-01)');
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
    // Two INSERT attempts, exactly one inserted a row; `create` never used.
    expect(shared.$queryRaw).toHaveBeenCalledTimes(2);
    expect(shared.dailyMealPlanAssignment.create).not.toHaveBeenCalled();
    expect(inserted).toBe(dropId);
  });

  it('drip path: conflict with NO winner row visible afterwards (DELETE raced the INSERT) throws DripAssignmentConflictWithoutWinnerError instead of retrying silently', async () => {
    const stub = makePrismaStub({
      plan: { id: 'dmp-42' },
      priorByDrop: null,
      dripInsertRows: [],
      winnerAfterConflict: null,
    });
    const resolver = new MealPlanAssetResolver(
      stub as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0],
      makeScope(true),
    );
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'coach1',
        assetId: 'dmp-42',
        scheduledDropId: 'drop-gone',
      }),
    ).rejects.toThrow(DripAssignmentConflictWithoutWinnerError);
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
    expect(stub.__mocks.queryRaw).not.toHaveBeenCalled();
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
    expect(tx.__mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.__mocks.queryRaw).not.toHaveBeenCalled();
    expect(prisma.__mocks.create).not.toHaveBeenCalled();
    expect(prisma.__mocks.planFindFirst).not.toHaveBeenCalled();
    expect(prisma.dailyMealPlanAssignment.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
