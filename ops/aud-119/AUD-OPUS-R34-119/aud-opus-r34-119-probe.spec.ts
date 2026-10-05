// AUD-OPUS-R34-119 — independent lens probe for #680 @ 216489ff (never merged).
// Real handler; only Stripe and storage are doubles. `deliver` follows
// BillingService: prefetch out of the transaction, then handle on it.
// Cases named "PIN" record current behaviour; "C-" cases are expected red
// (findings outside this diff or optional); "control" cases must be green.
import {
  CheckoutWebhookHandlerService,
  WebhookRedeliverError,
} from '../src/checkout/checkout-webhook-handler.service';
import { makeFakePrisma } from './support/b-recur-fakes';

const NOW = Math.floor(Date.now() / 1000);
const PERIOD = NOW + 30 * 86400;
let seq = 0;
const ev = (type: string, object: Record<string, unknown>) => {
  seq += 1;
  return { id: `evt_o119_${seq}`, type, data: { object } };
};
const sub = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'sub_o',
  status,
  customer: 'cus_o',
  current_period_end: PERIOD,
  default_payment_method: 'pm_o',
  cancel_at_period_end: false,
  latest_invoice: 'in_o',
  ...over,
});
const declined = (over: Record<string, unknown> = {}) =>
  ev('invoice.payment_failed', {
    id: 'in_o',
    subscription: 'sub_o',
    amount_due: 4900,
    attempt_count: 1,
    billing_reason: 'subscription_cycle',
    last_payment_error: { message: 'Your card was declined.' },
    ...over,
  });
const setupOk = (id: string, over: Record<string, unknown> = {}) =>
  ev('setup_intent.succeeded', {
    id,
    customer: 'cus_o',
    status: 'succeeded',
    payment_method: 'pm_own',
    ...over,
  });
const ownMeta = {
  tgp_purchase_id: 'cp_o',
  tgp_subscription_id: 'sub_o',
  tgp_checkout: 'native_subscription_trial',
};

function harness(over: Record<string, unknown> = {}) {
  const db = makeFakePrisma();
  db._packages.push({ id: 'pkg_o', billing_type: 'recurring', duration_periods: null });
  db._purchases.push({
    id: 'cp_o',
    package_id: 'pkg_o',
    client_user_id: 'client_o',
    coach_user_id: 'coach_o',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    stripe_subscription_id: 'sub_o',
    stripe_checkout_session_id: 'sub_o',
    stripe_payment_intent_id: 'pi_o',
    stripe_customer_id: 'cus_o',
    stripe_client_secret: 'pi_o_secret_x',
    stripe_ephemeral_key: 'ek_o',
    status: 'active',
    entitlement_active: true,
    trial_days: null,
    trial_started_at: null,
    current_period_end: new Date(PERIOD * 1000),
    access_expires_at: new Date((PERIOD + 86400) * 1000),
    canceled_at: null,
    cancel_at_period_end: false,
    last_error: null,
    idempotency_key: 'sub-o',
    created_at: new Date(Date.now() - 60_000),
    updated_at: new Date(Date.now() - 60_000),
    ...over,
  });
  let live: Record<string, unknown> = sub('active');
  let invoiceStatus = 'open';
  const stripe: any = {
    retrieveSubscription: jest.fn(async () => ({ ...live })),
    retrieveSubscriptionForCheckout: jest.fn(async () => ({ ...live })),
    retrieveInvoice: jest.fn(async () => ({ id: 'in_o', status: invoiceStatus })),
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
    setInvoice: (s: string) => {
      invoiceStatus = s;
    },
  };
}

