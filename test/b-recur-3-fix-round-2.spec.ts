// B-RECUR-3 fix round 2 (agent 115) — Sol's B-654-1 (narrowed), B-654-5,
// B-654-6, B-654-7 on backend#654 @795110b7, plus the plan read the app
// needs for mobile#334 B-334-3. Every case marked (failed before) failed at
// 795110b717b1554045d13bf596eeacb0c38f19c6:
//   B-654-1 a transient attempt lookup on setup_intent.succeeded answered
//           "not a native trial" (unclaimed), so BillingService marked the
//           only saved-card event processed with no card attached;
// B-RECUR5B-117 (agent 117) — the checkout-service cases of this round
// (B-654-5, B-654-6, B-654-7, B-334-3) moved unchanged to
// test/b-recur-3-fix-round-2-checkout.spec.ts on #696 (size: #680 keeps
// the webhook case).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

describe('B-654-1 (narrowed) a transient attempt lookup is never acknowledged', () => {
  function webhookSetup() {
    const prisma = makeFakePrisma();
    prisma._purchases.push({
      id: 'cp_trial',
      client_user_id: 'client',
      coach_user_id: 'coach',
      package_id: 'pkg',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      stripe_checkout_session_id: 'sub_t',
      stripe_subscription_id: 'sub_t',
      stripe_customer_id: 'cus_1',
      stripe_client_secret: 'seti_T1_secret_abc',
      status: 'trialing',
      entitlement_active: false,
      trial_days: 7,
      trial_started_at: null,
      idempotency_key: 'sub-client-k',
      created_at: new Date(),
    });
    const stripe: any = {
      retrieveSubscription: jest.fn(),
      retrieveSubscriptionForCheckout: jest.fn(async () => ({
        id: 'sub_t',
        status: 'trialing',
        default_payment_method: null,
        pending_setup_intent: null,
      })),
      setSubscriptionDefaultPaymentMethod: jest.fn(async () => ({ id: 'sub_t' })),
    };
    const fanout: any = {
      onPurchaseEntitled: jest.fn(async () => undefined),
      cancelPendingForPurchase: jest.fn(async () => 0),
    };
    const dunning: any = {
      recordFailure: jest.fn(),
      recordResolution: jest.fn(async () => null),
      terminate: jest.fn(),
    };
    const splits: any = { onChargeSucceeded: jest.fn() };
    const svc = new CheckoutWebhookHandlerService(
      prisma,
      stripe,
      splits,
      dunning,
      undefined,
      fanout,
    );
    return { svc, prisma, stripe };
  }
  const ev = () => ({
    id: `evt_${Math.random()}`,
    type: 'setup_intent.succeeded',
    data: {
      object: { id: 'seti_T1', status: 'succeeded', payment_method: 'pm_card', customer: 'cus_1' },
    },
  });

  it('(failed before) the lookup rejects once -> handle throws (outer tx rolls back, Stripe redelivers)', async () => {
    const { svc, prisma, stripe } = webhookSetup();
    const real = prisma.clientPurchase.findFirst.getMockImplementation();
    prisma.clientPurchase.findFirst.mockImplementationOnce(async () => {
      throw new Error('connection reset');
    });
    const e = ev();
    const pre = await svc.prefetchForOuterTx(e);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
    await expect(svc.handle(e, prisma, pre)).rejects.toThrow(/redeliver/);
    // The redelivery finds the attempt and attaches the card.
    prisma.clientPurchase.findFirst.mockImplementation(real);
    const e2 = ev();
    const pre2 = await svc.prefetchForOuterTx(e2);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect((await svc.handle(e2, prisma, pre2)).claimed).toBe(true);
  });

  it('a SetupIntent that is not a native trial is still unclaimed (no throw)', async () => {
    const { svc, prisma } = webhookSetup();
    const e = ev();
    e.data.object.id = 'seti_OTHER';
    const pre = await svc.prefetchForOuterTx(e);
    expect((await svc.handle(e, prisma, pre)).claimed).toBe(false);
  });
});
