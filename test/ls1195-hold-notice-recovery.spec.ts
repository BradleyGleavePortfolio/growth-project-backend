import { READY, RESTRICTED, HOUR, T0, at, buildWorld, flush } from './support/pf7-hold-world';

describe('LS-1195 B1: recover an undelivered coach account-hold notice', () => {
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

  it.each(['push', 'email'] as const)(
    'retries a failed %s without duplicating the successful transport',
    async (failedTransport) => {
      const w = buildWorld({ saved: READY, stripeNow: RESTRICTED });
      if (failedTransport === 'push') {
        w.coachAlert.mockResolvedValueOnce({ inapp: 'sent', push: 'failed' });
      } else {
        w.email.mockResolvedValueOnce({
          status: 'failed',
          providerMessageId: null,
          idempotencyKey: 'hold-delivery-probe',
          error: 'provider_unavailable',
        });
      }

      await w.fail();
      await flush();
      expect(w.coachAlert).toHaveBeenCalledTimes(1);
      expect(w.email).toHaveBeenCalledTimes(1);

      // A successful sibling channel must remain once-per-day. A failed
      // attempt is not a delivery: the durable sweep must recover it even
      // though there are no more failed invoices to trigger another notice.
      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      await flush();

      if (failedTransport === 'push') {
        expect(w.coachAlert).toHaveBeenCalledTimes(2);
        expect(w.email).toHaveBeenCalledTimes(1);
      } else {
        expect(w.email).toHaveBeenCalledTimes(2);
        expect(w.coachAlert).toHaveBeenCalledTimes(1);
      }
    },
  );
});
