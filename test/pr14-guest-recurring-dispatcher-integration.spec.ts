import { BillingService } from '../src/billing/billing.service';
import { GUEST_CHECKOUT_METADATA_KEY } from '../src/storefront/guest-checkout.service';

// PR-14 R2 P0-1 — integration-shape test driving Stripe events through
// the REAL BillingService.handleEvent dispatcher (not GuestCheckoutService
// directly). The first iteration of PR-14 silently failed because the
// recurring guest path minted a Stripe Subscription whose first-invoice
// PaymentIntent did NOT carry GUEST_CHECKOUT_METADATA_KEY, so the
// dispatcher's metadata-keyed routing gate at billing.service.ts:280-284
// never invoked handlePaymentSucceeded for recurring guests — every
// recurring checkout took money and delivered nothing.
//
// These tests assert the R2 fixes:
//   1. payment_intent.succeeded with NO guest metadata but whose PI id
//      matches a GuestCheckout sentinel routes to handlePaymentSucceeded
//      (BillingService PI-by-sentinel-id fallback).
//   2. payment_intent.payment_failed has the same fallback.
//   3. customer.subscription.updated / invoice.paid for a GuestCheckout
//      with a recurring sub id is the BACKSTOP path — drives
//      handlePaymentSucceeded against the sentinel's PI id after the
//      outer tx commits.
//   4. The PI primary path and the subscription backstop are mutually
//      idempotent: firing both events back-to-back never invokes
//      handlePaymentSucceeded twice (the second call's pending→paid
//      claim returns count:0 — that idempotency is exercised at the
//      handlePaymentSucceeded layer; here we assert the DISPATCHER
//      makes the call once per event without double-invocation in a
//      single dispatch).
//   5. Replay: a duplicate Stripe event id is short-circuited by the
//      StripeProcessedEvent fast-path before any side-effect fires.

