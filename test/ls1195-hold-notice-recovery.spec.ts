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

  it.each(['inapp', 'push', 'email'] as const)(
    'retries a failed %s without duplicating the successful transport',
    async (failedTransport) => {
      const w = buildWorld({ saved: READY, stripeNow: RESTRICTED });
      const coachAlert = jest.fn(async (
        _payload: unknown,
        _only?: { inapp?: boolean; push?: boolean },
      ) => ({ inapp: 'sent', push: 'sent' }));
      Reflect.set(w.hold, 'coachAlert', { emit: coachAlert });
      if (failedTransport === 'push') {
        coachAlert.mockResolvedValueOnce({ inapp: 'sent', push: 'failed' });
      } else if (failedTransport === 'inapp') {
        coachAlert.mockResolvedValueOnce({ inapp: 'failed', push: 'sent' });
      } else {
        w.email.mockResolvedValueOnce({ status: 'failed' });
      }

      await w.fail();
      await flush();
      expect(coachAlert).toHaveBeenCalledTimes(1);
      expect(w.email).toHaveBeenCalledTimes(1);

      // A successful sibling channel must remain once-per-day. A failed
      // attempt is not a delivery: the durable sweep must recover it even
      // though there are no more failed invoices to trigger another notice.
      jest.setSystemTime(at(HOUR));
      await w.hold.runSweep();
      await flush();

      if (failedTransport !== 'email') {
        expect(coachAlert).toHaveBeenCalledTimes(2);
        expect(w.email).toHaveBeenCalledTimes(1);
        expect(coachAlert.mock.calls[1]?.[1]).toEqual(expect.objectContaining(
          failedTransport === 'push' ? { inapp: false } : { push: false },
        ));
      } else {
        expect(w.email).toHaveBeenCalledTimes(2);
        expect(coachAlert).toHaveBeenCalledTimes(1);
      }
    },
  );
});
