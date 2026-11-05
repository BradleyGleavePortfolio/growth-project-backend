import { parseHoldNoticeCursor } from '../src/checkout/dunning-v2/coach-account-hold';
import { DAY, HOUR, RESTRICTED, T0, at, buildWorld, flush } from './support/pf7-hold-world';

describe('LS-1195R2 notice database boundaries and bounded recovery', () => {
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

  async function unclaimedWorld() {
    const w = buildWorld({ stripeNow: RESTRICTED });
    await w.fail();
    await flush();
    await w.prisma.cronLease.deleteMany({
      where: { name: 'coach-account-hold-notice:coach-1' },
    });
    w.coachAlert.mockClear();
    w.email.mockClear();
    return w;
  }

  it.each(['preferences', 'create', 'read', 'claim'] as const)(
    'documents the declared pre-claim loss at the %s database step',
    async (step) => {
      const w = await unclaimedWorld();
      const fault = new Error('review database unavailable');
      if (step === 'preferences') {
        w.prisma.notificationPreferences.findUnique.mockRejectedValueOnce(fault);
      } else if (step === 'create') {
        w.prisma.cronLease.upsert.mockRejectedValueOnce(fault);
      } else if (step === 'read') {
        w.prisma.cronLease.findUnique.mockRejectedValueOnce(fault);
      } else {
        w.prisma.cronLease.updateMany.mockRejectedValueOnce(fault);
      }
      await w.hold.notifyCoach('coach-1').catch(() => false);
      for (const elapsed of [HOUR, DAY + HOUR]) {
        jest.setSystemTime(at(elapsed));
        await w.hold.runSweep();
        await flush();
      }
      expect(w.coachAlert).not.toHaveBeenCalled();
      expect(w.email).not.toHaveBeenCalled();
      expect(w.state()?.last_failure_reason).toBe('coach_account_not_ready');
    },
  );

  it('a count read failing after the day claim recovers all channels at the next hour', async () => {
    const w = await unclaimedWorld();
    w.prisma.dunningState.count.mockRejectedValueOnce(new Error('review count unavailable'));
    await expect(w.hold.notifyCoach('coach-1')).rejects.toThrow('review count unavailable');
    expect(w.coachAlert).not.toHaveBeenCalled();
    jest.setSystemTime(at(HOUR));
    await w.hold.runSweep();
    await flush();
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.email).toHaveBeenCalledTimes(1);
  });

  it('a failed email-address lookup retains only email and recovers it without repeating the alert', async () => {
    const w = await unclaimedWorld();
    w.prisma.user.findUnique.mockRejectedValueOnce(new Error('review recipient unavailable'));
    await w.hold.notifyCoach('coach-1');
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.email).not.toHaveBeenCalled();
    jest.setSystemTime(at(HOUR));
    await w.hold.runSweep();
    await flush();
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    expect(w.email).toHaveBeenCalledTimes(1);
  });

  it('a failed retry read and failed retry claim postpone delivery, then recover only email', async () => {
    const w = await unclaimedWorld();
    w.email.mockResolvedValueOnce({ status: 'failed' });
    await w.hold.notifyCoach('coach-1');
    w.prisma.cronLease.findUnique.mockRejectedValueOnce(new Error('review retry read'));
    jest.setSystemTime(at(HOUR));
    await w.hold.runSweep();
    w.prisma.cronLease.updateMany.mockRejectedValueOnce(new Error('review retry claim'));
    jest.setSystemTime(at(2 * HOUR));
    await w.hold.runSweep();
    expect(w.email).toHaveBeenCalledTimes(1);
    jest.setSystemTime(at(3 * HOUR));
    await w.hold.runSweep();
    await flush();
    expect(w.email).toHaveBeenCalledTimes(2);
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
  });

  it('two sweeps at once claim the failed email once without repeating delivered channels', async () => {
    const w = await unclaimedWorld();
    w.email.mockResolvedValueOnce({ status: 'failed' });
    await w.hold.notifyCoach('coach-1');
    jest.setSystemTime(at(HOUR));
    await Promise.all([w.hold.runSweep(), w.hold.runSweep()]);
    await flush();
    expect(w.email).toHaveBeenCalledTimes(2);
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
  });

  it('documents the six-send cap: delivered alert stays once and failed email waits for a later new notice', async () => {
    const w = await unclaimedWorld();
    w.email.mockResolvedValue({ status: 'failed' });
    await w.hold.notifyCoach('coach-1');
    for (let h = 1; h <= 12; h++) {
      jest.setSystemTime(at(h * HOUR));
      await w.hold.runSweep();
    }
    jest.setSystemTime(at(DAY + HOUR));
    await w.hold.runSweep();
    expect(w.email).toHaveBeenCalledTimes(6);
    expect(w.coachAlert).toHaveBeenCalledTimes(1);
    const row = w.fake.find('cronLease', { name: 'coach-account-hold-notice:coach-1' });
    expect(parseHoldNoticeCursor(row?.cursor as string)).toMatchObject({
      sends: 6,
      owed: ['email'],
    });
    await w.fail('sub_pf7_second');
    expect(w.email).toHaveBeenCalledTimes(7);
    expect(w.coachAlert).toHaveBeenCalledTimes(2);
  });

  it('documents the post-delivery cursor-write edge: alert can repeat after the claim expires', async () => {
    const w = await unclaimedWorld();
    const update = w.prisma.cronLease.updateMany;
    const implementation = update.getMockImplementation();
    update.mockImplementationOnce(implementation).mockRejectedValueOnce(
      new Error('review receipt unavailable'),
    );
    await expect(w.hold.notifyCoach('coach-1')).rejects.toThrow('review receipt unavailable');
    jest.setSystemTime(at(HOUR));
    await w.hold.runSweep();
    await flush();
    expect(w.coachAlert).toHaveBeenCalledTimes(2);
    expect(w.email).toHaveBeenCalledTimes(2);
    const keys = w.email.mock.calls.map(
      (call) => ((call as unknown[])[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).toBe(keys[0]);
  });
});
