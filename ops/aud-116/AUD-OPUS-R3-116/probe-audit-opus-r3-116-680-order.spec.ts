// AUD-OPUS-R3-116 probe (audit only, never merge) — backend #680 @ 2b10687c.
// Stripe does not deliver webhook events in order, and a failed delivery is
// retried later (minutes to days). These cases deliver the events of ONE
// native subscription checkout in an order Stripe allows and assert the
// purchase ends in the state Stripe ends in.
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
    last_error: null,
    idempotency_key: 'sub-client-k',
    created_at: new Date(),
    ...over,
  };
}

function setup(rowOver: Record<string, unknown> = {}) {
  const prisma = makeFakePrisma();
  prisma._packages.push({ id: 'pkg', billing_type: 'recurring', interval: 'month', duration_periods: null });
  prisma._purchases.push(nativeRow(rowOver));
  const stripe: any = { retrieveSubscription: jest.fn() };
  const splits: any = {
    onChargeSucceeded: jest.fn(async () => ({ charge_id: null, ledger_entries: 0, transfer_enqueued: false })),
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
  return { svc, prisma, dunning, row: () => prisma._purchases[0] };
}

const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_n',
  status,
  customer: 'cus_1',
  current_period_end: Math.floor(Date.now() / 1000) + 30 * DAY,
  default_payment_method: 'pm_card',
  ...over,
});
const ev = (type: string, object: Record<string, unknown>) => ({ id: `evt_${Math.random()}`, type, data: { object } });
const firstInvoicePaid = () =>
  ev('invoice.paid', { id: 'in_1', subscription: 'sub_n', amount_paid: 4900, charge: 'ch_first', billing_reason: 'subscription_create' });
const createdIncomplete = () => ev('customer.subscription.created', sub('incomplete', { default_payment_method: null }));

describe('AUD-OPUS-R3-116 B-680-1: a late customer.subscription.created (incomplete) never undoes a paid first invoice', () => {
  it('(probe) invoice.paid granted access, then the created event (first delivery failed, retried later) arrives', async () => {
    const { svc, prisma, row } = setup();
    await svc.handle(firstInvoicePaid(), prisma, { invoiceSubscription: sub('active') });
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
    await svc.handle(createdIncomplete(), prisma);
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
  });

  it('(probe) subscription.updated (active) granted access, then the stale created event arrives', async () => {
    const { svc, prisma, row } = setup();
    await svc.handle(ev('customer.subscription.updated', sub('active')), prisma);
    expect(row().entitlement_active).toBe(true);
    await svc.handle(createdIncomplete(), prisma);
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
  });

  it('control: in order (created, then invoice.paid) grants access', async () => {
    const { svc, prisma, row } = setup();
    await svc.handle(createdIncomplete(), prisma);
    expect(row().entitlement_active).toBe(false);
    await svc.handle(firstInvoicePaid(), prisma, { invoiceSubscription: sub('active') });
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true }));
  });
});

