// B-RECUR-BE fix round 1 (agent 114) — gaps closed in the native
// subscription checkout (#654). Every case here failed before this round:
//   R1-7 payment_intent.payment_failed on a subscription's FIRST invoice
//        flipped the attempt to 'payment_failed' (coach "failed payments"
//        roster) although invoice.payment_failed owns subscription rows;
//   R1-8 customer.subscription.deleted on a never-paid attempt wrote
//        'canceled' (churn readers, client plan list) instead of 'expired'.
// B-RECUR5B-117 (agent 117) — R1-1..R1-6 (checkout service) moved unchanged
// to test/b-recur-fix-round-1-checkout.spec.ts on #696 (size: #680 keeps
// the webhook cases).
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

// ── webhooks ────────────────────────────────────────────────────────────

function nativeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cp_native',
    client_user_id: 'client',
    coach_user_id: 'coach',
    package_id: 'pkg',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_checkout_session_id: 'sub_n',
    stripe_subscription_id: 'sub_n',
    stripe_payment_intent_id: 'pi_first',
    stripe_customer_id: 'cus_1',
    status: 'pending',
    entitlement_active: false,
    cancel_at_period_end: false,
    current_period_end: null,
    canceled_at: null,
    trial_days: null,
    trial_started_at: null,
    last_error: null,
    idempotency_key: 'sub-client-k',
    created_at: new Date(),
    ...over,
  };
}

function webhookSetup(rowOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma._packages.push({
    id: 'pkg',
    billing_type: 'recurring',
    interval: 'month',
    duration_periods: null,
  });
  prisma._purchases.push(nativeRow(rowOver));
  const stripe: any = { retrieveSubscription: jest.fn() };
  const splits: any = { onChargeSucceeded: jest.fn() };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const svc = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout);
  return { svc, prisma, dunning, fanout, row: () => prisma._purchases[0] };
}

describe('R1-7 payment_intent.payment_failed on a subscription first invoice', () => {
  it('records the decline only: no payment_failed status, no access change, no dunning', async () => {
    const { svc, prisma, dunning, row } = webhookSetup();
    const r = await svc.handle(
      {
        id: 'evt_pif',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_first',
            last_payment_error: { message: 'Your card was declined.' },
          },
        },
      },
      prisma,
    );
    expect(r.claimed).toBe(true);
    expect(r.reason).toBe('subscription_invoice_owned_by_invoice_events');
    expect(row().status).toBe('pending');
    expect(row().entitlement_active).toBe(false);
    expect(row().last_error).toBe('Your card was declined.');
    expect(dunning.recordFailure).not.toHaveBeenCalled();
  });
});

describe('R1-8 customer.subscription.deleted', () => {
  it.each(['pending', 'incomplete', 'trialing', 'expired'])(
    'never-paid native attempt (%s) -> expired, not canceled; nothing to revoke',
    async (status) => {
      const { svc, prisma, fanout, row } = webhookSetup({ status });
      await svc.handle(
        { id: 'evt_d', type: 'customer.subscription.deleted', data: { object: { id: 'sub_n' } } },
        prisma,
      );
      expect(row().status).toBe('expired');
      expect(row().entitlement_active).toBe(false);
      expect(fanout.cancelPendingForPurchase).not.toHaveBeenCalled();
    },
  );

  it('a plan that was paid -> canceled (churn) and its drops are canceled', async () => {
    const { svc, prisma, fanout, row } = webhookSetup({
      status: 'active',
      entitlement_active: true,
    });
    await svc.handle(
      { id: 'evt_d2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_n' } } },
      prisma,
    );
    expect(row().status).toBe('canceled');
    expect(fanout.cancelPendingForPurchase).toHaveBeenCalled();
  });

  it('a trial that started then ended -> canceled (it was a real plan)', async () => {
    const { svc, prisma, row } = webhookSetup({
      status: 'trialing',
      entitlement_active: false,
      trial_days: 7,
      trial_started_at: new Date(),
    });
    await svc.handle(
      { id: 'evt_d3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_n' } } },
      prisma,
    );
    expect(row().status).toBe('canceled');
  });
});
