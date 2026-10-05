import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialConflictTable, makeTrialUsageTable, stub } from './utils/trial-fakes';

const NOW = new Date('2026-10-09T17:00:00Z');
type C = ConstructorParameters<typeof TrialConflictService>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('AUD-SOL-T23-118 — actual cancellation admission clocks', () => {
  it('a late-row cancellation holds a fresh lease while its bounded Stripe operation runs', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.setSystemTime(NOW);
    const table = makeTrialConflictTable();
    for (let i = 0; i < 8; i += 1) {
      await table.createMany({ data: [{
        id: `conflict-${i}`, purchase_id: `purchase-${i}`,
        stripe_subscription_id: `sub-${i}`, next_attempt_at: NOW,
      }] });
    }
    const entered = deferred<void>();
    const held = deferred<{ id: string; status: string }>();
    let lateCalls = 0;
    const cancelSubscription = jest.fn(async (id: string) => {
      // Seven successful nine-second calls. All are below the real
      // StripeConnectApiService ten-second HTTP timeout and the worker's
      // twenty-second wrapper deadline. Only elapsed clock is modeled.
      if (id !== 'sub-7') jest.setSystemTime(new Date(Date.now() + 9000));
      if (id === 'sub-7' && ++lateCalls === 1) {
        entered.resolve();
        return held.promise;
      }
      return { id, status: 'canceled' };
    });
    const db = stub<C[0]>({ packageTrialConflict: table });
    const stripe = stub<C[1]>({ cancelSubscription, retrieveSubscription: jest.fn(async (id: string) => ({ id, status: 'trialing', trial_end: Math.floor(NOW.getTime() / 1000) + 86400 })) });
    const firstService = new TrialConflictService(db, stripe);
    const replica = new TrialConflictService(db, stripe);
    const firstSweep = firstService.sweep(NOW);
    await entered.promise;
    expect(Date.now() - NOW.getTime()).toBe(63_000);
    // Five seconds into the final operation: still below both transport
    // bounds, yet the lease derived from the sweep timestamp expired.
    jest.setSystemTime(new Date(Date.now() + 5000));
    const other = await replica.settle('purchase-7');
    held.resolve({ id: 'sub-7', status: 'canceled' });
    await firstSweep;
    expect({ lateCalls, other }).toEqual({ lateCalls: 1, other: 'busy' });
  });
});