describe('AUD-OPUS-R3-116 B-680-2: a late first-invoice decline never puts a paid plan into dunning', () => {
  const firstDecline = () =>
    ev('invoice.payment_failed', {
      id: 'in_1',
      subscription: 'sub_n',
      amount_due: 4900,
      attempt_count: 1,
      billing_reason: 'subscription_create',
      last_payment_error: { message: 'Your card was declined.' },
    });

  it('(probe) card declined in the sheet, second card paid; the decline is delivered after invoice.paid', async () => {
    const { svc, prisma, dunning, row } = setup();
    await svc.handle(firstInvoicePaid(), prisma, { invoiceSubscription: sub('active') });
    await svc.handle(firstDecline(), prisma);
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true, last_error: null }));
    expect(dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(probe) the first-invoice PaymentIntent decline delivered after invoice.paid leaves no decline on the paid plan', async () => {
    const { svc, prisma, row } = setup();
    await svc.handle(firstInvoicePaid(), prisma, { invoiceSubscription: sub('active') });
    await svc.handle(
      ev('payment_intent.payment_failed', { id: 'pi_first', last_payment_error: { message: 'Your card was declined.' } }),
      prisma,
    );
    expect(row()).toEqual(expect.objectContaining({ status: 'active', entitlement_active: true, last_error: null }));
  });

  it('control: a renewal decline on a running plan still enters dunning', async () => {
    const { svc, prisma, dunning, row } = setup({ status: 'active', entitlement_active: true });
    await svc.handle(
      ev('invoice.payment_failed', { id: 'in_2', subscription: 'sub_n', amount_due: 4900, attempt_count: 1, billing_reason: 'subscription_cycle' }),
      prisma,
    );
    expect(row().status).toBe('past_due');
    expect(dunning.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-OPUS-R3-116 C-680-3: a canceled plan is not re-granted by a stale subscription event (pre-existing)', () => {
  it('(probe) deleted, then a stale updated (past_due) arrives', async () => {
    const { svc, prisma, row } = setup({ status: 'past_due', entitlement_active: true });
    await svc.handle(ev('customer.subscription.deleted', sub('canceled', { canceled_at: Math.floor(Date.now() / 1000) })), prisma);
    expect(row().entitlement_active).toBe(false);
    await svc.handle(ev('customer.subscription.updated', sub('past_due')), prisma);
    expect(row()).toEqual(expect.objectContaining({ status: 'canceled', entitlement_active: false }));
  });
});

describe('AUD-OPUS-R3-116 C-680-4: an attempt bound by the webhook fallback is still a native attempt', () => {
  it('(probe) uncertain create (row unbound, retry marker); created event binds it; the abandoned attempt ends as expired', async () => {
    const { svc, prisma, row } = setup({
      stripe_subscription_id: null,
      stripe_payment_intent_id: null,
      stripe_checkout_session_id: 'sub-retry-sub-client-k',
    });
    const meta = {
      tgp_package_id: 'pkg',
      tgp_client_user_id: 'client',
      tgp_coach_user_id: 'coach',
      tgp_purchase_id: 'cp_native',
    };
    await svc.handle(ev('customer.subscription.created', sub('incomplete', { default_payment_method: null, metadata: meta })), prisma);
    expect(row().stripe_subscription_id).toBe('sub_n');
    await svc.handle(ev('customer.subscription.deleted', sub('incomplete_expired', { metadata: meta })), prisma);
    expect(row().status).toBe('expired');
  });
});

describe('AUD-OPUS-R3-116 B-680-1 consequence: the paying client is offered (and charged) a second subscription', () => {
  // Service harness as in test/b-recur-116-fix-round-3.spec.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SubscriptionCheckoutService } = require('../src/checkout/subscription-checkout.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeCheckoutHelpers, makeFakeStripe } = require('./support/b-recur-fakes');
  const CLIENT = '11111111-1111-4111-8111-111111111111';
  const COACH = '22222222-2222-4222-8222-222222222222';
  const PKG = '33333333-3333-4333-8333-333333333333';

  beforeAll(() => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_example';
  });

  it('(probe) paid, then the stale created event; a day later the client taps subscribe again', async () => {
    const prisma = makeFakePrisma();
    const stripe = makeFakeStripe();
    prisma._users.push(
      { id: CLIENT, email: 'c@example.test', name: 'Client', coach_id: COACH },
      { id: COACH, email: 'k@example.test', name: 'Coach', coach_id: null },
    );
    prisma._packages.push({
      id: PKG, coach_id: COACH, name: 'Coaching', amount_cents: 4900, currency: 'usd',
      billing_type: 'recurring', interval: 'month', interval_count: 1,
      recurring_amount_cents: null, recurring_interval: null, recurring_interval_count: null,
      recurring_stripe_price_id: null, stripe_price_id: 'price_rec_4900', is_active: true,
      archived_at: null, published_at: new Date('2026-09-01'),
    });
    prisma._accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true, deauthorized_at: null });
    const packages: any = { getById: jest.fn(async (id: string) => prisma._packages.find((p: any) => p.id === id) ?? null) };
    const feePolicy: any = { planFor: jest.fn(async () => ({ application_fee_cents: 98, head_coach_id: null })) };
    const checkoutSvc = new SubscriptionCheckoutService(prisma, stripe, packages, { ready: true }, feePolicy, makeCheckoutHelpers(prisma));
    const splits: any = { onChargeSucceeded: jest.fn(async () => ({ charge_id: null, ledger_entries: 0, transfer_enqueued: false })) };
    const dunning: any = { recordFailure: jest.fn(), recordResolution: jest.fn(async () => null), terminate: jest.fn(async () => null) };
    const fanout: any = { onPurchaseEntitled: jest.fn(async () => undefined), cancelPendingForPurchase: jest.fn(async () => 0) };
    const handler = new CheckoutWebhookHandlerService(prisma, stripe, splits, dunning, undefined, fanout);

    const first = await checkoutSvc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const subId = first.subscription_id;
    stripe._subs.get(subId).status = 'active';
    const live = (status: string, over: Record<string, unknown> = {}) => ({ ...sub(status, over), id: subId });
    await handler.handle(
      ev('invoice.paid', { id: 'in_1', subscription: subId, amount_paid: 4900, charge: 'ch_first', billing_reason: 'subscription_create' }),
      prisma,
      { invoiceSubscription: live('active') },
    );
    expect(prisma._purchases[0].entitlement_active).toBe(true);
    await handler.handle(ev('customer.subscription.created', live('incomplete', { default_payment_method: null })), prisma);
    prisma._purchases[0].created_at = new Date(Date.now() - 25 * 3600 * 1000);

    let code: string | undefined;
    try {
      await checkoutSvc.createSubscriptionIntent(CLIENT, { package_id: PKG, idempotency_key: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    } catch (e: any) {
      code = e.getResponse?.()?.code;
    }
    expect(stripe._subs.size).toBe(1);
    expect(code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');
  });
});

describe('AUD-OPUS-R3-116 B-680-2 variant: a late first-invoice decline of an ENDED attempt never starts dunning', () => {
  const lateDecline = () =>
    ev('invoice.payment_failed', { id: 'in_1', subscription: 'sub_n', amount_due: 4900, attempt_count: 1, billing_reason: 'subscription_create' });

  it('(probe) Stripe expired the abandoned attempt (updated -> incomplete_expired), then the decline is delivered', async () => {
    const { svc, prisma, dunning, row } = setup();
    await svc.handle(ev('customer.subscription.updated', sub('incomplete_expired', { default_payment_method: null })), prisma);
    expect(row().status).toBe('incomplete_expired');
    await svc.handle(lateDecline(), prisma);
    expect(row().status).toBe('incomplete_expired');
    expect(dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('(probe) the attempt was retired (expired), then the decline is delivered', async () => {
    const { svc, prisma, dunning, row } = setup({ status: 'expired' });
    await svc.handle(lateDecline(), prisma);
    expect(row().status).toBe('expired');
    expect(dunning.recordFailure).not.toHaveBeenCalled();
  });
});
