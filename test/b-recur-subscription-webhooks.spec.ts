// B-RECUR (agent 113) — webhook lifecycle of a NATIVE subscription purchase
// (POST /v1/checkout/subscription-intent row: billing_type recurring,
// stripe_subscription_id + first-invoice PaymentIntent set, status pending).
//   first invoice paid -> entitlement + content + settlement of that charge
//   payment_intent.succeeded of that invoice -> no second activation path
//   renewal invoice.paid -> settled once per charge, no re-seed
//   first-attempt decline -> no dunning; renewal decline -> dunning hook
//   cancel_at_period_end -> access through the period; deleted -> revoked
//   trials: card saved -> trialing access; trial -> paid conversion settles;
//   cancel in trial -> never charged
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const DAY = 86400;

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
    idempotency_key: 'sub-client-k',
    created_at: new Date(),
    ...over,
  };
}

function setup(rowOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma._packages.push({
    id: 'pkg',
    billing_type: 'recurring',
    interval: 'month',
    duration_periods: null,
  });
  prisma._purchases.push(nativeRow(rowOver));
  const stripe: any = { retrieveSubscription: jest.fn() };
  const splits: any = {
    onChargeSucceeded: jest.fn(async () => ({
      charge_id: null,
      ledger_entries: 0,
      transfer_enqueued: false,
    })),
  };
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
  return { svc, prisma, stripe, splits, dunning, fanout, row: () => prisma._purchases[0] };
}

const tx = (prisma: any) => prisma; // the fake is its own transaction client

function sub(status: string, over: Record<string, unknown> = {}) {
  return {
    id: 'sub_n',
    status,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY,
    default_payment_method: 'pm_card',
    ...over,
  };
}