describe('AUD-SOL-T23-119 — cancellation safety beyond one active snapshot', () => {
  it('actual active webhook during intercepted Stripe GET preserves its new paid access against obsolete DELETE', async () => {
    const table = makeTrialConflictTable();
    await table.createMany({ data: [{
      id: 'conflict-real-handler', purchase_id: 'purchase-real-handler',
      stripe_subscription_id: 'sub-real-handler', next_attempt_at: NOW,
    }] });
    const purchase: Record<string, unknown> = {
      id: 'purchase-real-handler', client_user_id: 'client-real-handler',
      coach_user_id: 'coach-real-handler', package_id: 'package-real-handler',
      stripe_subscription_id: 'sub-real-handler', billing_type: 'recurring',
      status: 'trialing', entitlement_active: false, trial_days: 7,
      trial_ends_at: new Date(NOW.getTime() + 86400000),
      amount_cents: 4900, currency: 'usd', created_at: NOW,
    };
    const rawDb = {
      packageTrialConflict: table,
      packageTrialUsage: makeTrialUsageTable(),
      clientPurchase: {
        findUnique: jest.fn(async () => ({ ...purchase })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(purchase, data);
          return { ...purchase };
        }),
      },
      coachPackage: { findUnique: jest.fn(async () => ({
        id: 'package-real-handler', duration_periods: null,
      })) },
      $queryRaw: jest.fn(async () => []),
    };
    const db = stub<C[0]>(rawDb);
    const originalSecret = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_AUDITSYNTHETIC';
    const stripe = new StripeConnectApiService();
    const service = new TrialConflictService(db, stripe);
    const usage = new TrialUsageService(db);
    const handler = new CheckoutWebhookHandlerService(
      db, stripe, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, usage, undefined, service,
    );
    const tx = stub<Parameters<CheckoutWebhookHandlerService['handle']>[1]>(rawDb);
    const calls: string[] = [];
    let paidAccessBeforeDelete: unknown;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'GET') {
        await handler.handle({
          id: 'evt-active-early', type: 'customer.subscription.updated',
          data: { object: {
            id: 'sub-real-handler', status: 'active',
            trial_end: Math.floor(NOW.getTime() / 1000),
            current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
          } },
        }, tx);
        paidAccessBeforeDelete = purchase.entitlement_active;
        return new Response(JSON.stringify({
          id: 'sub-real-handler', status: 'trialing',
          trial_end: Math.floor(NOW.getTime() / 1000) + 86400,
        }), { status: 200 });
      }
      await handler.handle({
        id: 'evt-deleted-after-stale-retry', type: 'customer.subscription.deleted',
        data: { object: { id: 'sub-real-handler' } },
      }, tx);
      return new Response(JSON.stringify({
        id: 'sub-real-handler', status: 'canceled',
      }), { status: 200 });
    });
    try {
      const result = await service.settle('purchase-real-handler', NOW);
      expect(paidAccessBeforeDelete).toBe(true);
      expect(result).toBe('stale');
      expect(table.rows[0].status).toBe('superseded');
      expect({ calls, paidAccess: purchase.entitlement_active }).toEqual({
        calls: ['GET'], paidAccess: true,
      });
    } finally {
      if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalSecret;
    }
  });

  it.each(['past_due', 'unpaid'])(
    'does not infer never-billed from %s when previous paid conversion evidence is unavailable',
    async (status) => {
      const table = makeTrialConflictTable();
      await table.createMany({ data: [{
        id: 'conflict-late', purchase_id: 'purchase-late',
        stripe_subscription_id: 'sub-late', next_attempt_at: NOW,
        attempts: 6, alerted_at: NOW,
      }] });
      // Durable owed conflict survived an outage: the first regular invoice
      // was paid; a later invoice is now overdue. All active events were
      // delayed. Status alone does not reveal that prior paid invoice.
      const originalSecret = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = 'sk_test_AUDITSYNTHETIC';
      const calls: string[] = [];
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const method = init?.method ?? 'GET';
        calls.push(method);
        const body = method === 'DELETE'
          ? { id: 'sub-late', status: 'canceled' }
          : { id: 'sub-late', status, latest_invoice: 'in-renewal-open',
              trial_end: Math.floor(NOW.getTime() / 1000) - 40 * 86400 };
        return new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      });
      try {
        const service = new TrialConflictService(
          stub<C[0]>({ packageTrialConflict: table }),
          new StripeConnectApiService(),
        );
        await service.sweep(NOW);
        expect(calls).not.toContain('DELETE');
        expect(table.rows[0].status).not.toBe('cancelled');
      } finally {
        if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = originalSecret;
      }
    },
  );

  it('a superseding webhook committed during the GET vetoes DELETE even when its older response says trialing far from end', async () => {
    const table = makeTrialConflictTable();
    await table.createMany({ data: [{
      id: 'conflict-race', purchase_id: 'purchase-race',
      stripe_subscription_id: 'sub-race', next_attempt_at: NOW,
    }] });
    const db = stub<C[0]>({ packageTrialConflict: table });
    const cancelSubscription = jest.fn(async () => ({ id: 'sub-race', status: 'canceled' }));
    let service!: TrialConflictService;
    const retrieveSubscription = jest.fn(async () => {
      // Read captured the pre-conversion snapshot. Before the response
      // arrives, early conversion's active event commits supersession.
      await service.supersede(db, 'purchase-race', NOW);
      return { id: 'sub-race', status: 'trialing',
        trial_end: Math.floor(NOW.getTime() / 1000) + 86400 };
    });
    service = new TrialConflictService(db, stub<C[1]>({ retrieveSubscription, cancelSubscription }));
    const result = await service.settle('purchase-race', NOW);
    expect(result).toBe('stale');
    expect(table.rows[0].status).toBe('superseded');
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it('an unchanged, still-unbilled trial far from end cancels once', async () => {
    const table = makeTrialConflictTable();
    await table.createMany({ data: [{
      id: 'conflict-control', purchase_id: 'purchase-control',
      stripe_subscription_id: 'sub-control', next_attempt_at: NOW,
    }] });
    const cancelSubscription = jest.fn(async () => ({ id: 'sub-control', status: 'canceled' }));
    const retrieveSubscription = jest.fn(async () => ({
      id: 'sub-control', status: 'trialing',
      trial_end: Math.floor(NOW.getTime() / 1000) + 86400,
    }));
    const service = new TrialConflictService(
      stub<C[0]>({ packageTrialConflict: table }),
      stub<C[1]>({ retrieveSubscription, cancelSubscription }),
    );
    expect(await service.settle('purchase-control', NOW)).toBe('cancelled');
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-SOL-T23-118 — cancellation retry after the card was charged', () => {
  it('a missed active webhook must not let an owed conflict cancel a paid active plan without the billed alert', async () => {
    const table = makeTrialConflictTable();
    await table.createMany({ data: [{
      id: 'conflict-paid', purchase_id: 'purchase-paid',
      stripe_subscription_id: 'sub-paid', next_attempt_at: NOW,
      attempts: 3, alerted_at: NOW,
    }] });
    // The cancellation outage spanned the trial end. Stripe charged the
    // first regular invoice, but customer.subscription.updated has not yet
    // reached BillingService. The durable local conflict therefore remains
    // owed. Actual service + actual Stripe API over an intercepted fetch.
    const originalSecret = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_AUDITSYNTHETIC';
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      const body = method === 'DELETE'
        ? { id: 'sub-paid', status: 'canceled' }
        : { id: 'sub-paid', status: 'active', latest_invoice: 'in-paid',
            trial_end: Math.floor(NOW.getTime() / 1000) - 1 };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const service = new TrialConflictService(
        stub<C[0]>({ packageTrialConflict: table }),
        new StripeConnectApiService(),
      );
      await service.sweep(NOW);
      expect(calls).not.toContain('DELETE');
      expect(table.rows[0]).toMatchObject({ status: 'superseded' });
    } finally {
      if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalSecret;
    }
  });
});
