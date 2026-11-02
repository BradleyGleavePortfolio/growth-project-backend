import { DAY, HOUR, RESTRICTED, READY, at, buildWorld, T0 } from './support/pf7-hold-world';

/**
 * PF-7-BE first test (owner #PF-STRIPE option 1, ruling R1): a renewal that
 * fails while a fresh read says the coach's Stripe account can't take
 * payments starts no ten-day cycle and sends the client nothing — even
 * though the saved row still says the account is ready. Red at main (main
 * starts Day 0 and reminds the client), green with the hold.
 */
describe('PF-7-BE first test: a failure on a coach account that cannot take payments', () => {
  const prev = { v2: process.env['FEATURE_DUNNING_V2'], hold: process.env['FEATURE_COACH_ACCOUNT_HOLD'] };

  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
    delete process.env['FEATURE_COACH_ACCOUNT_HOLD'];
    jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => {
    for (const [k, v] of [
      ['FEATURE_DUNNING_V2', prev.v2],
      ['FEATURE_COACH_ACCOUNT_HOLD', prev.hold],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('starts no ten-day cycle and reminds the client of nothing; access continues', async () => {
    const w = buildWorld({ saved: READY, stripeNow: RESTRICTED });
    await w.fail();

    expect((await w.v2.getClientStatus('client-1')).state).toBe('none');
    expect(w.clientPushes()).toBe(0);
    expect(w.clientEmails()).toBe(0);
    expect(w.fake.rows('dunningNoticeDelivery')).toHaveLength(0);

    // Every later step (Day 1, 3, 7, 10) passes with nothing sent and no lock.
    for (const day of [1, 3, 7, 10, 11]) {
      jest.setSystemTime(at(day * DAY + HOUR));
      await w.v2.runSweep();
    }
    expect(w.clientPushes()).toBe(0);
    expect(w.clientEmails()).toBe(0);
    expect(w.state()?.locked_out_at ?? null).toBeNull();
    expect(w.purchase()?.entitlement_active).toBe(true);
    expect(await w.entitled()).toBe('allowed');
    expect(await w.lockVerdict()).toBe('allowed');
  });
});
