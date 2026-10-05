import 'reflect-metadata';
import { CoachMoneyService, MONEY_CSV_COLUMNS } from '../src/coach-money/coach-money.service';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';
import { moneyReadPrisma } from './support/money-read-double';

// Independent real refund writer -> real Money query/fold/export. No
// candidate-source changes. Clock shifts model time spent at Stripe (or a
// later retry), not invented read-side reversal cents.
describe('Sol agent 117 — exact M3 Money accounting boundaries', () => {
  afterEach(() => jest.useRealTimers());
  const time = () => {
    const today = new Date();
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(today);
    return today;
  };
  const rows = (csv: string) => {
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(MONEY_CSV_COLUMNS.join(','));
    return lines.slice(1).map((l) => l.split(','));
  };
  const sum = (csv: string, index: number) =>
    rows(csv).reduce((n, r) => n + Math.round(Number(r[index] || 0) * 100), 0);
  const refundEvent = (id: string, refunds: Array<{ id: string; amount: number }>) => ({
    id,
    type: 'charge.refunded',
    data: { object: {
      id: 'ch_p-audit', amount: 4900,
      amount_refunded: refunds.reduce((n, r) => n + r.amount, 0),
      refunded: false,
      refunds: { data: refunds.map((r) => ({ ...r, status: 'succeeded' })) },
    } },
  });
  const fixture = (at: Date, team = false) => {
    const h = harness();
    h.db.model('chargeDispute');
    seedPurchase(h.db, 'p-audit', new Date(at.getTime() - 120 * HOUR));
    if (team) {
      const fee = h.db.state.splitLedgerEntry.find((r) => r.kind === 'application_fee')!;
      const dest = h.db.state.splitLedgerEntry.find((r) => r.kind === 'destination')!;
      dest.amount_cents = 4557; // 4,900 = destination 4,557 + fee 98 + head 245
      h.db.state.splitLedgerEntry.push({
        ...fee, id: 'p-audit-head', kind: 'head_coach_split',
        payee_user_id: 'head-1', amount_cents: 245, reversed_cents: 0,
      });
      h.db.state.connectTransfer[0].ledger_entry_id = 'p-audit-head';
    } else {
      h.db.state.connectTransfer.length = 0;
    }
    const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(h.db)]);
    return { ...h, money };
  };

  it('B-676-3: one refund exports client_refunded once when the head share posts 1ms later', async () => {
    const at = time();
    const h = fixture(at, true);
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (args) => {
      const receipt = await provider(args);
      jest.setSystemTime(new Date(at.getTime() + 1));
      return receipt;
    });
    await h.svc.handle(refundEvent('evt_one', [{ id: 're_one', amount: 2450 }]));
    const row = h.db.state.chargeRefund[0];
    expect(row).toMatchObject({ amount_cents: 2450, ledger_reversed: true, transfer_reversed: true });
    expect(h.db.state.splitLedgerReversal.map((p) => p.cents).sort((a, b) => a - b))
      .toEqual([49, 122, 2278]);
    const w = { from: at, to: new Date(at.getTime() + HOUR) };
    const csv = await h.money.exportCsv('coach-1', w, 'usd');
    const totals = await h.money.totalsFor('coach-1', w, 'usd');
    expect(sum(csv, 12)).toBe(totals.net_cents);
    expect(totals.refunded_cents).toBe(2278);
    console.log('AUDIT_TEAM_REFUND', JSON.stringify({ csv, refundedTotal: sum(csv, 8) }));
    expect(sum(csv, 8)).toBe(2450);
  });

  it('B-676-3: a delayed head-share recovery is not a second client refund in the next window', async () => {
    const at = time();
    const h = fixture(at, true);
    h.reverseTransfer.mockRejectedValueOnce(new Error('synthetic provider failure'));
    await h.svc.handle(refundEvent('evt_delay', [{ id: 're_delay', amount: 2450 }]));
    const initial = { from: at, to: new Date(at.getTime() + HOUR) };
    const initialCsv = await h.money.exportCsv('coach-1', initial, 'usd');
    expect(sum(initialCsv, 8)).toBe(2450);
    const later = new Date(at.getTime() + 2 * HOUR);
    jest.setSystemTime(later);
    await h.svc.retryPendingTransferReversals(later);
    const next = { from: later, to: new Date(later.getTime() + HOUR) };
    expect(h.refund(h.db.state.chargeRefund[0].id).transfer_reversed).toBe(true);
    const csv = await h.money.exportCsv('coach-1', next, 'usd');
    const totals = await h.money.totalsFor('coach-1', next, 'usd');
    expect([sum(csv, 12), totals.net_cents]).toEqual([0, 0]);
    expect(totals.head_coach_split_cents).toBe(-122);
    expect(await h.money.exportCsv('coach-1', initial, 'usd')).toBe(initialCsv);
    console.log('AUDIT_DELAYED_HEAD_REFUND', JSON.stringify({ csv, refundedTotal: sum(csv, 8) }));
    expect(sum(csv, 8)).toBe(0);
  });

  it('B-676-3: two distinct refund ids at one millisecond retain both client-refund amounts', async () => {
    const at = time();
    const h = fixture(at);
    await h.svc.handle(refundEvent('evt_two', [
      { id: 're_99', amount: 99 }, { id: 're_101', amount: 101 },
    ]));
    expect(h.db.state.chargeRefund).toHaveLength(2);
    expect(h.db.state.splitLedgerReversal.filter((p) => p.entry_id === 'p-audit-destination')
      .map((p) => p.cents)).toEqual([97, 98]);
    const csv = await h.money.exportCsv('coach-1', { from: at, to: new Date(at.getTime() + HOUR) }, 'usd');
    expect(sum(csv, 12)).toBe(-195);
    console.log('AUDIT_SAME_MILLISECOND_REFUNDS', JSON.stringify({ csv, refundedTotal: sum(csv, 8) }));
    expect(sum(csv, 8)).toBe(200);
  });

  it('B-676-4: a never-billed canceled trial is not churn; an actually billed canceled client is', async () => {
    const now = time();
    const h = fixture(now);
    const base = h.db.state.clientPurchase[0];
    base.status = 'canceled';
    base.entitlement_active = false;
    base.canceled_at = new Date(now.getTime() - HOUR);
    h.db.state.clientPurchase.push({
      ...base, id: 'p-canceled-trial', client_user_id: 'trial-client',
      stripe_checkout_session_id: 'cs_trial', stripe_subscription_id: 'sub_trial',
      created_at: new Date(now.getTime() - 5 * HOUR),
      // No settled charge, split, succeeded invoice or payment for this purchase.
    });
    const w = { from: new Date(now.getTime() - 30 * 24 * HOUR), to: new Date(now.getTime() + HOUR) };
    const summary = await h.money.getSummary('coach-1', w, null, now, 'usd');
    expect(summary.recurring).toMatchObject({ mrr_cents: 0, paying_clients: 0, trial_clients: 0 });
    console.log('AUDIT_TRIAL_CHURN', JSON.stringify(summary.recurring));
    expect(summary.recurring.churned_30d).toBe(1);
  });
});
