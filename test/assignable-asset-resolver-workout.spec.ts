import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { SubCoachOutOfScopeError } from '../src/packages/asset-resolvers/assignable-asset-resolver.errors';

// PR-7 — WorkoutAssetResolver delegates to WorkoutBuilderService.assignPlan
// (the same service the coach-facing assign-workout endpoint uses) so the
// resolver does not duplicate assignment SQL. The tests therefore focus on
// the seams the resolver introduces: sub-coach scoping, tenant id rewrite,
// deterministic idempotency key, and asset_type fan-out (workout_program +
// workout_plan both route here).

function makeSubCoachScope(opts: {
  allowed: boolean;
  isSub: boolean;
  headId?: string | null;
}) {
  return {
    canAccessClient: jest.fn(async () => opts.allowed),
    getHeadCoachIdForSubCoach: jest.fn(async () =>
      opts.isSub ? opts.headId ?? null : null,
    ),
  } as unknown as ConstructorParameters<typeof ResolverSubCoachScope>[0];
}

function makeWorkoutBuilder() {
  return {
    assignPlan: jest.fn(async () => ({ id: 'assignment-123' })),
  } as unknown as ConstructorParameters<typeof WorkoutAssetResolver>[0];
}

describe('WorkoutAssetResolver', () => {
  it('canHandle covers both workout_plan and workout_program', () => {
    const resolver = new WorkoutAssetResolver(
      makeWorkoutBuilder(),
      new ResolverSubCoachScope(makeSubCoachScope({ allowed: true, isSub: false })),
    );
    expect(resolver.canHandle('workout_plan')).toBe(true);
    expect(resolver.canHandle('workout_program')).toBe(true);
    expect(resolver.canHandle('meal_plan')).toBe(false);
    expect(resolver.canHandle('pdf')).toBe(false);
  });

  it('delegates to WorkoutBuilderService.assignPlan with the head coach id, client, plan, ISO scheduled_for, and a deterministic idempotency key', async () => {
    const wb = makeWorkoutBuilder();
    const scope = new ResolverSubCoachScope(
      makeSubCoachScope({ allowed: true, isSub: false }),
    );
    const resolver = new WorkoutAssetResolver(wb, scope);

    const before = Date.now();
    const res = await resolver.materialise({
      clientId: 'client-abc',
      coachId: 'coach-1',
      assetId: 'plan-xyz',
      scheduledDropId: 'drop-9',
    });
    const after = Date.now();

    expect(res.materialisedRef).toBe('assignment-123');
    expect((wb as unknown as { assignPlan: jest.Mock }).assignPlan).toHaveBeenCalledTimes(1);
    const call = (wb as unknown as { assignPlan: jest.Mock }).assignPlan.mock.calls[0];
    expect(call[0]).toBe('coach-1'); // head coach id (caller is head)
    expect(call[1]).toBe('plan-xyz');
    expect(call[2].client_id).toBe('client-abc');
    const scheduledMs = new Date(call[2].scheduled_for).getTime();
    expect(scheduledMs).toBeGreaterThanOrEqual(before);
    expect(scheduledMs).toBeLessThanOrEqual(after);
    // Idempotency key derived from (client, asset, drop) so a retry of the
    // SAME drop collapses to one assignment in the ledger.
    expect(call[3]).toBe('drip:workout:client-abc:plan-xyz:drop-9');
  });

  it('respects sub-coach scope: head-coach id (not raw User.coach_id) is passed as tenant owner', async () => {
    const wb = makeWorkoutBuilder();
    const subScope = makeSubCoachScope({
      allowed: true,
      isSub: true,
      headId: 'head-coach-42',
    });
    const resolver = new WorkoutAssetResolver(
      wb,
      new ResolverSubCoachScope(subScope),
    );

    await resolver.materialise({
      clientId: 'c1',
      coachId: 'sub-coach-1',
      assetId: 'plan-1',
    });

    expect((subScope as unknown as { canAccessClient: jest.Mock }).canAccessClient).toHaveBeenCalledWith(
      'sub-coach-1',
      'c1',
    );
    expect((subScope as unknown as { getHeadCoachIdForSubCoach: jest.Mock }).getHeadCoachIdForSubCoach).toHaveBeenCalledWith(
      'sub-coach-1',
    );
    const tenantArg = (wb as unknown as { assignPlan: jest.Mock }).assignPlan.mock.calls[0][0];
    expect(tenantArg).toBe('head-coach-42');
  });

  it('refuses with SubCoachOutOfScopeError when the sub-coach cannot access the client (delegate is NEVER called)', async () => {
    const wb = makeWorkoutBuilder();
    const subScope = makeSubCoachScope({ allowed: false, isSub: true });
    const resolver = new WorkoutAssetResolver(
      wb,
      new ResolverSubCoachScope(subScope),
    );

    await expect(
      resolver.materialise({
        clientId: 'c-out-of-scope',
        coachId: 'sub-coach-1',
        assetId: 'plan-1',
      }),
    ).rejects.toThrow(SubCoachOutOfScopeError);
    expect((wb as unknown as { assignPlan: jest.Mock }).assignPlan).not.toHaveBeenCalled();
  });

  it('drops without a scheduledDropId still get a stable idempotency key (no-drop segment)', async () => {
    const wb = makeWorkoutBuilder();
    const resolver = new WorkoutAssetResolver(
      wb,
      new ResolverSubCoachScope(
        makeSubCoachScope({ allowed: true, isSub: false }),
      ),
    );
    await resolver.materialise({
      clientId: 'c1',
      coachId: 'coach1',
      assetId: 'plan-a',
    });
    const key = (wb as unknown as { assignPlan: jest.Mock }).assignPlan.mock.calls[0][3];
    expect(key).toBe('drip:workout:c1:plan-a:no-drop');
  });
});
