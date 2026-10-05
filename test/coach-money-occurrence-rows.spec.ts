// B-676-3 (reader, B-CM3-117): every succeeded refund and lost chargeback of
// the coach's own sale has its tax CSV row with what the client got back,
// read from the event row itself, even when every ledger portion rounded to
// zero. Ledger totals stay exact (no cent is invented on the ledger side).
import 'reflect-metadata';
import {
  buildMoneyCsv,
  CoachMoneyService,
  MONEY_EXPORT_MAX_ROWS,
  MoneyOccurrence,
  MoneyWindow,
  ReversedSliceRow,
} from '../src/coach-money/coach-money.service';
import { HOUR, harness, seedPurchase } from './support/refund-reversal-harness';
import { moneyReadPrisma } from './support/money-read-double';

type Row = Record<string, any>;
const COACH = 'coach-1';
const T = (iso: string) => new Date(iso);
const AT = T('2027-03-21T10:00:00.000Z');
const HOUR_WINDOW: MoneyWindow = { from: AT, to: new Date(AT.getTime() + HOUR) };
// [at, type, stripe_charge_id, currency, client_refunded, head_coach_share, net_to_you]
const cols = (csv: string) =>
  csv
    .trim()
    .split('\r\n')
    .slice(1)
    .map((l) => l.split(','))
    .map((c) => [c[0], c[1], c[3], c[6], c[8], c[11], c[12]]);

afterEach(() => jest.useRealTimers());

function seller() {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(AT);
  const h = harness();
  seedPurchase(h.db, 'p-1', new Date(AT.getTime() - HOUR));
  h.db.state.connectTransfer.length = 0; // An ordinary seller, no team share.
  const read = moneyReadPrisma(h.db);
  const money: CoachMoneyService = Reflect.construct(CoachMoneyService, [read]);
  return { ...h, read, money };
}

describe('B-676-3 — a refund or chargeback whose ledger portions round to zero keeps its row', () => {
  it('two one-cent refunds in one millisecond and a one-cent lost chargeback: three rows, totals 0', async () => {
    const h = seller();
    await h.svc.handle({
      id: 'evt_r',
      type: 'charge.refunded',
      data: {
        object: {
          ...{ id: 'ch_p-1', amount: 4900, amount_refunded: 2, refunded: false },
          refunds: {
            data: [
              { id: 're_a', amount: 1, status: 'succeeded' },
              { id: 're_b', amount: 1, status: 'succeeded' },
            ],
          },
        },
      },
    });
    h.db.state.chargeDispute.push({
      ...{ id: 'cd-1', stripe_dispute_id: 'dp_1', purchase_id: 'p-1', stripe_charge_id: 'ch_p-1' },
      ...{ amount_cents: 1, currency: 'usd', status: 'needs_response', ledger_reversed: false },
      ...{ closed_at: null, created_at: AT, updated_at: AT },
    });
    await h.svc.handle({
      id: 'evt_d',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost' } },
    });
    expect(h.db.state.chargeDispute[0]).toMatchObject({ status: 'lost', ledger_reversed: true });
    expect(h.db.state.splitLedgerReversal).toHaveLength(0);
    const csv = await h.money.exportCsv(COACH, HOUR_WINDOW, 'usd');
    const row = (type: string) => [AT.toISOString(), type, 'ch_p-1', 'USD', '0.01', '0.00', '0.00'];
    expect(cols(csv)).toEqual([row('refund'), row('refund'), row('chargeback')]);
    expect((await h.money.totalsFor(COACH, HOUR_WINDOW, 'usd')).net_cents).toBe(0);
  });

  it("only the coach's own sales in the export currency; another charge keeps its own charge id", async () => {
    const h = seller();
    seedPurchase(h.db, 'p-x', new Date(AT.getTime() - HOUR));
    seedPurchase(h.db, 'p-gbp', new Date(AT.getTime() - HOUR));
    const [, foreign, gbp] = h.db.state.clientPurchase as Row[];
    foreign.coach_user_id = 'coach-2';
    gbp.currency = 'gbp';
    for (const s of h.db.state.splitLedgerEntry as Row[]) {
      if (s.purchase_id === 'p-gbp') s.currency = 'gbp';
    }
    const refund = (id: string, purchase: string, charge: string, extra: Row = {}) =>
      h.db.state.chargeRefund.push({
        ...{ id, stripe_refund_id: `re_${id}`, purchase_id: purchase, stripe_charge_id: charge },
        ...{ amount_cents: 1, status: 'succeeded', posted_at: AT, created_at: AT, ...extra },
      });
    refund('r-1', 'p-1', 'ch_p-1');
    refund('r-2', 'p-1', 'ch_p-1-renewal');
    refund('r-pending', 'p-1', 'ch_p-1', { status: 'pending', posted_at: null });
    refund('r-late', 'p-1', 'ch_p-1', { posted_at: HOUR_WINDOW.to });
    refund('r-foreign', 'p-x', 'ch_p-x');
    refund('r-gbp', 'p-gbp', 'ch_p-gbp');
    const csv = await h.money.exportCsv(COACH, HOUR_WINDOW, 'usd');
    expect(cols(csv).map((c) => c[2])).toEqual(['ch_p-1', 'ch_p-1-renewal']);
    const all = await h.money.exportCsv(COACH, HOUR_WINDOW);
    expect(cols(all).map((c) => [c[2], c[3]])).toEqual([
      ['ch_p-1', 'USD'],
      ['ch_p-1-renewal', 'USD'],
      ['ch_p-gbp', 'GBP'],
    ]);
  });

  it('a period with more refunds than one file holds is MONEY_EXPORT_TOO_LARGE', async () => {
    const h = seller();
    const take: number[] = [];
    h.read.chargeRefund.findMany = async (args: Row) => {
      take.push(args.take);
      return Array.from({ length: args.take }, () => ({}));
    };
    await expect(h.money.exportCsv(COACH, HOUR_WINDOW)).rejects.toMatchObject({
      response: { code: 'MONEY_EXPORT_TOO_LARGE' },
    });
    expect(take).toEqual([MONEY_EXPORT_MAX_ROWS + 1]);
  });
});

