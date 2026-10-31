import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { DAY, RESTRICTED, T0, at, buildWorld, fixture, flush, stub } from './support/pf7-hold-world';

describe('LS-1195 B3: a held renewal keeps access through subscription updates', () => {
  const saved = {
    v2: process.env['FEATURE_DUNNING_V2'],
    hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'],
  };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['FEATURE_DUNNING_V2', saved.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', saved.hold],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(['past_due', 'unpaid'])(
    'a fresh %s subscription event does not revoke a coach-held renewal',
    async (status) => {
      const w = buildWorld({ stripeNow: RESTRICTED });
      await w.fail();
      expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
      expect(w.purchase()?.entitlement_active).toBe(true);

      jest.setSystemTime(at(7 * DAY));
      const subscriptionId = String(w.purchase()?.stripe_subscription_id);
      const subscription = {
        ...(await w.stripe.retrieveSubscription(subscriptionId)),
        status,
      };
      Reflect.set(w.stripe, 'retrieveSubscriptionForCheckout', jest.fn(async () => subscription));
      const event = fixture('customer.subscription.updated', { ...subscription });
      const prefetch = await w.handler.prefetchForOuterTx(event);
      await w.handler.handle(event, stub(w.prisma), prefetch);
      await flush();

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
    },
  );
});