function invoicePaid(over: Record<string, unknown> = {}) {
  return {
    id: `evt_${Math.random()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_1',
        subscription: 'sub_n',
        amount_paid: 4900,
        charge: 'ch_first',
        billing_reason: 'subscription_create',
        ...over,
      },
    },
  };
}

describe('first invoice paid', () => {
  it('grants entitlement, seeds content once, and defers settlement of that exact charge', async () => {
    const { svc, prisma, splits, fanout, row } = setup();
    const result = await svc.handle(invoicePaid(), tx(prisma), {
      invoiceSubscription: sub('active'),
    });
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
    expect(row().access_expires_at).toBeInstanceOf(Date);
    expect(fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(fanout.onPurchaseEntitled.mock.calls[0][1].entrypoint).toBe('in_app_ps');
    // Settlement runs post-commit (no Stripe HTTP in the tx), for ch_first.
    expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
    expect(result.deferredSplit).toEqual(
      expect.objectContaining({ charge_id: 'ch_first', invoice_amount_cents: 4900 }),
    );
  });

  it('the first invoice PaymentIntent succeeding does NOT flip the plan to one-time "paid" or settle twice', async () => {
    const { svc, prisma, splits, fanout, row } = setup();
    const r = await svc.handle(
      { id: 'evt_pi', type: 'payment_intent.succeeded', data: { object: { id: 'pi_first' } } },
      tx(prisma),
    );
    expect(r).toEqual(
      expect.objectContaining({
        claimed: true,
        reason: 'subscription_invoice_owned_by_invoice_paid',
      }),
    );
    expect(row().status).toBe('pending');
    expect(row().entitlement_active).toBe(false);
    expect(r.deferredSplit).toBeUndefined();
    expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
    expect(fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('subscription.updated (active) winning the race also grants and seeds; invoice.paid after it does not re-seed', async () => {
    const { svc, prisma, fanout, row } = setup();
    await svc.handle(
      { id: 'evt_su', type: 'customer.subscription.updated', data: { object: sub('active') } },
      tx(prisma),
    );
    expect(row().entitlement_active).toBe(true);
    expect(fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    const r = await svc.handle(invoicePaid(), tx(prisma), { invoiceSubscription: sub('active') });
    expect(fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
    expect(r.deferredSplit?.charge_id).toBe('ch_first');
  });

  it('an outer tx without the prefetched subscription THROWS for a not-yet-entitled plan (Stripe redelivers)', async () => {
    const { svc, prisma, row } = setup();
    await expect(svc.handle(invoicePaid(), tx(prisma), {})).rejects.toThrow(/retry/);
    expect(row().entitlement_active).toBe(false);
  });

  it('entitlement is never granted from an incomplete subscription', async () => {
    const { svc, prisma, row } = setup();
    await svc.handle(
      {
        id: 'evt_c',
        type: 'customer.subscription.created',
        data: { object: sub('incomplete', { default_payment_method: null }) },
      },
      tx(prisma),
    );
    expect(row().entitlement_active).toBe(false);
  });
});

describe('renewals', () => {
  it('each renewal invoice.paid settles its own charge once and never re-seeds content', async () => {
    const { svc, prisma, fanout, row } = setup({ status: 'active', entitlement_active: true });
    const r = await svc.handle(
      invoicePaid({ id: 'in_2', charge: 'ch_renew', billing_reason: 'subscription_cycle' }),
      tx(prisma),
      { invoiceSubscription: sub('active') },
    );
    expect(r.deferredSplit).toEqual(
      expect.objectContaining({ charge_id: 'ch_renew', invoice_amount_cents: 4900 }),
    );
    expect(fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(row().entitlement_active).toBe(true);
  });

  it('a renewal decline flows into dunning (past_due, access kept, recordFailure)', async () => {
    const { svc, dunning, row } = setup({ status: 'active', entitlement_active: true });
    await svc.handle({
      id: 'evt_f',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_3',
          subscription: 'sub_n',
          amount_due: 4900,
          attempt_count: 1,
          billing_reason: 'subscription_cycle',
          last_payment_error: { message: 'Your card was declined.' },
        },
      },
    });
    expect(row().status).toBe('past_due');
    expect(row().entitlement_active).toBe(true);
    expect(dunning.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_invoice_id: 'in_3',
        amount_due_cents: 4900,
        attempt_number: 1,
      }),
    );
  });

  it('a decline on the FIRST attempt (client still in the sheet) is not dunning', async () => {
    const { svc, dunning, row } = setup();
    const r = await svc.handle({
      id: 'evt_f1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          subscription: 'sub_n',
          amount_due: 4900,
          billing_reason: 'subscription_create',
          last_payment_error: { message: 'Your card was declined.' },
        },
      },
    });
    expect(r.reason).toBe('first_attempt_declined');
    expect(row().status).toBe('pending');
    expect(row().last_error).toBe('Your card was declined.');
    expect(dunning.recordFailure).not.toHaveBeenCalled();
  });
});

describe('cancel at period end', () => {
  it('cancel_at_period_end keeps access through the paid period; deletion at period end revokes', async () => {
    const end = Math.floor(Date.now() / 1000) + 12 * DAY;
    const { svc, prisma, fanout, dunning, row } = setup({
      status: 'active',
      entitlement_active: true,
    });
    await svc.handle(
      {
        id: 'evt_cape',
        type: 'customer.subscription.updated',
        data: { object: sub('active', { cancel_at_period_end: true, current_period_end: end }) },
      },
      tx(prisma),
    );
    expect(row()).toEqual(
      expect.objectContaining({ entitlement_active: true, cancel_at_period_end: true }),
    );
    expect(row().current_period_end.getTime()).toBe(end * 1000);
    await svc.handle(
      {
        id: 'evt_del',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_n', canceled_at: end } },
      },
      tx(prisma),
    );
    expect(row()).toEqual(
      expect.objectContaining({ status: 'canceled', entitlement_active: false }),
    );
    expect(fanout.cancelPendingForPurchase).toHaveBeenCalledWith(
      'cp_native',
      'subscription_canceled',
      prisma,
    );
    expect(dunning.terminate).toHaveBeenCalledWith('cp_native', 'subscription_deleted');
  });
});

describe('free trials', () => {
  const trialEnd = () => Math.floor(Date.now() / 1000) + 7 * DAY;

  it('a trialing subscription grants NOTHING until the card is saved', async () => {
    const { svc, prisma, fanout, row } = setup({ trial_days: 7 });
    await svc.handle(
      {
        id: 'evt_t0',
        type: 'customer.subscription.created',
        data: {
          object: sub('trialing', { default_payment_method: null, current_period_end: trialEnd() }),
        },
      },
      tx(prisma),
    );
    // The $0 trial invoice is paid at creation; still no access, no settlement amount.
    const r = await svc.handle(invoicePaid({ amount_paid: 0, charge: null }), tx(prisma), {
      invoiceSubscription: sub('trialing', {
        default_payment_method: null,
        current_period_end: trialEnd(),
      }),
    });
    expect(row().entitlement_active).toBe(false);
    expect(row().trial_started_at).toBeNull();
    expect(fanout.onPurchaseEntitled).not.toHaveBeenCalled();
    expect(r.deferredSplit?.invoice_amount_cents).toBe(0);
  });

  it('card saved -> trialing access, trial_started_at stamped (the one-trial marker), content seeded', async () => {
    const { svc, prisma, fanout, row } = setup({ trial_days: 7 });
    await svc.handle(
      {
        id: 'evt_t1',
        type: 'customer.subscription.updated',
        data: {
          object: sub('trialing', {
            default_payment_method: 'pm_card',
            current_period_end: trialEnd(),
          }),
        },
      },
      tx(prisma),
    );
    expect(row()).toEqual(
      expect.objectContaining({ status: 'trialing', entitlement_active: true }),
    );
    expect(row().trial_started_at).toBeInstanceOf(Date);
    expect(fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('trial -> paid: the first real invoice after the trial settles via #627 like any renewal', async () => {
    const { svc, prisma, fanout, row } = setup({
      trial_days: 7,
      trial_started_at: new Date(),
      status: 'trialing',
      entitlement_active: true,
    });
    const r = await svc.handle(
      invoicePaid({
        id: 'in_after_trial',
        charge: 'ch_after_trial',
        billing_reason: 'subscription_cycle',
      }),
      tx(prisma),
      { invoiceSubscription: sub('active') },
    );
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
    expect(r.deferredSplit).toEqual(
      expect.objectContaining({ charge_id: 'ch_after_trial', invoice_amount_cents: 4900 }),
    );
    expect(fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('cancel during the trial: access until trial end, then revoked, never charged', async () => {
    const end = trialEnd();
    const { svc, prisma, splits, row } = setup({
      trial_days: 7,
      trial_started_at: new Date(),
      status: 'trialing',
      entitlement_active: true,
    });
    await svc.handle(
      {
        id: 'evt_tc',
        type: 'customer.subscription.updated',
        data: { object: sub('trialing', { cancel_at_period_end: true, current_period_end: end }) },
      },
      tx(prisma),
    );
    expect(row()).toEqual(
      expect.objectContaining({ entitlement_active: true, cancel_at_period_end: true }),
    );
    await svc.handle(
      {
        id: 'evt_td',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_n', canceled_at: end } },
      },
      tx(prisma),
    );
    expect(row()).toEqual(
      expect.objectContaining({ status: 'canceled', entitlement_active: false }),
    );
    expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
  });

  it('a trial that ends without a card never opens dunning', async () => {
    const { svc, dunning, row } = setup({ trial_days: 7 });
    await svc.handle({
      id: 'evt_tf',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_x', subscription: 'sub_n', billing_reason: 'subscription_cycle' } },
    });
    expect(dunning.recordFailure).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');
  });
});
