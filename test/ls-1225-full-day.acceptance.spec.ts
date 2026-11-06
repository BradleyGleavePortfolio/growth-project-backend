describe('LS-1225 acceptance: daily money check without an admin click', () => {
  it('provides an enabled full-day scheduled run and one owner result', async () => {
    let daily: any;
    expect(() => {
      daily = require('../src/checkout/reconciliation-daily.cron');
    }).not.toThrow();
    const { ReconciliationDailyCron } = daily;
    const now = new Date('2026-11-06T11:00:00.000Z');
    const since = new Date(now.getTime() - 86_400_000);
    const owners = { findFirst: jest.fn().mockResolvedValue({ id: 'owner-role-account' }) };
    const prisma = { user: owners };
    const leases = { tryAcquire: jest.fn().mockResolvedValue(true), release: jest.fn().mockResolvedValue(undefined) };
    const reconcile = {
      runSweep: jest.fn()
        .mockResolvedValueOnce({
          scanned: 50, drifted: 0, unknown: 0, failed: 0,
          outcomes: Array.from({ length: 50 }, (_, i) => ({ purchase_id: `p${i}`, status: 'ok' })),
        })
        .mockResolvedValueOnce({
          scanned: 1, drifted: 0, unknown: 0, failed: 0,
          outcomes: [{ purchase_id: 'p50', status: 'ok' }],
        }),
    };
    const notes = {
      createNotification: jest.fn().mockResolvedValue({ id: 'inbox-row' }),
      pushToUser: jest.fn().mockResolvedValue({ delivered: true }),
    };
    const cron = new ReconciliationDailyCron(prisma, leases, reconcile, notes);
    const previous = process.env.RECONCILIATION_DAILY_ENABLED;
    delete process.env.RECONCILIATION_DAILY_ENABLED;
    try {
      expect(await cron.runOnce(now, 'machine-a', async () => {})).toMatchObject({
        ran: true, verdict: 'clean', tally: { checked: 51, ok: 51, drift: 0, unknown: 0, failed: 0 },
      });
    } finally {
      if (previous === undefined) delete process.env.RECONCILIATION_DAILY_ENABLED;
      else process.env.RECONCILIATION_DAILY_ENABLED = previous;
    }
    expect(reconcile.runSweep.mock.calls).toEqual([[50, { since, staleBefore: now }], [50, { since, staleBefore: now }]]);
    expect(notes.createNotification).toHaveBeenCalledTimes(1);
    expect(notes.createNotification.mock.calls[0][0]).toMatchObject({
      userId: 'owner-role-account', payload: { title: 'Money check: clean', checked: 51 },
    });
    expect(notes.pushToUser).toHaveBeenCalledTimes(1);
    expect(notes.pushToUser.mock.calls[0][0]).toBe('owner-role-account');
  });
});
