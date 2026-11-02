import { buildWorld, READY, RESTRICTED, HOUR, DAY, T0, at, flush } from './support/pf7-hold-world';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';

describe('LS-1195 acceptance: card recovery includes a bank-action answer', () => {
  const saved = {
    v2: process.env['FEATURE_DUNNING_V2'],
    hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'],
  };
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    process.env['FEATURE_COACH_ACCOUNT_HOLD'] = 'true';
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
    ['card decline', 'card_declined', 'card_error'],
    ['bank authentication', 'invoice_payment_intent_requires_action', 'card_error'],
  ])('starts the client recovery clock for %s after the coach fixes the account', async (
    _label, code, type,
  ) => {
    const w = buildWorld({ saved: { ...RESTRICTED }, stripeNow: { ...RESTRICTED } });
    await w.fail();
    await flush();
    expect(w.state()).toMatchObject({
      step_index: -1,
      last_failure_reason: COACH_ACCOUNT_HOLD_REASON,
    });
    expect(w.clientPushes()).toBe(0);
    w.account.value = { ...READY };
    // Recorded Stripe response shape, rather than the project's fake type:
    // https://github.com/stripe/stripe-node/issues/628 (raw.type = card_error).
    w.stripe.retryInvoiceOffSession.mockRejectedValueOnce(
      new StripeConnectApiError('The payment needs client action.', 402, code, type),
    );
    const retryAt = at(HOUR);
    jest.setSystemTime(retryAt);
    await w.hold.runSweep();
    await flush();

    expect(w.state()).toMatchObject({ step_index: 0, last_failure_reason: null });
    const status = await w.v2.getClientStatus('client-1');
    expect(status.state).toBe('past_due');
    expect(status.failed_at).toBe(retryAt.toISOString());
    expect(status.lockout_at).toBe(new Date(retryAt.getTime() + 10 * DAY).toISOString());
    expect(w.clientPushes()).toBe(1);
  });
});
