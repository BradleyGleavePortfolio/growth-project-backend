// AUD-OPUS-R34D-119 probe (lens only, never merged). Harness copied from
// B-RECUR7B-119's b-recur7b-119-authority.spec.ts.
// ORIGINAL HEADER: B-RECUR7B-119 — #680 fix round 7. Sol R34 (agent 119) counterexamples
// (run 37228836878) and Opus C-680-11 / C-680-12 (run 37229300646) as
// regressions. Only Stripe and storage are doubles; the handler is the real
// implementation. `deliver` is the BillingService order: prefetch out of the
// transaction, then handle on it. Cases marked "(failed before)" fail on
// #680 @ 216489ff.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';
import { DunningV2Service } from '../src/checkout/dunning-v2/dunning-v2.service';

const NOW = Math.floor(Date.now() / 1000);
const PERIOD = NOW + 30 * 86400;
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_r34d_${seq}`, type, data: { object } };
};
const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_7b',
  status,
  customer: 'cus_7b',
  current_period_end: PERIOD,
  default_payment_method: 'pm_7b',
  cancel_at_period_end: false,
  ...over,
});
const paid = () =>
  ev('invoice.paid', {
    id: 'in_7b',
    subscription: 'sub_7b',
    amount_paid: 14800,
    currency: 'usd',
    charge: 'ch_7b',
    billing_reason: 'subscription_cycle',
  });
const declined = () =>
  ev('invoice.payment_failed', {
    id: 'in_7b',
    subscription: 'sub_7b',
    amount_due: 14800,
    attempt_count: 2,
    billing_reason: 'subscription_cycle',
    last_payment_error: { message: 'Your card was declined.' },
  });

function harness(over: Record<string, unknown> = {}, opts: { dunningState?: boolean } = {}) {
  const db = makeFakePrisma();
  const states: any[] = opts.dunningState
    ? [{ id: 'ds_1', purchase_id: 'cp_7b', status: 'resolved', locked_out_at: null }]
    : [];
  db.dunningState = {
    findUnique: jest.fn(async ({ where }: any) => states.find((s) => s.purchase_id === where.purchase_id) ?? null),
    update: jest.fn(async ({ where, data }: any) => Object.assign(states.find((s) => s.id === where.id), data)),
  };
  db.dunningAttempt = { findMany: jest.fn(async () => []) };
  db.notification = { updateMany: jest.fn(async () => ({ count: 0 })) };
  db.paymentRecoveryToken = { updateMany: jest.fn(async () => ({ count: 0 })) };
  db._packages.push({ id: 'pkg_7b', billing_type: 'recurring', duration_periods: null });
  db._purchases.push({
    id: 'cp_7b',
    package_id: 'pkg_7b',
    client_user_id: 'client_7b',
    coach_user_id: 'coach_7b',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: 'sub_7b',
    stripe_checkout_session_id: 'sub_7b',
    stripe_payment_intent_id: 'pi_7b',
    stripe_customer_id: 'cus_7b',
    stripe_client_secret: 'pi_7b_secret_x',
    stripe_ephemeral_key: 'ek_7b',
    status: 'active',
    entitlement_active: true,
    trial_days: null,
    trial_started_at: null,
    current_period_end: new Date(PERIOD * 1000),
    access_expires_at: new Date((PERIOD + 86400) * 1000),
    canceled_at: null,
    cancel_at_period_end: false,
    last_error: null,
    idempotency_key: 'sub-7b',
    // Older than any write below, so every write moves the version.
    created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(Date.now() - 60_000),
    ...over,
  });
  let live: Record<string, unknown> = sub('active');
  let invoiceStatus = 'open';
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_7b', status: invoiceStatus })),
  };
  const splits: any = { onChargeSucceeded: jest.fn(async () => undefined) };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const telemetry: any = { recovered: jest.fn(), lockoutExited: jest.fn() };
  const dunningV2 = new DunningV2Service(db, telemetry);
  const svc = new CheckoutWebhookHandlerService(
    db, stripe, splits, dunning, undefined, fanout, undefined, dunningV2, undefined,
  );
  const deliver = async (e: ReturnType<typeof ev>) =>
    svc.handle(e, db, await svc.prefetchForOuterTx(e));
  return {
    db,
    svc,
    deliver,
    fanout,
    dunning,
    row: () => db._purchases[0],
    setLive: (s: Record<string, unknown>) => {
      live = s;
    },
    setInvoice: (status: string) => {
      invoiceStatus = status;
    },
    // What the refund / dispute handler writes (refund-dispute-handler.service.ts).
    revoke: (status: string) => {
      Object.assign(db._purchases[0], {
        status,
        entitlement_active: false,
        updated_at: new Date(),
      });
    },
  };
}


const REVOKED_NO_ACCESS = ['refunded', 'chargeback_lost', 'disputed', 'canceled'];

describe('AUD-OPUS-R34D-119 C-680-18: post-fence dunning v2 clear on a revoked plan', () => {
  const prev = process.env.FEATURE_DUNNING_V2;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prev;
  });

  it.each(REVOKED_NO_ACCESS)('control (flag off): %s + invoice.paid + sub.updated stays revoked', async (status) => {
    delete process.env.FEATURE_DUNNING_V2;
    const h = harness({ status, entitlement_active: false }, { dunningState: true });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status, entitlement_active: false });
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row()).toMatchObject({ status, entitlement_active: false });
  });

  it.each(REVOKED_NO_ACCESS)('EXPECTED RED (flag on): %s + invoice.paid keeps entitlement off', async (status) => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const h = harness({ status, entitlement_active: false }, { dunningState: true });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status, entitlement_active: false });
  });

  it.each(['refunded', 'chargeback_lost', 'disputed'])(
    'EXPECTED RED (flag on): %s + invoice.paid then sub.updated(active) never reopens the plan',
    async (status) => {
      process.env.FEATURE_DUNNING_V2 = 'true';
      const h = harness({ status, entitlement_active: false }, { dunningState: true });
      await h.deliver(paid());
      h.row().updated_at = new Date(Date.now() - 30_000);
      await h.deliver(ev('customer.subscription.updated', sub('active')));
      expect(h.row().status).toBe(status);
      expect(h.row().entitlement_active).toBe(false);
    },
  );

  it('control (flag on): no DunningState row: refunded + invoice.paid stays revoked', async () => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const h = harness({ status: 'refunded', entitlement_active: false });
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'refunded', entitlement_active: false });
  });

  it('control (flag on): an active plan in dunning recovers on invoice.paid', async () => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const h = harness({ status: 'past_due', entitlement_active: true }, { dunningState: true });
    h.setLive(sub('active'));
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'active', entitlement_active: true });
  });
});

describe('AUD-OPUS-R34D-119 C-680-19: dispute won writes paid (refund-dispute-handler.service.ts:952-956)', () => {
  it('EXPECTED RED: a disputed plan without access, then won (status paid as the handler writes), never regains access from sub.updated', async () => {
    const h = harness({ status: 'disputed', entitlement_active: false });
    // refund-dispute-handler.service.ts:955 on charge.dispute.closed(won)
    Object.assign(h.row(), { status: 'paid', updated_at: new Date(Date.now() - 30_000) });
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row().entitlement_active).toBe(false);
  });
});

describe('AUD-OPUS-R34D-119 round-7 controls', () => {
  it('unpaid row + renewal decline stays unpaid and opens dunning once (C-680-11)', async () => {
    const h = harness({ status: 'unpaid', entitlement_active: false });
    h.setLive(sub('unpaid', { latest_invoice: 'in_7b' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ claimed: true });
    expect(h.row().status).toBe('unpaid');
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it.each(['refunded', 'chargeback_lost', 'disputed'])(
    '%s without access + renewal decline opens no dunning',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      h.setLive(sub('past_due', { latest_invoice: 'in_7b' }));
      await expect(h.deliver(declined())).resolves.toMatchObject({ reason: 'subscription_already_ended' });
      expect(h.dunning.recordFailure).not.toHaveBeenCalled();
      expect(h.row().status).toBe(status);
    },
  );

  it.each(['refunded', 'chargeback_lost'])(
    '%s without access + customer.subscription.deleted keeps the money status',
    async (status) => {
      const h = harness({ status, entitlement_active: false });
      h.setLive(sub('canceled'));
      await h.deliver(ev('customer.subscription.deleted', sub('canceled')));
      expect(h.row()).toMatchObject({ status, entitlement_active: false });
    },
  );

  it('disputed WITH access (this tree keeps access during a dispute) is not fenced: sub.updated keeps access', async () => {
    const h = harness({ status: 'disputed', entitlement_active: true });
    await h.deliver(ev('customer.subscription.updated', sub('active')));
    expect(h.row().entitlement_active).toBe(true);
  });
});
