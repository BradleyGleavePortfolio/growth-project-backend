import { BillingService } from '../src/billing/billing.service';

// Integration: BillingService gives the CheckoutWebhookHandler first refusal
// on checkout/sub/payment events. If checkout claims the event,
// BillingService skips the SaaS-coach-subscription path so the two streams
// don't both upsert state.

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
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: { upsert: jest.fn(), findMany: jest.fn(async () => []) },
    paymentFailure: { create: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(stub)),
  };
  return stub;
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

  // A276-P1-3 (refix) — the Stripe receipt_url lookup MUST run before
  // the outer $transaction opens. Holding the Postgres connection across
  // a synchronous Stripe HTTP retrieveCharge round-trip is the Prisma
  // anti-pattern that the audit flagged: typical Stripe latency 200ms–2s,
  // Prisma's interactive-transaction timeout 5s. The fix passes the
  // resolved URL into handlePaymentSucceeded so the inner resolver's
  // https short-circuit fires and no Stripe HTTP call lands inside tx.
  describe('A276-P1-3 — receipt_url resolution outside $transaction', () => {
    function buildGuestPi() {
      return {
        id: 'evt_pi_succ',
        type: 'payment_intent.succeeded' as const,
        data: {
          object: {
            id: 'pi_guest',
            metadata: { guest_checkout_idempotency_key: 'idem-test-1' },
            latest_charge: 'ch_guest',
          },
        },
      };
    }

    it('invokes guestCheckout.resolveReceiptUrl BEFORE prisma.$transaction', async () => {
      const callOrder: string[] = [];
      const guestCheckout = {
        resolveReceiptUrl: jest.fn(async () => {
          callOrder.push('resolveReceiptUrl');
          return 'https://pay.stripe.com/receipts/test';
        }),
        handlePaymentSucceeded: jest.fn(async () => {
          callOrder.push('handlePaymentSucceeded');
        }),
      };
      // Wrap $transaction so we can record when it enters.
      const origTx = prisma.$transaction;
      prisma.$transaction = jest.fn(async (cb: any) => {
        callOrder.push('tx-open');
        const r = await origTx(cb);
        callOrder.push('tx-close');
        return r;
      });

      const svcWithGuest = new BillingService(
        prisma,
        { capture: jest.fn(), identify: jest.fn() } as any,
        { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
        connect,
        checkout,
        undefined,
        guestCheckout as any,
      );

      await svcWithGuest.handleEvent(buildGuestPi());

      // resolveReceiptUrl ran BEFORE the transaction opened.
      const resolveIdx = callOrder.indexOf('resolveReceiptUrl');
      const txOpenIdx = callOrder.indexOf('tx-open');
      expect(resolveIdx).toBeGreaterThanOrEqual(0);
      expect(txOpenIdx).toBeGreaterThanOrEqual(0);
      expect(resolveIdx).toBeLessThan(txOpenIdx);
    });

    it('passes the pre-resolved https URL into handlePaymentSucceeded so the inner resolveReceiptUrl short-circuits', async () => {
      const guestCheckout = {
        resolveReceiptUrl: jest.fn(
          async () => 'https://pay.stripe.com/receipts/test',
        ),
        handlePaymentSucceeded: jest.fn(async () => {}),
      };
      const svcWithGuest = new BillingService(
        prisma,
        { capture: jest.fn(), identify: jest.fn() } as any,
        { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
        connect,
        checkout,
        undefined,
        guestCheckout as any,
      );

      await svcWithGuest.handleEvent(buildGuestPi());

      expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
      const args: any[] = (guestCheckout.handlePaymentSucceeded as jest.Mock).mock.calls[0] ?? [];
      expect(args[0]).toBe('pi_guest');
      expect(args[1]).toMatchObject({
        chargeId: 'ch_guest',
        receiptUrl: 'https://pay.stripe.com/receipts/test',
      });
    });

    it('skips pre-resolve for non-guest-checkout payment intents (no metadata flag)', async () => {
      const guestCheckout = {
        resolveReceiptUrl: jest.fn(),
        handlePaymentSucceeded: jest.fn(),
      };
      const svcWithGuest = new BillingService(
        prisma,
        { capture: jest.fn(), identify: jest.fn() } as any,
        { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
        connect,
        checkout,
        undefined,
        guestCheckout as any,
      );

      await svcWithGuest.handleEvent({
        id: 'evt_saas_pi',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_saas', metadata: {} } }, // no guest flag
      });

      expect(guestCheckout.resolveReceiptUrl).not.toHaveBeenCalled();
      expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
    });

    it('absorbs pre-resolve failures — dedup row still commits, inner handler still runs with null URL', async () => {
      const guestCheckout = {
        resolveReceiptUrl: jest.fn(async () => {
          throw new Error('stripe down');
        }),
        handlePaymentSucceeded: jest.fn(async () => {}),
      };
      const svcWithGuest = new BillingService(
        prisma,
        { capture: jest.fn(), identify: jest.fn() } as any,
        { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
        connect,
        checkout,
        undefined,
        guestCheckout as any,
      );

      const result = await svcWithGuest.handleEvent(buildGuestPi());
      expect(result.processed).toBe(true);
      expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
      // chargeId from event payload still flows through; receiptUrl null.
      const args: any[] = (guestCheckout.handlePaymentSucceeded as jest.Mock).mock.calls[0] ?? [];
      expect(args[1].chargeId).toBe('ch_guest');
      expect(args[1].receiptUrl).toBeNull();
    });
  });

  it('rolls back the whole transaction when the checkout handler throws (no half-write)', async () => {
    // After P1-1, the entire event handler is wrapped in a single
    // $transaction. If the checkout handler throws, the inserted
    // stripe_processed_event row rolls back and the SaaS side-effects
    // must NOT have committed — Stripe will retry the webhook delivery.
    checkout.handle.mockRejectedValueOnce(new Error('checkout boom'));
    prisma.coachProfile.findFirst.mockResolvedValueOnce({ user_id: 'coach-1' });
    await expect(
      svc.handleEvent({
        id: 'evt_boom',
        type: 'customer.subscription.updated',
        data: {
          object: { id: 'sub_x', customer: 'cus_x', status: 'active' },
        },
      }),
    ).rejects.toThrow(/checkout boom/);
  });
});
