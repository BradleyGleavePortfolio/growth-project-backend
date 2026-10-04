import { TrialConflictService } from '../src/packages/trials/trial-conflict.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { makeTrialConflictTable, stub } from './utils/trial-fakes';

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
    const stripe = stub<C[1]>({ cancelSubscription });
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
