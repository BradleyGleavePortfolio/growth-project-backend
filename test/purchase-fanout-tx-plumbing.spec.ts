import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { AssignableAssetResolverRegistry } from '../src/packages/asset-resolvers/assignable-asset-resolver.registry';

// PR-9 — confirms that the checkout webhook handler now ACCEPTS a tx
// from BillingService and uses it for the entitlement update + the
// fan-out. The previous PR-4 hooks used `this.prisma` for everything;
// the PR-9 mandate is that ALL THREE entitlement paths run fan-out
// with a real tx.

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
}

class StubRegistry extends AssignableAssetResolverRegistry {
  calls: Array<{ assetType: string; input: any }> = [];
  constructor(
    private readonly impl: (assetType: string) => Promise<{ materialisedRef: string }>,
  ) { super([]); }
  override async materialise(assetType: string, input: any) {
    this.calls.push({ assetType, input });
    return this.impl(assetType);
  }
  override resolve(): any { return null; }
}

function makePrisma() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const fanouts: any[] = [];
  const contents: any[] = [];
  const drops: any[] = [];
  const api: any = {
    _packages: packages,
    _purchases: purchases,
    _fanouts: fanouts,
    _contents: contents,
    _drops: drops,
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => {
          if (where.id) return p.id === where.id;
          if (where.stripe_checkout_session_id)
            return p.stripe_checkout_session_id === where.stripe_checkout_session_id;
          return false;
        }) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    coachPackageContent: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let rows = contents.filter((c) =>
          c.package_id === where.package_id && c.removed_at == null,
        );
        if (orderBy?.display_order === 'asc') {
          rows = [...rows].sort((a, b) => a.display_order - b.display_order);
        }
        return rows.map((r) => ({ ...r }));
      }),
    },
    scheduledDrop: {
      createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
        let created = 0;
        for (const row of data) {
          const exists = drops.find(
            (d) =>
              d.client_purchase_id === row.client_purchase_id &&
              d.content_id === row.content_id,
          );
          if (exists) { if (skipDuplicates) continue; throw new Error('p2002'); }
          drops.push({
            id: `drop-${drops.length + 1}`,
            attempt_count: 0,
            materialised_ref: null,
            fired_at: null,
            failure_reason: null,
            ...row,
          });
          created += 1;
        }
        return { count: created };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        drops
          .filter((d) =>
            Object.entries(where).every(([k, v]) => d[k] === v),
          )
          .map((d) => ({ ...d })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = drops.find((d) => d.id === where.id);
        for (const [k, v] of Object.entries(data ?? {})) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) {
            row[k] = (row[k] ?? 0) + (v as any).increment;
          } else {
            row[k] = v;
          }
        }
        return { ...row };
      }),
    },
    purchaseFanout: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = fanouts.find((f) => f.purchase_id === where.purchase_id);
        if (existing) return { ...existing };
        const row = { id: `fo-${fanouts.length + 1}`, state: 'pending', ...create };
        fanouts.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = fanouts.find((f) => f.purchase_id === where.purchase_id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  return api;
}

