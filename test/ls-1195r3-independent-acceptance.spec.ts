import {
  COACH_ACCOUNT_HOLD_REASON,
  clientPlanStatus,
} from '../src/checkout/dunning-v2/coach-account-hold';
import { HOUR, READY, RESTRICTED, T0, at, buildWorld, flush } from './support/pf7-hold-world';

describe('LS-1195R3 independent whole-PR acceptance', () => {
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

  it.each([
    { ...READY, payouts_enabled: false },
    { ...READY, details_submitted: false },
    { ...READY, disabled_reason: 'requirements.past_due' },
  ])('uses all of the fresh canonical readiness gates: %j', async (stripeNow) => {
    const w = buildWorld({ saved: READY, stripeNow });
    await w.fail();
    expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);
    expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    expect(w.clientPushes()).toBe(0);
    expect(await w.entitled()).toBe('allowed');
  });

  it('a 201st held renewal is reached after the 200-row sweep page; each invoice is paid once', async () => {
    const w = buildWorld({ stripeNow: READY });
    for (let i = 0; i < 201; i++) {
      w.fake.seed('clientPurchase', {
        id: `page-purchase-${i}`,
        client_user_id: `page-client-${i}`,
        coach_user_id: 'coach-1',
        status: 'past_due',
        entitlement_active: true,
        billing_type: 'recurring',
        stripe_subscription_id: `sub_page_${i}`,
      });
      w.fake.seed('dunningState', {
        id: `page-state-${i}`,
        purchase_id: `page-purchase-${i}`,
        status: 'active',
        client_canceled_at: null,
        step_index: -1,
        entered_at: T0,
        sweep_checked_at: null,
        last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
      });
    }
    Reflect.set(w.stripe, 'listOpenInvoices', jest.fn(async (subscriptionId: string) => [
      { id: `in_${subscriptionId}`, status: 'open' },
    ]));
    jest.setSystemTime(at(HOUR));
    await w.hold.runSweep();
    expect(w.stripe.retryInvoiceOffSession).toHaveBeenCalledTimes(200);
    // Repeat in the same hour does not repay the first page and can reach
    // the as-yet-unchecked row (or the following hourly tick can).
    await w.hold.runSweep();
    jest.setSystemTime(at(2 * HOUR));
    await w.hold.runSweep();
    const calls = w.stripe.retryInvoiceOffSession.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(201);
    expect(new Set(calls.map((args) => args.invoiceId)).size).toBe(201);
    expect(new Set(calls.map((args) => args.idempotencyKey)).size).toBe(201);
    expect(w.clientPushes()).toBe(0);
  });

  it('another coach held row changes neither the recipient nor the count of this coach notice', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    w.fake.seed('user', { id: 'other-coach', email: 'other@tgp.invalid' });
    w.fake.seed('clientPurchase', {
      id: 'other-purchase',
      client_user_id: 'other-client',
      coach_user_id: 'other-coach',
    });
    w.fake.seed('dunningState', {
      id: 'other-state',
      purchase_id: 'other-purchase',
      status: 'active',
      client_canceled_at: null,
      last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
    });
    await w.fail();
    await flush();
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.coachAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        coachId: 'coach-1',
        message: expect.stringContaining("1 client's renewal"),
      }),
      expect.anything(),
    );
    expect(w.email).toHaveBeenCalledWith(expect.objectContaining({ to: 'coach@tgp.invalid' }));
    expect(w.email).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'other@tgp.invalid' }));
  });

  it.each(['canceled', 'refunded', 'disputed', 'ended', 'incomplete'])(
    'a stale hold marker never turns terminal/nonrenewal status %s into active',
    (status) => {
      expect(clientPlanStatus(
        status,
        { status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON },
      )).toBe(status);
    },
  );
});
