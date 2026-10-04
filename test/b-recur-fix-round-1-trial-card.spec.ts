// B-RECUR-BE fix round 1 (agent 114) — the card a native trial saves, and
// the two audit Cs on reuse / replay. Every case marked (failed before)
// failed at 486164688 src:
//   B-654-1 a trial started only if Stripe itself set the subscription's
//           default card after the SetupIntent. Stripe does not promise that
//           for a $0 trial, and nulls `pending_setup_intent` once the
//           SetupIntent succeeds, so: no webhook set the default, the plan
//           read backstop could not see the card, and both the stale-trial
//           cleanup and the open-attempt reuse CANCELED a trial whose card
//           was saved;
//   C-654-2 an open trial attempt was reused after the coach changed or
//           removed the trial;
//   C-654-3 a same-key replay handed back a spent SetupIntent / PaymentIntent
//           secret.
//
// B-RECUR6B-118 (size): the checkout-service cases (setupIntentIdOf, the
// checkout paths, C-654-2, C-654-3) moved unchanged to #696
// test/b-recur-fix-round-1-trial-card-checkout.spec.ts; the webhook cases
// stay here.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const DAY = 86400;

describe('B-654-1 setup_intent.succeeded makes the saved card the default', () => {
  function webhookSetup(rowOver: Record<string, unknown> = {}) {
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
      ...rowOver,
    });
    const liveSub = {
      id: 'sub_t',
      status: 'trialing',
      default_payment_method: null as string | null,
      // The create-time trial end (R1); the trial-card attach lifts it.
      cancel_at_period_end: true,
      pending_setup_intent: null,
      current_period_end: Math.floor(Date.now() / 1000) + 7 * DAY,
    };
    const stripe: any = {
      retrieveSubscription: jest.fn(),
      retrieveSubscriptionForCheckout: jest.fn(async () => liveSub),
      setSubscriptionDefaultPaymentMethod: jest.fn(async (a: any) => {
        liveSub.default_payment_method = a.paymentMethodId;
        if (a.liftTrialEnd) liveSub.cancel_at_period_end = false;
        return liveSub;
      }),
    };
    const fanout: any = {
      onPurchaseEntitled: jest.fn(async () => undefined),
      cancelPendingForPurchase: jest.fn(async () => 0),
    };
    const splits: any = { onChargeSucceeded: jest.fn() };
    const dunning: any = {
      recordFailure: jest.fn(),
      recordResolution: jest.fn(async () => null),
      terminate: jest.fn(),
    };
    const svc = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout);
    return { svc, prisma, stripe, liveSub, row: () => prisma._purchases[0] };
  }
  const siEvent = (over: Record<string, unknown> = {}) => ({
    id: `evt_${Math.random()}`,
    type: 'setup_intent.succeeded',
    data: {
      object: {
        id: 'seti_T1',
        status: 'succeeded',
        payment_method: 'pm_card',
        customer: 'cus_1',
        ...over,
      },
    },
  });

  it('(failed before) sets default_payment_method out-of-tx, idempotently; the next subscription.updated grants the trial', async () => {
    const { svc, prisma, stripe, liveSub, row } = webhookSetup();
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    expect(stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith({
      subscriptionId: 'sub_t',
      paymentMethodId: 'pm_card',
      idempotencyKey: 'tgp-trial-card-sub_t-pm_card',
      liftTrialEnd: true,
    });
    const r = await svc.handle(ev, prisma, pre);
    expect(r.claimed).toBe(true);
    // Stripe's answer to the write: customer.subscription.updated with the default.
    await svc.handle(
      { id: 'evt_su', type: 'customer.subscription.updated', data: { object: { ...liveSub } } },
      prisma,
    );
    expect(row().entitlement_active).toBe(true);
    expect(row().trial_started_at).toBeInstanceOf(Date);
  });

  it('(failed before) a failed Stripe write throws in handle so Stripe redelivers', async () => {
    const { svc, prisma, stripe } = webhookSetup();
    stripe.setSubscriptionDefaultPaymentMethod.mockRejectedValueOnce(new Error('stripe down'));
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    await expect(svc.handle(ev, prisma, pre)).rejects.toThrow(/redeliver/);
  });

  it('a SetupIntent that is not a native trial attempt is not claimed and writes nothing', async () => {
    const { svc, prisma, stripe } = webhookSetup();
    const ev = siEvent({ id: 'seti_OTHER' });
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(false);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it("another customer's SetupIntent never touches the attempt", async () => {
    const { svc, prisma, stripe } = webhookSetup();
    const ev = siEvent({ customer: 'cus_other' });
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(false);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('an already granted trial is claimed without another Stripe write', async () => {
    const { svc, prisma, stripe } = webhookSetup({
      entitlement_active: true,
      trial_started_at: new Date(),
    });
    const ev = siEvent();
    const pre = await svc.prefetchForOuterTx(ev);
    expect((await svc.handle(ev, prisma, pre)).claimed).toBe(true);
    expect(stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});