describe('PR-9 — tx plumbed through checkout webhook handler', () => {
  it('checkout.session.completed: fan-out runs INSIDE the provided tx and seeds drops + materialises immediate', async () => {
    const prisma = makePrisma();
    const registry = new StubRegistry(async (t) => ({ materialisedRef: `ref-${t}` }));
    const fanout = new PurchaseFanoutService(registry);
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._packages.push({ id: 'pkg-1', coach_id: 'coach-1', billing_type: 'one_time', duration_periods: null });
    prisma._purchases.push({
      id: 'cp-1',
      package_id: 'pkg-1',
      coach_user_id: 'coach-1',
      client_user_id: 'client-1',
      stripe_checkout_session_id: 'cs_hosted',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
    });
    prisma._contents.push({
      id: 'c-imm', package_id: 'pkg-1', asset_type: 'workout_program',
      asset_id: 'wp', asset_revision_id: null, display_order: 0,
      cadence_kind: 'immediate', cadence_payload: {},
      display_title: 'WP', display_caption: null, removed_at: null,
    });

    // Pass prisma as the "tx" — same shape, the handler doesn't care
    // beyond having the engine tables present.
    const result = await svc.handle({
      id: 'evt_hosted',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_hosted', mode: 'payment', payment_intent: 'pi_1' } },
    }, prisma as any);

    expect(result.claimed).toBe(true);
    expect(result.purchase_id).toBe('cp-1');
    // Drop seeded + materialised inside the tx.
    expect(prisma._drops).toHaveLength(1);
    expect(prisma._drops[0]).toMatchObject({
      status: 'fired',
      materialised_ref: 'ref-workout_program',
    });
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0].input.tx).toBe(prisma); // the tx is plumbed
  });

  it('payment_intent.succeeded: fan-out runs INSIDE the provided tx (in_app_ps entrypoint)', async () => {
    const prisma = makePrisma();
    const registry = new StubRegistry(async (t) => ({ materialisedRef: `ref-${t}` }));
    const fanout = new PurchaseFanoutService(registry);
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._purchases.push({
      id: 'cp-2',
      package_id: 'pkg-2',
      coach_user_id: 'coach-2',
      client_user_id: 'client-2',
      stripe_payment_intent_id: 'pi_ps',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
    });
    prisma._packages.push({ id: 'pkg-2', coach_id: 'coach-2' });
    prisma._contents.push({
      id: 'c-imm-2', package_id: 'pkg-2', asset_type: 'pdf',
      asset_id: 'asset-pdf', asset_revision_id: null, display_order: 0,
      cadence_kind: 'immediate', cadence_payload: {},
      display_title: null, display_caption: null, removed_at: null,
    });

    await svc.handle({
      id: 'evt_ps',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_ps' } },
    }, prisma as any);

    expect(prisma._drops).toHaveLength(1);
    expect(prisma._drops[0].status).toBe('fired');
    expect(prisma._fanouts[0].entrypoint).toBe('in_app_ps');
  });

  it('LEGACY path — no tx provided: the handler falls back to this.prisma, the engine-table guard short-circuits drop seed, but PurchaseFanout row IS still recorded', async () => {
    const prisma = makePrisma();
    const fanout = new PurchaseFanoutService(); // no registry needed
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._purchases.push({
      id: 'cp-3',
      coach_user_id: 'coach-3',
      client_user_id: 'client-3',
      stripe_payment_intent_id: 'pi_legacy',
      status: 'pending',
      created_at: new Date(),
    });

    // No tx argument.
    await svc.handle({
      id: 'evt_legacy',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_legacy' } },
    });

    // PR-4 idempotency contract preserved.
    expect(prisma._fanouts).toHaveLength(1);
    expect(prisma._fanouts[0].purchase_id).toBe('cp-3');
  });

  it('atomicity — when the resolver throws inside the in-tx fan-out, the webhook handler PROPAGATES the error (so the outer BillingService $transaction rolls back)', async () => {
    const prisma = makePrisma();
    const registry = new StubRegistry(async () => { throw new Error('resolver_failure'); });
    const fanout = new PurchaseFanoutService(registry);
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._packages.push({ id: 'pkg-x', coach_id: 'coach-x' });
    prisma._purchases.push({
      id: 'cp-x',
      package_id: 'pkg-x',
      coach_user_id: 'coach-x',
      client_user_id: 'client-x',
      stripe_checkout_session_id: 'cs_x',
      status: 'pending',
      created_at: new Date(),
    });
    prisma._contents.push({
      id: 'c-fail', package_id: 'pkg-x', asset_type: 'video',
      asset_id: 'a', display_order: 0,
      cadence_kind: 'immediate', cadence_payload: {},
      removed_at: null,
    });

    await expect(svc.handle({
      id: 'evt_fail',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', mode: 'payment' } },
    }, prisma as any)).rejects.toThrow(/resolver_failure/);

    // Fanout never reached "succeeded" — outer tx would roll back.
    expect(prisma._fanouts[0].state).toBe('pending');
  });

  it('flushDripAlerts is wired through the handler and dispatches the bucket after a successful in-tx materialise', async () => {
    const prisma = makePrisma();
    const seen: any[] = [];
    const hook = { enqueue: (a: any) => seen.push(a) };
    const registry = new StubRegistry(async (t) => ({ materialisedRef: `ref-${t}` }));
    const fanout = new PurchaseFanoutService(registry, hook);
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._packages.push({ id: 'pkg-a', coach_id: 'coach-a' });
    prisma._purchases.push({
      id: 'cp-a',
      package_id: 'pkg-a',
      coach_user_id: 'coach-a',
      client_user_id: 'client-a',
      stripe_checkout_session_id: 'cs_a',
      status: 'pending',
      created_at: new Date(),
    });
    prisma._contents.push({
      id: 'c-1', package_id: 'pkg-a', asset_type: 'workout_program',
      asset_id: 'wp', display_order: 0,
      cadence_kind: 'immediate', cadence_payload: {},
      display_title: 'T', display_caption: null, removed_at: null,
    });

    await svc.handle({
      id: 'evt_a',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_a', mode: 'payment' } },
    }, prisma as any);

    // Alerts staged, not yet dispatched (the in-tx phase only stages).
    expect(seen).toHaveLength(0);

    // Caller (BillingService) flushes post-commit.
    svc.flushDripAlerts('cp-a');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      clientPurchaseId: 'cp-a',
      clientId: 'client-a',
      coachId: 'coach-a',
      assetType: 'workout_program',
    });
  });

  it('discardPendingDripAlerts drops the bucket so a Stripe retry after rollback does not double-alert when the retry commits', async () => {
    const prisma = makePrisma();
    const seen: any[] = [];
    const hook = { enqueue: (a: any) => seen.push(a) };
    const registry = new StubRegistry(async () => ({ materialisedRef: 'r' }));
    const fanout = new PurchaseFanoutService(registry, hook);
    const svc = new CheckoutWebhookHandlerService(
      prisma as any,
      new StripeStub() as any,
      undefined, undefined, undefined,
      fanout,
    );

    prisma._packages.push({ id: 'pkg-d', coach_id: 'coach-d' });
    prisma._purchases.push({
      id: 'cp-d',
      package_id: 'pkg-d',
      coach_user_id: 'coach-d',
      client_user_id: 'client-d',
      stripe_checkout_session_id: 'cs_d',
      status: 'pending',
      created_at: new Date(),
    });
    prisma._contents.push({
      id: 'c-d', package_id: 'pkg-d', asset_type: 'pdf',
      asset_id: 'a', display_order: 0,
      cadence_kind: 'immediate', cadence_payload: {},
      removed_at: null,
    });

    await svc.handle({
      id: 'evt_d',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_d', mode: 'payment' } },
    }, prisma as any);

    // Caller (BillingService) signals rollback.
    svc.discardPendingDripAlerts('cp-d');
    svc.flushDripAlerts('cp-d');
    expect(seen).toHaveLength(0);
  });
});
