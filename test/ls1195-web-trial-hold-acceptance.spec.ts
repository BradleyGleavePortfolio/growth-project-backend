import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { DAY, RESTRICTED, T0, at, buildWorld, fixture, flush, stub } from './support/pf7-hold-world';

describe('LS-1195 R8: first real payment after a web trial', () => {
  const previousV2 = process.env['FEATURE_DUNNING_V2'];
  const previousHold = process.env['FEATURE_COACH_ACCOUNT_HOLD'];

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previousV2 === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = previousV2;
    if (previousHold === undefined) delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    else process.env['FEATURE_COACH_ACCOUNT_HOLD'] = previousHold;
  });

  it('GC3 trialing row and SetupIntent marker enter the hold through the outer-tx webhook path', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    await w.prisma.clientPurchase.update({ where: { id: 'purchase-1' }, data: {
      status: 'trialing',
      entitlement_active: true,
      stripe_payment_intent_id: ['seti', 'web-trial-marker'].join('_'),
      trial_days: 7,
      trial_started_at: at(-7 * DAY),
      trial_ends_at: T0,
      card_on_file: true,
    } });
    const event = fixture('invoice.payment_failed', { billing_reason: 'subscription_cycle', amount_due: 15000 });
    const prefetch = await w.handler.prefetchForOuterTx(event);
    const reads = w.stripe.retrieveAccount.mock.calls.length;
    await w.handler.handle(event, stub(w.prisma), prefetch);
    await flush();

    expect(w.stripe.retrieveAccount.mock.calls.length).toBe(reads);
    expect(w.state()).toMatchObject({
      status: 'active',
      step_index: -1,
      locked_out_at: null,
      last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
    });
    expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    expect(w.purchase()?.entitlement_active).toBe(true);
    expect(await w.entitled()).toBe('allowed');
    expect(w.clientPushes()).toBe(0);
    expect(w.clientEmails()).toBe(0);
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.email).toHaveBeenCalledTimes(1);
  });

  it('the trial-day subscription_create invoice never becomes a failed renewal', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    await w.prisma.clientPurchase.update({ where: { id: 'purchase-1' }, data: {
      status: 'trialing',
      trial_started_at: T0,
      entitlement_active: true,
    } });
    const event = fixture('invoice.payment_failed', { billing_reason: 'subscription_create', amount_due: 0 });
    const prefetch = await w.handler.prefetchForOuterTx(event);
    await w.handler.handle(event, stub(w.prisma), prefetch);
    await flush();
    expect(w.state()).toBeNull();
    expect(w.purchase()?.entitlement_active).toBe(true);
    expect(w.coachAlert).not.toHaveBeenCalled();
    expect(w.clientPushes()).toBe(0);
  });
});
