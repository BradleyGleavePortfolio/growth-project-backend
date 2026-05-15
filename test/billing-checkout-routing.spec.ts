import { BillingService } from '../src/billing/billing.service';

// Integration: BillingService gives the CheckoutWebhookHandler first refusal
// on checkout/sub/payment events. If checkout claims the event,
// BillingService skips the SaaS-coach-subscription path so the two streams
// don't both upsert state.

function makePrisma() {
  const processed: any[] = [];
  return {
    _processed: processed,
    stripeProcessedEvent: {
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
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    paymentFailure: { create: jest.fn() },
  };
}

describe('BillingService — checkout webhook routing', () => {
  let prisma: any;
  let connect: any;
  let checkout: any;
  let svc: BillingService;

  beforeEach(() => {
    prisma = makePrisma();
    connect = {
      syncFromStripe: jest.fn(async () => null),
      markDeauthorized: jest.fn(async () => undefined),
    };
    checkout = {
      handle: jest.fn(async () => ({ claimed: false })),
    };
    svc = new BillingService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
      connect,
      checkout,
    );
  });

  it('routes checkout.session.completed to checkout handler', async () => {
    checkout.handle.mockResolvedValueOnce({ claimed: true, purchase_id: 'cp-1' });
    const result = await svc.handleEvent({
      id: 'evt_cs',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_abc', mode: 'payment' } },
    });
    expect(result.processed).toBe(true);
    expect(checkout.handle).toHaveBeenCalledTimes(1);
    // SaaS coach-subscription path is NOT invoked for checkout events.
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  });

  it('routes customer.subscription.updated to checkout handler; skips SaaS path when claimed', async () => {
    checkout.handle.mockResolvedValueOnce({ claimed: true });
    await svc.handleEvent({
      id: 'evt_sub',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_test', customer: 'cus_x' } },
    });
    expect(checkout.handle).toHaveBeenCalled();
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  });

  it('falls through to SaaS path when checkout does NOT claim the event', async () => {
    checkout.handle.mockResolvedValueOnce({ claimed: false });
    prisma.coachProfile.findFirst.mockResolvedValueOnce({ user_id: 'coach-99' });
    await svc.handleEvent({
      id: 'evt_saas',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_saas',
          customer: 'cus_saas',
          status: 'active',
        },
      },
    });
    expect(prisma.coachSubscription.upsert).toHaveBeenCalled();
  });

  it('routes payment_intent.payment_failed exclusively to checkout handler', async () => {
    checkout.handle.mockResolvedValueOnce({ claimed: true });
    const result = await svc.handleEvent({
      id: 'evt_pi',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_x' } },
    });
    expect(result.processed).toBe(true);
    // No SaaS-coach-subscription handler exists for this event type;
    // we just verify it doesn't end up writing payment failures (which
    // are for invoice.payment_failed).
    expect(prisma.paymentFailure.create).not.toHaveBeenCalled();
  });

  it('still routes account.* events to ConnectService, not checkout', async () => {
    await svc.handleEvent({
      id: 'evt_acct',
      type: 'account.updated',
      data: { object: { id: 'acct_x' } },
    });
    // Connect handler must fire.
    expect(connect.syncFromStripe).toHaveBeenCalledWith('acct_x');
    // Checkout handler is given a look but doesn't matter for account events.
  });

  it('survives a checkout handler that throws — still records event and continues', async () => {
    checkout.handle.mockRejectedValueOnce(new Error('checkout boom'));
    prisma.coachProfile.findFirst.mockResolvedValueOnce({ user_id: 'coach-1' });
    const result = await svc.handleEvent({
      id: 'evt_boom',
      type: 'customer.subscription.updated',
      data: {
        object: { id: 'sub_x', customer: 'cus_x', status: 'active' },
      },
    });
    expect(result.processed).toBe(true);
    // claimedByCheckout stays false on throw → SaaS path runs.
    expect(prisma.coachSubscription.upsert).toHaveBeenCalled();
  });
});