function makePrisma(sentinels: Array<any>) {
  const processed: any[] = [];
  const stub: any = {
    _processed: processed,
    _sentinels: sentinels,
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
    guestCheckout: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.stripe_payment_intent_id) {
          return (
            sentinels.find(
              (s) => s.stripe_payment_intent_id === where.stripe_payment_intent_id,
            ) ?? null
          );
        }
        if (where.stripe_subscription_id) {
          return (
            sentinels.find(
              (s) => s.stripe_subscription_id === where.stripe_subscription_id,
            ) ?? null
          );
        }
        return null;
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

describe('PR-14 R2 — Guest recurring dispatcher integration (BillingService.handleEvent)', () => {
  let prisma: any;
  let guestCheckout: any;
  let checkoutWebhooks: any;
  let svc: BillingService;
  const sentinels: any[] = [
    {
      id: 'gc-rec-1',
      stripe_payment_intent_id: 'pi_first_invoice',
      stripe_subscription_id: 'sub_guest_rec',
      stripe_customer_id: 'cus_g',
      status: 'pending',
    },
  ];

  beforeEach(() => {
    prisma = makePrisma(sentinels);
    guestCheckout = {
      handlePaymentSucceeded: jest.fn().mockResolvedValue(undefined),
      handlePaymentFailed: jest.fn().mockResolvedValue(undefined),
      handleChargeRefunded: jest.fn().mockResolvedValue({ claimed: false }),
      handleDisputeOpened: jest.fn().mockResolvedValue({ claimed: false }),
      resolveReceiptUrl: jest.fn().mockResolvedValue(null),
    };
    checkoutWebhooks = {
      handle: jest.fn().mockResolvedValue({ claimed: false }),
    };
    svc = new BillingService(
      prisma,
      { capture: jest.fn(), identify: jest.fn() } as any,
      { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any,
      undefined, // connect
      checkoutWebhooks,
      undefined, // email
      guestCheckout,
    );
  });

  it('payment_intent.succeeded with NO guest metadata routes to handlePaymentSucceeded via the PI-by-sentinel-id fallback (primary R2 fix)', async () => {
    const res = await svc.handleEvent({
      id: 'evt_pi_succeeded_rec',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_first_invoice',
          // CRITICAL: no GUEST_CHECKOUT_METADATA_KEY — this is what
          // Stripe actually sends for a subscription's first-invoice PI.
          metadata: {},
          latest_charge: 'ch_first_invoice',
        },
      },
    });
    expect(res.processed).toBe(true);
    // The fallback found the sentinel by PI id and routed.
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledWith(
      'pi_first_invoice',
      expect.objectContaining({}),
    );
  });

  it('payment_intent.succeeded WITH guest metadata still routes (preserves the one-time path, no regression)', async () => {
    const res = await svc.handleEvent({
      id: 'evt_pi_succeeded_one_time',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_one_time',
          metadata: { [GUEST_CHECKOUT_METADATA_KEY]: 'idem-key-1' },
          latest_charge: 'ch_one_time',
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
  });

  it('payment_intent.succeeded for a UNRELATED PI (no sentinel match) does NOT invoke handlePaymentSucceeded', async () => {
    const res = await svc.handleEvent({
      id: 'evt_pi_unrelated',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_unknown_xxx',
          metadata: {},
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('payment_intent.payment_failed with NO guest metadata but matching sentinel routes to handlePaymentFailed (PI-by-sentinel-id fallback on the failed path too)', async () => {
    const res = await svc.handleEvent({
      id: 'evt_pi_failed',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_first_invoice',
          metadata: {},
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentFailed).toHaveBeenCalledTimes(1);
    expect(guestCheckout.handlePaymentFailed).toHaveBeenCalledWith('pi_first_invoice');
  });

  it('customer.subscription.updated for a recurring guest sentinel drives handlePaymentSucceeded via the subscription BACKSTOP after the outer tx commits', async () => {
    const res = await svc.handleEvent({
      id: 'evt_sub_updated',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_guest_rec',
          customer: 'cus_g',
          status: 'active',
        },
      },
    });
    expect(res.processed).toBe(true);
    // Backstop fired against the sentinel's persisted PI id.
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledWith(
      'pi_first_invoice',
    );
  });

  it('invoice.paid for a recurring guest sentinel also routes via the subscription BACKSTOP (string subscription id)', async () => {
    const res = await svc.handleEvent({
      id: 'evt_inv_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_first',
          subscription: 'sub_guest_rec',
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledWith(
      'pi_first_invoice',
    );
  });

  it('subscription BACKSTOP is SKIPPED when the sentinel has already moved past pending (already converted)', async () => {
    // Mutate sentinel to converted; the maybeResolveGuestBySubscriptionEvent
    // helper short-circuits on non-pending statuses.
    sentinels[0].status = 'converted';
    const res = await svc.handleEvent({
      id: 'evt_sub_updated_skipped',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_guest_rec',
          customer: 'cus_g',
          status: 'active',
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
    // Restore for the next test.
    sentinels[0].status = 'pending';
  });

  it('subscription BACKSTOP is SKIPPED when the sentinel still has the synthetic pending_<key> PI placeholder (no real PI to resume against)', async () => {
    sentinels[0].stripe_payment_intent_id = 'pending_idem-key';
    const res = await svc.handleEvent({
      id: 'evt_sub_updated_synthetic_pi',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_guest_rec',
          customer: 'cus_g',
          status: 'active',
        },
      },
    });
    expect(res.processed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
    // Restore.
    sentinels[0].stripe_payment_intent_id = 'pi_first_invoice';
  });

  it('duplicate Stripe event id is short-circuited by StripeProcessedEvent — handlePaymentSucceeded is NOT invoked a second time', async () => {
    // First delivery — fires fallback.
    await svc.handleEvent({
      id: 'evt_pi_dup',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_first_invoice', metadata: {} },
      },
    });
    expect(guestCheckout.handlePaymentSucceeded).toHaveBeenCalledTimes(1);
    // Reset the call history but DO NOT clear the processed-events store.
    guestCheckout.handlePaymentSucceeded.mockClear();
    // Second delivery — same event id; the fast-path dedup short-circuits.
    const res = await svc.handleEvent({
      id: 'evt_pi_dup',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_first_invoice', metadata: {} },
      },
    });
    expect(res.processed).toBe(false);
    expect((res as any).alreadyProcessed).toBe(true);
    expect(guestCheckout.handlePaymentSucceeded).not.toHaveBeenCalled();
  });
});
