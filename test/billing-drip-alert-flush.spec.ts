import { BillingService } from '../src/billing/billing.service';

// PR-9 — verifies BillingService.handleEvent:
//   1. Passes the outer $transaction's tx to checkoutWebhooks.handle(event, tx).
//   2. Flushes drop alerts AFTER the tx commits (post-commit boundary).
//   3. Discards staged alerts when the tx rolls back (prevents
//      double-alert on Stripe retry).

function makePrisma() {
  const processed: any[] = [];
  const stub: any = {
    _processed: processed,
    stripeProcessedEvent: {
      findUnique: jest.fn(async ({ where }: any) =>
        processed.find((e) => e.stripe_event_id === where.stripe_event_id) ?? null,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async ({ data }: any) => {
        if (processed.find((e) => e.stripe_event_id === data.stripe_event_id)) {
          const err: any = new Error('dup');
          err.code = 'P2002';
          throw err;
        }
        processed.push({ ...data, processed_at: new Date() });
        return data;
      }),
    },
    coachProfile: { findFirst: jest.fn(async () => null) },
    coachSubscription: {
      upsert: jest.fn(), update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    paymentFailure: { create: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(stub)),
  };
  return stub;
}

describe('PR-9 — BillingService drip-alert boundary', () => {
  let prisma: any;
  let checkout: any;

  function makeSvc() {
    return new BillingService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
      undefined,
      checkout,
    );
  }

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('passes the outer tx to checkoutWebhooks.handle(event, tx)', async () => {
    checkout = {
      handle: jest.fn(async (_e: any, tx: any) => {
        // Tx received and is the same object the $transaction callback was invoked with.
        expect(tx).toBe(prisma);
        return { claimed: true, purchase_id: 'cp-1' };
      }),
      flushDripAlerts: jest.fn(),
      discardPendingDripAlerts: jest.fn(),
    };
    const svc = makeSvc();
    await svc.handleEvent({
      id: 'evt_a',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_a', mode: 'payment' } },
    });
    expect(checkout.handle).toHaveBeenCalledTimes(1);
    expect(checkout.handle.mock.calls[0][1]).toBe(prisma); // second arg is tx
  });

  it('flushDripAlerts is called AFTER the tx callback resolves (post-commit ordering)', async () => {
    const order: string[] = [];
    checkout = {
      handle: jest.fn(async () => {
        order.push('handle');
        return { claimed: true, purchase_id: 'cp-2' };
      }),
      flushDripAlerts: jest.fn(() => order.push('flush')),
      discardPendingDripAlerts: jest.fn(),
    };
    const txOrig = prisma.$transaction;
    prisma.$transaction = jest.fn(async (cb: any) => {
      const r = await txOrig.mock.calls[0]?.[0]?.(prisma) ?? (await cb(prisma));
      order.push('tx-commit');
      return r;
    });
    // Simpler — patch directly:
    prisma.$transaction = jest.fn(async (cb: any) => {
      await cb(prisma);
      order.push('tx-commit');
    });

    const svc = makeSvc();
    await svc.handleEvent({
      id: 'evt_b',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_b', mode: 'payment' } },
    });

    // Order: handle (inside tx) → tx-commit → flush
    expect(order).toEqual(['handle', 'tx-commit', 'flush']);
    expect(checkout.flushDripAlerts).toHaveBeenCalledWith('cp-2');
    expect(checkout.discardPendingDripAlerts).not.toHaveBeenCalled();
  });

  it('flushDripAlerts hook errors are SWALLOWED (push provider failure must NEVER bubble to a non-2xx webhook response)', async () => {
    checkout = {
      handle: jest.fn(async () => ({ claimed: true, purchase_id: 'cp-3' })),
      flushDripAlerts: jest.fn(() => { throw new Error('push provider down'); }),
      discardPendingDripAlerts: jest.fn(),
    };
    const svc = makeSvc();
    const result = await svc.handleEvent({
      id: 'evt_c',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_c', mode: 'payment' } },
    });
    // Even though flushDripAlerts threw, the webhook returns processed=true.
    expect(result.processed).toBe(true);
  });

  it('on a tx rollback, discardPendingDripAlerts is called and flushDripAlerts is NOT — prevents double-alert on Stripe retry', async () => {
    checkout = {
      handle: jest.fn(async () => ({ claimed: true, purchase_id: 'cp-rollback' })),
      flushDripAlerts: jest.fn(),
      discardPendingDripAlerts: jest.fn(),
    };
    // Make the tx callback throw (simulates resolver failure inside fan-out).
    prisma.$transaction = jest.fn(async (cb: any) => {
      await cb(prisma);
      throw new Error('rolled_back');
    });

    const svc = makeSvc();
    await expect(svc.handleEvent({
      id: 'evt_rb',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_rb', mode: 'payment' } },
    })).rejects.toThrow(/rolled_back/);

    expect(checkout.discardPendingDripAlerts).toHaveBeenCalledWith('cp-rollback');
    expect(checkout.flushDripAlerts).not.toHaveBeenCalled();
  });

  it('LEGACY safety — when checkoutWebhooks lacks the new methods (older test wiring), the post-commit boundary is a no-op without crashing', async () => {
    checkout = {
      handle: jest.fn(async () => ({ claimed: true, purchase_id: 'cp-legacy' })),
      // no flushDripAlerts, no discardPendingDripAlerts
    };
    const svc = makeSvc();
    const result = await svc.handleEvent({
      id: 'evt_legacy',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_legacy', mode: 'payment' } },
    });
    expect(result.processed).toBe(true);
  });
});
