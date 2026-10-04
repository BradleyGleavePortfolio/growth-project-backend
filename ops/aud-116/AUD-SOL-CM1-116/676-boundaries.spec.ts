import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { CoachConnectService } from '../src/coach-connect/coach-connect.service';
import { harness, seedPurchase, HOUR } from './support/refund-reversal-harness';
import { moneyReadPrisma } from './support/money-read-double';

describe('Sol independent M3 boundary probes at 564f33bf', () => {
  afterEach(() => jest.useRealTimers());

  it('a second partial refund cannot rewrite the first refund day or its tax CSV by a cent', async () => {
    const h = harness();
    h.db.model('chargeDispute');
    h.db.state.connectTransfer.length = 0;
    const today = new Date();
    const firstDay = new Date(today.getTime() - 72 * HOUR);
    const secondDay = new Date(today.getTime() - 24 * HOUR);
    seedPurchase(h.db, 'p-partial', new Date(today.getTime() - 120 * HOUR));
    h.db.state.connectTransfer.length = 0;
    const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(h.db)]);
    const firstWindow = { from: firstDay, to: new Date(firstDay.getTime() + HOUR) };
    const event = (id: string, refunds: Array<{id: string; amount: number; status: string}>) => ({
      id, type: 'charge.refunded', data: { object: {
        id: 'ch_p-partial', amount: 4900,
        amount_refunded: refunds.reduce((a, r) => a + r.amount, 0),
        refunded: false, refunds: { data: refunds },
      } },
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
    jest.setSystemTime(firstDay);
    const first = { id: 're_first', amount: 99, status: 'succeeded' };
    await h.svc.handle(event('evt_first', [first]));
    const before = await svc.totalsFor('coach-1', firstWindow, 'usd');
    const csvBefore = await svc.exportCsv('coach-1', firstWindow, 'usd');
    expect(before.net_cents).toBe(-97);
    jest.setSystemTime(secondDay);
    await h.svc.handle(event('evt_second', [
      first, { id: 're_second', amount: 101, status: 'succeeded' },
    ]));
    expect(h.db.state.splitLedgerEntry.find((r) => r.kind === 'destination')!.reversed_cents)
      .toBe(195);
    const after = await svc.totalsFor('coach-1', firstWindow, 'usd');
    const csvAfter = await svc.exportCsv('coach-1', firstWindow, 'usd');
    expect({ netBefore: before.net_cents, netAfter: after.net_cents, csvUnchanged: csvAfter === csvBefore })
      .toEqual({ netBefore: -97, netAfter: -97, csvUnchanged: true });
  });

  it('new Connect refresh failure handler does not emit provider free text', async () => {
    const now = new Date();
    const prisma = { connectAccount: {
      findUnique: jest.fn(async () => ({
        stripe_account_id: 'acct_1', updated_at: now, charges_enabled: false,
        payouts_enabled: false, details_submitted: false, requirements_due: null,
      })),
    } };
    const svc: CoachConnectService = Reflect.construct(CoachConnectService, [
      prisma,
      { syncFromStripe: async () => { throw new Error('AUDIT_PRIVATE_CANARY_contact_at_example_invalid'); } },
      { isConfigured: () => true }, {}, {}, {},
    ]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect((await svc.refreshStatus('coach-1')).refreshed).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('AUDIT_PRIVATE_CANARY');
    } finally {
      warn.mockRestore();
    }
  });
});
