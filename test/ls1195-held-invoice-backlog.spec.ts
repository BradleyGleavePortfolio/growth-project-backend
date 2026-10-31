import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { DAY, HOUR, READY, RESTRICTED, T0, at, buildWorld, fixture, flush } from './support/pf7-hold-world';

describe('LS-1195 B2: recover every renewal accrued during an account hold', () => {
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

  it('a weekly plan held across its next renewal collects both unpaid invoices before retiring the hold', async () => {
    const w = buildWorld({ stripeNow: RESTRICTED });
    w.fake.update('coachPackage', { id: 'pkg-1' }, { interval: 'week' });
    await w.fail();

    const [older] = await w.stripe.listOpenInvoices();
    const newer = { ...older, id: `${older.id}-next-period` };
    jest.setSystemTime(at(7 * DAY));
    await w.handler.handle(fixture('invoice.payment_failed', { id: newer.id }));
    await flush();
    expect(w.state()?.last_failure_reason).toBe(COACH_ACCOUNT_HOLD_REASON);

    w.account.value = { ...READY };
    w.stripe.listOpenInvoices.mockResolvedValue([newer, older]);
    jest.setSystemTime(at(7 * DAY + HOUR));
    await Promise.all([w.hold.runSweep(), w.hold.runSweep()]);

    // Stripe lists newest first. Paying that invoice is not evidence that
    // the previous week's still-open renewal was paid.
    await w.handler.handle(fixture('invoice.paid', { id: newer.id }));
    await flush();
    jest.setSystemTime(at(7 * DAY + 2 * HOUR));
    await w.hold.runSweep();

    const attempted = w.stripe.retryInvoiceOffSession.mock.calls.map(([args]) => args.invoiceId);
    expect(attempted).toContain(older.id);
    expect(attempted).toContain(newer.id);
    expect(attempted.filter((id) => id === older.id)).toHaveLength(1);
    expect(attempted.filter((id) => id === newer.id)).toHaveLength(1);
  });
});