describe('Opus R34-119: renewal decline authority (controls)', () => {
  it('control: decline read, then the paired past_due update commits, then the decline opens dunning once (no redelivery)', async () => {
    const h = harness();
    h.setLive(sub('past_due'));
    const d = declined();
    const pre = await h.svc.prefetchForOuterTx(d);
    await h.deliver(ev('customer.subscription.updated', sub('past_due')));
    expect(h.row().status).toBe('past_due');
    await expect(h.svc.handle(d, h.db, pre)).resolves.toMatchObject({ claimed: true });
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.row()).toMatchObject({ status: 'past_due', last_error: 'Your card was declined.' });
  });

  it('control: a lifecycle-neutral write after the decline read redelivers, and the redelivery opens dunning once (no livelock)', async () => {
    const h = harness({ status: 'past_due' });
    h.setLive(sub('past_due'));
    const d = declined({ attempt_count: 2 });
    const pre = await h.svc.prefetchForOuterTx(d);
    // e.g. a resume/cancel CAS write or any other purchase write
    await h.db.clientPurchase.update({ where: { id: 'cp_o' }, data: { cancel_at_period_end: false } });
    await expect(h.svc.handle(d, h.db, pre)).rejects.toBeInstanceOf(WebhookRedeliverError);
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    await h.deliver(d);
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('control: the first post-trial charge decline (subscription_cycle) of an own-card trial enters dunning', async () => {
    const h = harness({
      status: 'trialing',
      trial_days: 7,
      trial_started_at: new Date((NOW - 7 * 86400) * 1000),
    });
    h.setLive(sub('past_due'));
    await h.deliver(declined());
    expect(h.dunning.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.row()).toMatchObject({ status: 'past_due', entitlement_active: true });
  });

  it('control: a first-invoice decline (subscription_create) never enters dunning, even with Stripe past_due', async () => {
    const h = harness({ status: 'pending', entitlement_active: false });
    h.setLive(sub('incomplete'));
    await h.deliver(declined({ billing_reason: 'subscription_create' }));
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
    expect(h.row()).toMatchObject({ status: 'pending', last_error: 'Your card was declined.' });
  });

  it('PIN: a decline of a still-open invoice that is no longer the latest is acknowledged with no write', async () => {
    const h = harness();
    h.setLive(sub('past_due', { latest_invoice: 'in_newer' }));
    await expect(h.deliver(declined())).resolves.toMatchObject({ reason: 'invoice_superseded' });
    expect(h.dunning.recordFailure).not.toHaveBeenCalled();
  });

  it('C-680-11 (outside this diff): a decline never rewrites an unpaid (revoked) plan as past_due', async () => {
    const h = harness({ status: 'unpaid', entitlement_active: false });
    h.setLive(sub('unpaid'));
    await h.deliver(declined({ attempt_count: 4 }));
    expect(h.row().status).toBe('unpaid');
  });
});

describe('Opus R34-119: setup_intent.succeeded attaches only the attempt-owned trial SetupIntent', () => {
  const trialRow = {
    status: 'trialing',
    entitlement_active: false,
    trial_days: 14,
    cancel_at_period_end: true,
    stripe_client_secret: 'seti_StripePending_secret_x',
  };

  it('control: own metadata attaches with the end lifted; the follow-up update grants and stamps the trial once', async () => {
    const h = harness(trialRow);
    h.setLive(sub('trialing', { trial_start: NOW, default_payment_method: null, cancel_at_period_end: true }));
    await expect(h.deliver(setupOk('seti_Own', { metadata: ownMeta }))).resolves.toMatchObject({
      claimed: true,
    });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(h.stripe.setSubscriptionDefaultPaymentMethod.mock.calls[0][0]).toMatchObject({
      subscriptionId: 'sub_o',
      paymentMethodId: 'pm_own',
      liftTrialEnd: true,
    });
    await h.deliver(ev('customer.subscription.updated', { ...h.live() }));
    expect(h.row()).toMatchObject({ entitlement_active: true });
    expect(h.row().trial_started_at).toEqual(new Date(NOW * 1000));
    // Redelivered SetupIntent success after the grant: no second Stripe write.
    await h.deliver(setupOk('seti_Own', { metadata: ownMeta }));
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(h.fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
  });

  it('control (B-680-5 case 2 by behaviour): Stripe-set default with the end on; the stored-secret SetupIntent attaches and lifts the end', async () => {
    const h = harness({ ...trialRow, stripe_client_secret: 'seti_Stored_secret_x' });
    h.setLive(sub('trialing', { trial_start: NOW, cancel_at_period_end: true }));
    await h.deliver(setupOk('seti_Stored'));
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).toHaveBeenCalledTimes(1);
    expect(h.live()).toMatchObject({ default_payment_method: 'pm_own', cancel_at_period_end: false });
  });

  it('control: a SetupIntent of another flow (other metadata, not the stored secret) is not claimed and touches nothing', async () => {
    const h = harness(trialRow);
    h.setLive(sub('trialing', { default_payment_method: null, cancel_at_period_end: true }));
    await expect(
      h.deliver(setupOk('seti_CardUpdate', { metadata: { tgp_checkout: 'card_update', tgp_purchase_id: 'cp_o' } })),
    ).resolves.toMatchObject({ claimed: false });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(h.row().entitlement_active).toBe(false);
  });

  it('control: own metadata on a non-recurring row id touches nothing', async () => {
    const h = harness({ ...trialRow, billing_type: 'one_time' });
    h.setLive(sub('trialing', { default_payment_method: null, cancel_at_period_end: true }));
    await expect(h.deliver(setupOk('seti_Own', { metadata: ownMeta }))).resolves.toMatchObject({
      claimed: false,
    });
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it('C-680-13 (defence in depth): an ended attempt row is never given a card while Stripe still shows trialing', async () => {
    const h = harness({ ...trialRow, status: 'expired' });
    h.setLive(sub('trialing', { trial_start: NOW, default_payment_method: null, cancel_at_period_end: true }));
    await h.deliver(setupOk('seti_Own', { metadata: ownMeta }));
    expect(h.stripe.setSubscriptionDefaultPaymentMethod).not.toHaveBeenCalled();
  });
});

describe('Opus R34-119: composition with refund / dispute end of access (outside this diff)', () => {
  it('C-680-12: a recurring plan whose access ended on a lost dispute is not re-granted by a later subscription update', async () => {
    const h = harness({ status: 'chargeback_lost', entitlement_active: false });
    h.setLive(sub('active', { cancel_at_period_end: true }));
    await h.deliver(ev('customer.subscription.updated', sub('active', { cancel_at_period_end: true })));
    expect(h.row().entitlement_active).toBe(false);
  });

  it('C-680-12: R-DISPUTE-PAUSE shape — paused collection on an ended-access plan is not re-granted', async () => {
    const h = harness({ status: 'disputed', entitlement_active: false });
    const paused = sub('active', { pause_collection: { behavior: 'void' } });
    h.setLive(paused);
    await h.deliver(ev('customer.subscription.updated', paused));
    expect(h.row().entitlement_active).toBe(false);
  });
});
