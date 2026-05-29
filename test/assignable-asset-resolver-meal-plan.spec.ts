import { MealPlanAssetResolver } from '../src/packages/asset-resolvers/meal-plan.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { SubCoachOutOfScopeError } from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

function makeScope(allowed: boolean, isSub = false, headId: string | null = null) {
  return new ResolverSubCoachScope({
    canAccessClient: jest.fn(async () => allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () => (isSub ? headId : null)),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0]);
}

function makePrisma(existing: { id: string } | null = null) {
  return {
    dailyMealPlanAssignment: {
      findFirst: jest.fn(async () => existing),
    },
  } as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[1];
}

function makeMealPlansService() {
  return {
    assignPlan: jest.fn(async () => ({ id: 'mpa-789' })),
  } as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[0];
}

describe('MealPlanAssetResolver', () => {
  it('canHandle is narrow to meal_plan', () => {
    const resolver = new MealPlanAssetResolver(
      makeMealPlansService(),
      makePrisma(),
      makeScope(true),
    );
    expect(resolver.canHandle('meal_plan')).toBe(true);
    expect(resolver.canHandle('workout_plan')).toBe(false);
    expect(resolver.canHandle('pdf')).toBe(false);
  });

  it('delegates to RealMealPlansService.assignPlan with the head coach id, client, and YYYY-MM-DD starts_on', async () => {
    const svc = makeMealPlansService();
    const resolver = new MealPlanAssetResolver(
      svc,
      makePrisma(null),
      makeScope(true, true, 'head-77'),
    );

    const res = await resolver.materialise({
      clientId: 'client-1',
      coachId: 'sub-coach-1',
      assetId: 'dmp-42',
    });

    expect(res.materialisedRef).toBe('mpa-789');
    expect((svc as unknown as { assignPlan: jest.Mock }).assignPlan).toHaveBeenCalledTimes(1);
    const call = (svc as unknown as { assignPlan: jest.Mock }).assignPlan.mock.calls[0];
    expect(call[0]).toBe('head-77'); // head coach id, not sub-coach id
    expect(call[1]).toBe('dmp-42');
    expect(call[2].client_id).toBe('client-1');
    expect(call[2].starts_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('idempotency: returns the existing assignment id WITHOUT calling assignPlan when one already exists', async () => {
    const svc = makeMealPlansService();
    const prisma = makePrisma({ id: 'existing-mpa' });
    const resolver = new MealPlanAssetResolver(svc, prisma, makeScope(true));

    const res = await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-1',
    });

    expect(res.materialisedRef).toBe('existing-mpa');
    expect((svc as unknown as { assignPlan: jest.Mock }).assignPlan).not.toHaveBeenCalled();
    expect(
      (prisma as unknown as { dailyMealPlanAssignment: { findFirst: jest.Mock } })
        .dailyMealPlanAssignment.findFirst,
    ).toHaveBeenCalledWith({
      where: { client_id: 'c1', daily_meal_plan_id: 'dmp-1' },
      select: { id: true },
      orderBy: { starts_on: 'desc' },
    });
  });

  it('honours ambient tx for the existence-check probe', async () => {
    const svc = makeMealPlansService();
    const txFindFirst = jest.fn(async () => null);
    const tx = {
      dailyMealPlanAssignment: { findFirst: txFindFirst },
    } as unknown as Parameters<MealPlanAssetResolver['materialise']>[0]['tx'];
    // PrismaService probe must NOT be called when tx is provided.
    const prismaFindFirst = jest.fn(async () => ({ id: 'should-not-be-used' }));
    const prisma = {
      dailyMealPlanAssignment: { findFirst: prismaFindFirst },
    } as unknown as ConstructorParameters<typeof MealPlanAssetResolver>[1];

    const resolver = new MealPlanAssetResolver(svc, prisma, makeScope(true));
    await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'dmp-2',
      tx,
    });
    expect(txFindFirst).toHaveBeenCalledTimes(1);
    expect(prismaFindFirst).not.toHaveBeenCalled();
  });

  it('refuses out-of-scope sub-coaches before any DB call', async () => {
    const svc = makeMealPlansService();
    const prisma = makePrisma();
    const resolver = new MealPlanAssetResolver(svc, prisma, makeScope(false));
    await expect(
      resolver.materialise({
        clientId: 'c1',
        coachId: 'sub-1',
        assetId: 'dmp-3',
      }),
    ).rejects.toThrow(SubCoachOutOfScopeError);
    expect(
      (prisma as unknown as { dailyMealPlanAssignment: { findFirst: jest.Mock } })
        .dailyMealPlanAssignment.findFirst,
    ).not.toHaveBeenCalled();
    expect((svc as unknown as { assignPlan: jest.Mock }).assignPlan).not.toHaveBeenCalled();
  });
});
