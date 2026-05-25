import { BillingService } from '../src/billing/billing.service';

// Integration test: BillingService.handleEvent receives a Connect account.*
// event and forwards it to ConnectService.syncFromStripe / markDeauthorized.
// We verify the event is recorded once (idempotency) and the Connect handler
// is invoked with the right Stripe account id.

function makePrisma() {
  const processed: any[] = [];
  const profiles: any[] = [];
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
    coachProfile: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
    },
    coachSubscription: {
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    paymentFailure: { create: jest.fn() },
  };
  stub.$transaction = jest.fn(async (cb: (tx: any) => Promise<any>) => cb(stub));
  return stub;
}

describe('BillingService — Connect webhook events', () => {
  let prisma: any;
  let connect: any;
  let svc: BillingService;

  beforeEach(() => {
    prisma = makePrisma();
    connect = {
      syncFromStripe: jest.fn(async () => null),
      markDeauthorized: jest.fn(async () => undefined),
    };
    svc = new BillingService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
      connect,
    );
  });

  it('forwards account.updated to ConnectService.syncFromStripe', async () => {
    const result = await svc.handleEvent({
      id: 'evt_account_1',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_abc',
          country: 'US',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        },
      },
    });
    expect(result.processed).toBe(true);
    expect(connect.syncFromStripe).toHaveBeenCalledWith('acct_abc');
    expect(connect.markDeauthorized).not.toHaveBeenCalled();
  });

  it('forwards capability.updated to ConnectService.syncFromStripe (uses obj.account)', async () => {
    // For capability.updated, `data.object` is the capability itself; the
    // parent account id is on `.account` rather than `.id`.
    const result = await svc.handleEvent({
      id: 'evt_capability_1',
      type: 'capability.updated',
      data: {
        object: {
          id: 'card_payments',
          account: 'acct_xyz',
          status: 'active',
        },
      },
    });
    expect(result.processed).toBe(true);
    expect(connect.syncFromStripe).toHaveBeenCalledWith('acct_xyz');
  });

  it('forwards account.application.deauthorized to ConnectService.markDeauthorized', async () => {
    const result = await svc.handleEvent({
      id: 'evt_deauth_1',
      type: 'account.application.deauthorized',
      data: { object: { id: 'acct_abc' } },
    });
    expect(result.processed).toBe(true);
    expect(connect.markDeauthorized).toHaveBeenCalledWith('acct_abc');
    expect(connect.syncFromStripe).not.toHaveBeenCalled();
  });

  it('is idempotent across duplicate Connect events', async () => {
    const event = {
      id: 'evt_repeat',
      type: 'account.updated',
      data: { object: { id: 'acct_abc' } },
    };
    const a = await svc.handleEvent(event);
    const b = await svc.handleEvent(event);
    expect(a.processed).toBe(true);
    expect(b.processed).toBe(false);
    expect(b.alreadyProcessed).toBe(true);
    expect(connect.syncFromStripe).toHaveBeenCalledTimes(1);
  });

  it('processes test-mode and live-mode events identically', async () => {
    // The handler does not branch on livemode — both modes go through the
    // same code path. We verify by sending two events that differ only in
    // the livemode flag.
    await svc.handleEvent({
      id: 'evt_test',
      type: 'account.updated',
      data: { object: { id: 'acct_test', livemode: false } },
    });
    await svc.handleEvent({
      id: 'evt_live',
      type: 'account.updated',
      data: { object: { id: 'acct_live', livemode: true } },
    });
    expect(connect.syncFromStripe).toHaveBeenNthCalledWith(1, 'acct_test');
    expect(connect.syncFromStripe).toHaveBeenNthCalledWith(2, 'acct_live');
  });
});