describe('B-676-3 — window boundaries and a later head-coach recovery', () => {
  const SEP: MoneyWindow = { from: T('2026-09-01T00:00:00Z'), to: T('2026-10-01T00:00:00Z') };
  const OCT: MoneyWindow = { from: SEP.to, to: T('2026-11-01T00:00:00Z') };
  const last = new Date(SEP.to.getTime() - 1);
  const occ = (source_id: string, at: Date): MoneyOccurrence => ({
    kind: 'refund',
    source_id,
    purchase_id: 'p1',
    stripe_charge_id: 'ch_1',
    currency: 'usd',
    at,
    amount_cents: 2450,
    client_name: 'Ana',
    package_name: 'Monthly',
  });
  const head: ReversedSliceRow = {
    ...{
      kind: 'head_coach_split',
      payee_user_id: 'head-1',
      amount_cents: 245,
      reversed_cents: 122,
    },
    ...{ status: 'posted', purchase_id: 'p1', currency: 'usd', stripe_charge_id: 'ch_1' },
    ...{ posted_at: T('2026-08-01T00:00:00Z'), reversed_at: null, created_at: T('2026-08-01') },
    ...{ client_name: 'Ana', package_name: 'Monthly' },
    events: [
      { kind: 'refund', at: last, amount_cents: 2450, stripe_charge_id: 'ch_1', source_id: 'r1' },
    ],
    // The sweep recovered the head-coach share one hour into October.
    postings: [
      { source_kind: 'refund', source_id: 'r1', cents: 122, posted_at: T('2026-10-01T01:00:00Z') },
    ],
  };
  const csv = (w: MoneyWindow) =>
    cols(
      buildMoneyCsv(COACH, w, {
        ...{ salesSeller: [], salesIncome: [], reversedSeller: [head], reversedIncome: [] },
        occurrences: [occ('r1', last), occ('r2', SEP.to)],
      }),
    );

  it('an event at the last millisecond is September; one at the boundary and the recovery are October', () => {
    expect(csv(SEP)).toEqual([
      [last.toISOString(), 'refund', 'ch_1', 'USD', '24.50', '0.00', '0.00'],
    ]);
    expect(csv(OCT)).toEqual([
      [SEP.to.toISOString(), 'refund', 'ch_1', 'USD', '24.50', '0.00', '0.00'],
      ['2026-10-01T01:00:00.000Z', 'refund', 'ch_1', 'USD', '', '-1.22', '0.00'],
    ]);
  });
});
