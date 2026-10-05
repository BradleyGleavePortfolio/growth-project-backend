/**
 * S-MWB-2 fix round — B-640-4 / C-640-5 / C-640-6: a whole-program package
 * asset is never copied inside a shared inline fan-out transaction.
 *
 * Paid checkout, $0 invite grants and free-package claims (PurchaseFanoutService)
 * and push-to-existing (PackagePushService, covered in package-push.service.spec)
 * ask the registry `shouldDeferInline` before materialising a due-now drop. For a
 * master program the drop stays `pending`, so the one-minute drip dispatcher
 * delivers it in its OWN transaction (ProgramDeliveryService.deliver, 30 s
 * budget) with retries and a coach alert, and a large, slow or empty program can
 * never time out or roll back the purchase / grant.
 */
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetResolver,
} from '../src/packages/asset-resolvers/assignable-asset-resolver.interface';
import { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { WorkoutAssetResolver } from '../src/packages/asset-resolvers/workout.resolver';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

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

function programDelivery(isMaster: boolean) {
  return {
    isProgramMaster: jest.fn(async () => isMaster),
    findDeliverableMaster: jest.fn(async () =>
      isMaster ? { id: 'master-1', name: 'Intro' } : null,
    ),
    deliver: jest.fn(async () => ({
      program_id: 'copy-1',
      assignment_ids: ['asg-1'],
      first_assignment_id: 'asg-1',
      first_plan_id: 'plan-1',
      first_scheduled_for: 'x',
      last_scheduled_for: 'y',
      replayed: false,
    })),
    deliverInTx: jest.fn(),
  };
}

const INPUT: AssignableAssetMaterialiseInput = {
  clientId: 'client-1',
  coachId: 'coach-1',
  assetId: 'master-1',
  scheduledDropId: 'drop-1',
  clientPurchaseId: 'purchase-1',
  contentId: 'content-1',
};

describe('WorkoutAssetResolver.deferInline', () => {
  it('defers a master program when called inside an inline transaction', async () => {
    const pd = programDelivery(true);
    const resolver = new WorkoutAssetResolver(fake({ assignPlan: jest.fn() }), scope(), fake(pd));
    const tx = { marker: 'tx' };
    await expect(resolver.deferInline({ ...INPUT, tx: fake(tx) })).resolves.toBe(true);
    expect(pd.isProgramMaster).toHaveBeenCalledWith('master-1', tx);
  });

  it('never defers on the dispatcher path (no tx): the cron delivers in its own transaction', async () => {
    const pd = programDelivery(true);
    const resolver = new WorkoutAssetResolver(fake({ assignPlan: jest.fn() }), scope(), fake(pd));
    await expect(resolver.deferInline(INPUT)).resolves.toBe(false);
    expect(pd.isProgramMaster).not.toHaveBeenCalled();
    // ...and materialise on that path opens its own transaction (deliver, not deliverInTx).
    await expect(resolver.materialise(INPUT)).resolves.toEqual({ materialisedRef: 'asg-1' });
    expect(pd.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryKey: 'pkg:p=purchase-1:c=content-1', source: 'package' }),
    );
    expect(pd.deliverInTx).not.toHaveBeenCalled();
  });

  it('keeps a legacy single-plan asset inline', async () => {
    const pd = programDelivery(false);
    const resolver = new WorkoutAssetResolver(fake({ assignPlan: jest.fn() }), scope(), fake(pd));
    await expect(resolver.deferInline({ ...INPUT, assetId: 'plan-1', tx: fake({}) })).resolves.toBe(
      false,
    );
  });
});

