// B-RECUR6B-118 — #680 fix round 6. The dead Sol lens's round-5 probes
// (AUD-SOL-R34R5-117, branch audit/AUD-SOL-R34R5-117/680-authority, run
// 37187197172) rebuilt as regressions, plus the attempt-owned trial
// SetupIntent attach (R2 B-679-10). Only Stripe and storage are doubles; the
// handler (and, for B-680-6, DunningService) are the real implementations.
// `deliver` is the BillingService order: prefetch out of the transaction,
// then handle on it. Cases marked "(failed before)" fail on #680 @ 9621457e
// merged with #679 @ 8bbf4a41.
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { DunningService } from '../src/checkout/dunning.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const PERIOD = NOW + 30 * 86400;
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_r6b_${seq}`, type, data: { object } };
};
const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_6b',
  status,
  customer: 'cus_6b',
  current_period_end: PERIOD,
  default_payment_method: 'pm_6b',
  cancel_at_period_end: false,
  ...over,
});
const paid = () =>
  ev('invoice.paid', {
    id: 'in_6b',
    subscription: 'sub_6b',
    amount_paid: 14800,
    currency: 'usd',
    charge: 'ch_6b',
    billing_reason: 'subscription_cycle',
  });
const declined = () =>
  ev('invoice.payment_failed', {
    id: 'in_6b',
    subscription: 'sub_6b',
    amount_due: 14800,
    attempt_count: 1,
    billing_reason: 'subscription_cycle',
    last_payment_error: { message: 'Your card was declined.' },
  });
const setupSucceeded = (id: string, over: Record<string, unknown> = {}) =>
  ev('setup_intent.succeeded', {
    id,
    customer: 'cus_6b',
    status: 'succeeded',
    payment_method: 'pm_own',
    ...over,
  });
const ownMeta = (over: Record<string, string> = {}) => ({
  tgp_purchase_id: 'cp_6b',
  tgp_subscription_id: 'sub_6b',
  tgp_checkout: 'native_subscription_trial',
  ...over,
});

function harness(over: Record<string, unknown> = {}) {
  const db = makeFakePrisma();
  db._packages.push({ id: 'pkg_6b', billing_type: 'recurring', duration_periods: null });
  db._purchases.push({
    id: 'cp_6b',
    package_id: 'pkg_6b',
    client_user_id: 'client_6b',
    coach_user_id: 'coach_6b',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: 'sub_6b',
    stripe_checkout_session_id: 'sub_6b',
    stripe_payment_intent_id: 'pi_6b',
    stripe_customer_id: 'cus_6b',
    stripe_client_secret: 'pi_6b_secret_x',
    stripe_ephemeral_key: 'ek_6b',
    status: 'active',
    entitlement_active: true,
    trial_days: null,
    trial_started_at: null,
    current_period_end: new Date(PERIOD * 1000),
    access_expires_at: new Date((PERIOD + 86400) * 1000),
    canceled_at: null,
    cancel_at_period_end: false,
    last_error: null,
    idempotency_key: 'sub-6b',
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
    retrieveInvoice: jest.fn(async () => ({ id: 'in_6b', status: invoiceStatus })),
    // Stripe's answer to the trial-card attach: the default, and the
    // create-time end lifted only when asked (R1).
    setSubscriptionDefaultPaymentMethod: jest.fn(async (a: any) => {
      live = {
        ...live,
        default_payment_method: a.paymentMethodId,
        ...(a.liftTrialEnd ? { cancel_at_period_end: false } : {}),
      };
      return { ...live };
    }),
  };
  const fanout: any = {
    onPurchaseEntitled: jest.fn(async () => undefined),
    cancelPendingForPurchase: jest.fn(async () => 0),
  };
  const dunning: any = {
    recordFailure: jest.fn(async () => ({})),
    recordResolution: jest.fn(async () => null),
    terminate: jest.fn(async () => null),
  };
  const svc = new CheckoutWebhookHandlerService(db, stripe, undefined, dunning, undefined, fanout);
  const deliver = async (e: ReturnType<typeof ev>) =>
    svc.handle(e, db, await svc.prefetchForOuterTx(e));
  return {
    db,
    stripe,
    svc,
    deliver,
    fanout,
    dunning,
    row: () => db._purchases[0],
    live: () => live,
    setLive: (s: Record<string, unknown>) => {
      live = s;
    },
    setInvoice: (status: string) => {
      invoiceStatus = status;
    },
  };
}

describe('B-680-2 residual: a plan already past_due at the decline read gets no exception', () => {
  it('(failed before) a paid old invoice stays settled when another invoice keeps the subscription past_due', async () => {
    const h = harness({ status: 'past_due', last_error: 'Your card was declined.' });
    h.setLive(sub('past_due', { latest_invoice: 'in_6b' }));
    const decline = declined();
    const pre = await h.svc.prefetchForOuterTx(decline);
    h.setInvoice('paid');
    h.setLive(sub('past_due', { latest_invoice: 'in_newer_still_open' }));
    await h.deliver(paid());
    expect(h.row()).toMatchObject({ status: 'past_due', last_error: null });
    expect(h.dunning.recordResolution).toHaveBeenCalledTimes(1);
    await expect(h.svc.handle(decline, h.db, pre)).rejects.toThrow(/redeliver/);
    // The redelivery reads Stripe again: the invoice was paid.
    await expect(h.deliver(decline)).resolves.toMatchObject({ reason: 'invoice_already_settled' });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    expect(h.row().last_error).toBeNull();
  });

  it('control: a retry decline of a past_due plan with nothing in between still records the failure', async () => {
    const h = harness({ status: 'past_due', last_error: 'Your card was declined.' });
    h.setLive(sub('past_due', { latest_invoice: 'in_6b' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ claimed: true });
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe("B-680-5: only the attempt's own card (create-time end lifted) starts a trial", () => {
  const trialRow = {
    status: 'pending',
    entitlement_active: false,
    trial_days: 7,
    cancel_at_period_end: true,
  };

  it('(failed before) a default card with the create-time end still on grants nothing', async () => {
    const h = harness(trialRow);
    h.setLive(sub('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    await h.deliver(
      ev('customer.subscription.updated', sub('trialing', { cancel_at_period_end: true })),
    );
    await h.deliver(
      ev('invoice.paid', {
        id: 'in_0',
        subscription: 'sub_6b',
        amount_paid: 0,
        billing_reason: 'subscription_create',
      }),
    );
    expect(h.row()).toMatchObject({ entitlement_active: false, trial_started_at: null });
    expect(h.fanout.onPurchaseEntitled).not.toHaveBeenCalled();
  });

  it('(failed before) the own SetupIntent lifts the end even when Stripe already set the default; then the trial starts', async () => {
    const h = harness({
      ...trialRow,
      status: 'trialing',
      stripe_client_secret: 'seti_Own6b_secret_x',
    });
    h.setLive(sub('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    const result = await h.deliver(setupSucceeded('seti_Own6b'));
    expect(result).toMatchObject({ claimed: true, reason: 'native_trial_card_attached' });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith({
      subscriptionId: 'sub_6b',
      paymentMethodId: 'pm_own',
      idempotencyKey: 'tgp-trial-card-sub_6b-pm_own',
      liftTrialEnd: true,
    });
    // Stripe's customer.subscription.updated after the attach grants the trial.
    await h.deliver(ev('customer.subscription.updated', { ...h.live() }));
    expect(h.row()).toMatchObject({ status: 'trialing', entitlement_active: true });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('control: the own card already on (end lifted) is not written again', async () => {
    const h = harness({
      ...trialRow,
      status: 'trialing',
      stripe_client_secret: 'seti_Own6b_secret_x',
    });
    h.setLive(sub('trialing', { trial_start: NOW, cancel_at_period_end: false }));
    await expect(h.deliver(setupSucceeded('seti_Own6b'))).resolves.toMatchObject({ claimed: true });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('control: a client-canceled, already granted trial is never resumed by a redelivered SetupIntent success', async () => {
    const h = harness({
      status: 'trialing',
      entitlement_active: true,
      trial_days: 7,
      trial_started_at: new Date(),
      stripe_client_secret: 'seti_Own6b_secret_x',
      cancel_at_period_end: true,
    });
    h.setLive(sub('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    await expect(h.deliver(setupSucceeded('seti_Own6b'))).resolves.toMatchObject({ claimed: true });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(h.row().cancel_at_period_end).toBe(true);
  });

  it('(failed before) a never-granted trial whose default kept the create-time end is not consumed by the deletion', async () => {
    const h = harness(trialRow);
    await h.deliver(
      ev(
        'customer.subscription.deleted',
        sub('canceled', {
          trial_start: NOW,
          cancel_at_period_end: true,
          canceled_at: NOW,
        }),
      ),
    );
    expect(h.row()).toMatchObject({
      status: 'expired',
      entitlement_active: false,
      trial_started_at: null,
    });
  });

  it('control: a deletion that shows the own card on still consumes the trial (B-680-4)', async () => {
    const h = harness(trialRow);
    await h.deliver(
      ev(
        'customer.subscription.deleted',
        sub('canceled', {
          trial_start: NOW,
          cancel_at_period_end: false,
          canceled_at: NOW,
        }),
      ),
    );
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
    expect(h.row().status).toBe('canceled');
  });
});

describe('B-679-10 handoff: the attempt-owned trial SetupIntent is attached by its metadata', () => {
  // R2 creates this SetupIntent when Stripe made no pending one; Stripe does
  // not tie it to the subscription, and the stored secret may be another one.
  const trialRow = {
    status: 'trialing',
    entitlement_active: false,
    trial_days: 7,
    cancel_at_period_end: true,
    stripe_client_secret: 'seti_StripePending_secret_x',
  };

  it('(failed before) its success attaches the card and lifts the end, whatever secret the row stores', async () => {
    const h = harness(trialRow);
    h.setLive(
      sub('trialing', {
        trial_start: NOW,
        default_payment_method: null,
        cancel_at_period_end: true,
      }),
    );
    const result = await h.deliver(setupSucceeded('seti_AttemptOwn', { metadata: ownMeta() }));
    expect(result).toMatchObject({ claimed: true, reason: 'native_trial_card_attached' });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledWith({
      subscriptionId: 'sub_6b',
      paymentMethodId: 'pm_own',
      idempotencyKey: 'tgp-trial-card-sub_6b-pm_own',
      liftTrialEnd: true,
    });
    await h.deliver(ev('customer.subscription.updated', { ...h.live() }));
    expect(h.row()).toMatchObject({ entitlement_active: true });
  });

  it('metadata naming another subscription, or another customer, touches nothing', async () => {
    const h = harness(trialRow);
    h.setLive(sub('trialing', { default_payment_method: null, cancel_at_period_end: true }));
    await expect(
      h.deliver(
        setupSucceeded('seti_AttemptOwn', {
          metadata: ownMeta({ tgp_subscription_id: 'sub_other' }),
        }),
      ),
    ).resolves.toMatchObject({ claimed: false });
    await expect(
      h.deliver(setupSucceeded('seti_AttemptOwn', { metadata: ownMeta(), customer: 'cus_other' })),
    ).resolves.toMatchObject({ claimed: false });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('an unreadable lookup redelivers instead of acknowledging the only saved-card event', async () => {
    const h = harness(trialRow);
    h.db.clientPurchase.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(
      h.deliver(setupSucceeded('seti_AttemptOwn', { metadata: ownMeta() })),
    ).rejects.toThrow(/redeliver/);
  });
});

describe('B-680-6: the purchase row lock never blocks dunning rows inserted on another connection', () => {
  // Postgres row-lock compatibility for the purchase row: an insert that
  // references it (DunningState, PaymentReminder) takes FOR KEY SHARE, which
  // FOR UPDATE blocks and FOR NO KEY UPDATE does not. DunningService writes
  // on its own client, outside the webhook transaction holding the lock;
  // with lock_timeout set the insert fails (55P03), without it the two wait
  // on each other until the transaction times out.
  function lockedHarness() {
    const h = harness({ status: 'active' });
    h.setLive(sub('past_due', { latest_invoice: 'in_6b' }));
    const held = new Map<string, string>();
    h.db.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "ClientPurchase"')) {
        held.set(String(vals[0]), sql.includes('FOR NO KEY UPDATE') ? 'no_key_update' : 'update');
      }
      return [];
    });
    const keyShare = (purchaseId: string) => {
      if (held.get(purchaseId) === 'update') {
        throw Object.assign(new Error('lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
      }
    };
    const states: Array<Record<string, unknown>> = [];
    const reminders: Array<Record<string, unknown>> = [];
    const pool: any = {
      dunningState: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          keyShare(data.purchase_id);
          const row = { id: `ds_${states.length + 1}`, ...data };
          states.push(row);
          return row;
        }),
        update: jest.fn(async ({ data }: any) => ({ ...states[0], ...data })),
      },
      dunningAttempt: { create: jest.fn(async ({ data }: any) => ({ id: 'da', ...data })) },
      paymentReminder: {
        create: jest.fn(async ({ data }: any) => {
          keyShare(data.purchase_id);
          reminders.push(data);
          return { id: `pr_${reminders.length}`, ...data };
        }),
      },
    };
    const dunning = new DunningService(pool, h.stripe);
    const svc = new CheckoutWebhookHandlerService(
      h.db,
      h.stripe,
      undefined,
      dunning,
      undefined,
      h.fanout,
    );
    return { ...h, svc, dunning, held, states, reminders };
  }

  it('(failed before) the first renewal decline commits its dunning window and reminders', async () => {
    const h = lockedHarness();
    const decline = declined();
    const result = await h.svc.handle(decline, h.db, await h.svc.prefetchForOuterTx(decline));
    expect(result).toMatchObject({ claimed: true });
    expect(h.held.get('cp_6b')).toBe('no_key_update');
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
    expect(h.states).toHaveLength(1);
    expect(h.reminders).toHaveLength(2);
    expect(h.dunning.metrics.get('dunning_entered_total')).toBe(1);
  });

  it('(failed before) invoice.paid takes the same NO KEY UPDATE row lock: lifecycle writers stay serialized', async () => {
    const h = lockedHarness();
    const payment = paid();
    await h.svc.handle(payment, h.db, await h.svc.prefetchForOuterTx(payment));
    expect(h.held.get('cp_6b')).toBe('no_key_update');
  });
});