describe('AssignableAssetResolverRegistry.shouldDeferInline', () => {
  const plain: AssignableAssetResolver = {
    assetType: 'pdf',
    canHandle: (t: string) => t === 'pdf',
    materialise: jest.fn(async () => ({ materialisedRef: 'r' })),
  };

  it('is false for an unknown type and for a resolver with no deferInline', async () => {
    const registry = new AssignableAssetResolverRegistry([plain]);
    await expect(registry.shouldDeferInline('video', INPUT)).resolves.toBe(false);
    await expect(registry.shouldDeferInline('pdf', INPUT)).resolves.toBe(false);
  });

  it("delegates to the resolver's deferInline", async () => {
    const deferring: AssignableAssetResolver = {
      assetType: 'workout_plan',
      canHandle: (t: string) => t === 'workout_program',
      materialise: jest.fn(async () => ({ materialisedRef: 'r' })),
      deferInline: jest.fn(async () => true),
    };
    const registry = new AssignableAssetResolverRegistry([plain, deferring]);
    await expect(registry.shouldDeferInline('workout_program', INPUT)).resolves.toBe(true);
  });
});

describe('PurchaseFanoutService: a program drop is left for the dispatcher', () => {
  function makeTx() {
    const drops: Array<Record<string, unknown>> = [];
    const fanouts: Array<Record<string, unknown>> = [];
    const contents = [
      {
        id: 'content-prog',
        package_id: 'pkg-1',
        asset_type: 'workout_program',
        asset_id: 'master-1',
        asset_revision_id: null,
        display_order: 0,
        cadence_kind: 'immediate',
        cadence_payload: {},
        display_title: 'Intro program',
        display_caption: null,
        removed_at: null,
      },
      {
        id: 'content-pdf',
        package_id: 'pkg-1',
        asset_type: 'pdf',
        asset_id: 'media-1',
        asset_revision_id: null,
        display_order: 1,
        cadence_kind: 'immediate',
        cadence_payload: {},
        display_title: 'Welcome guide',
        display_caption: null,
        removed_at: null,
      },
    ];
    const tx = {
      _drops: drops,
      _fanouts: fanouts,
      purchaseFanout: {
        upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
          fanouts.push({ ...create });
          return create;
        }),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(fanouts[0], data);
          return fanouts[0];
        }),
      },
      clientPurchase: {
        findUnique: jest.fn(async () => ({
          id: 'purchase-1',
          package_id: 'pkg-1',
          coach_user_id: 'coach-1',
          client_user_id: 'client-1',
          created_at: new Date(),
        })),
      },
      coachPackageContent: { findMany: jest.fn(async () => contents) },
      scheduledDrop: {
        createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          for (const row of data) {
            drops.push({ id: `drop-${drops.length + 1}`, materialised_ref: null, ...row });
          }
          return { count: data.length };
        }),
        findMany: jest.fn(async () => drops.map((d) => ({ ...d }))),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = drops.find((d) => d.id === where.id);
            if (row) Object.assign(row, data);
            return row;
          },
        ),
      },
    };
    return tx;
  }

  it('$0 grant / paid checkout: the program drop stays pending and is not copied in the grant transaction; other content still lands inline', async () => {
    const materialised: string[] = [];
    const pd = programDelivery(true);
    const workout = new WorkoutAssetResolver(fake({ assignPlan: jest.fn() }), scope(), fake(pd));
    const pdf: AssignableAssetResolver = {
      assetType: 'pdf',
      canHandle: (t: string) => t === 'pdf',
      materialise: jest.fn(async (input: AssignableAssetMaterialiseInput) => {
        materialised.push(input.assetId);
        return { materialisedRef: 'grant-1' };
      }),
    };
    const registry = new AssignableAssetResolverRegistry([workout, pdf]);
    const fanout = new PurchaseFanoutService(registry);
    const tx = makeTx();

    await fanout.onPurchaseEntitled({ id: 'purchase-1' }, { entrypoint: 'invite_grant' }, fake(tx));

    const prog = tx._drops.find((d) => d.content_id === 'content-prog');
    const guide = tx._drops.find((d) => d.content_id === 'content-pdf');
    expect(prog).toMatchObject({ status: 'pending', materialised_ref: null });
    expect(guide).toMatchObject({ status: 'fired', materialised_ref: 'grant-1' });
    expect(materialised).toEqual(['media-1']);
    // No program copy of any kind inside the grant transaction.
    expect(pd.deliverInTx).not.toHaveBeenCalled();
    expect(pd.deliver).not.toHaveBeenCalled();
    // The grant itself succeeds.
    expect(tx._fanouts[0]).toMatchObject({ state: 'succeeded' });
  });
});
