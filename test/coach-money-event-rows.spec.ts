// B-676-3 (reader, B-CM-117): the seller tax CSV has one row per money
// movement (one refund / chargeback id at one time), and what the client got
// back appears once, on the row at the event's own time. B-676-4: only a
// purchase that billed can churn, and a client still on a free trial has not
// left.
import 'reflect-metadata';
import {
  buildMoneyCsv,
  CoachMoneyService,
  MoneyWindow,
  ReversalEvent,
  ReversalPosting,
  ReversedSliceRow,
  WindowSlices,
} from '../src/coach-money/coach-money.service';
import { moneyReadPrisma } from './support/money-read-double';
import { StatefulPrisma } from './support/stateful-prisma';

const COACH = 'coach-1';
const SEP: MoneyWindow = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
const OCT: MoneyWindow = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };
const T = (iso: string) => new Date(iso);

type Event = { id: string; at: Date; cents: number };
const post = (e: Event, cents: number, at = e.at): ReversalPosting => ({
  source_kind: 'refund',
  source_id: e.id,
  cents,
  posted_at: at,
});

function slice(kind: string, amount: number, events: Event[], postings: ReversalPosting[]): ReversedSliceRow {
  return {
    kind,
    payee_user_id: kind === 'destination' ? COACH : kind === 'head_coach_split' ? 'head-1' : null,
    amount_cents: amount,
    reversed_cents: postings.reduce((a, p) => a + p.cents, 0),
    status: 'posted',
    purchase_id: 'p1',
    currency: 'usd',
    stripe_charge_id: 'ch_1',
    posted_at: T('2026-08-10T00:00:00Z'),
    reversed_at: null,
    created_at: T('2026-08-10T00:00:00Z'),
    client_name: 'Ana Ruiz',
    package_name: 'Monthly coaching',
    events: events.map((e): ReversalEvent => ({
      kind: 'refund',
      at: e.at,
      amount_cents: e.cents,
      stripe_charge_id: 'ch_1',
      source_id: e.id,
    })),
    postings,
  };
}

function rows(window: MoneyWindow, reversedSeller: ReversedSliceRow[]) {
  const slices: WindowSlices = { salesSeller: [], salesIncome: [], reversedSeller, reversedIncome: [] };
  const [head, ...lines] = buildMoneyCsv(COACH, window, slices).trim().split('\r\n');
  const cols = head.split(',');
  return lines
    .map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])))
    .map((r) => [r.date_utc, r.client_refunded, r.head_coach_share, r.net_to_you, r.tgp_fee]);
}

describe('B-676-3 — one CSV row per money movement, client_refunded once per event', () => {
  it('a head-coach recovery 2 hours after its refund is its own row without client_refunded', () => {
    const e = { id: 'r-1', at: T('2026-09-10T10:00:00.000Z'), cents: 980 };
    const later = T('2026-09-10T12:00:00.000Z');
    const out = rows(SEP, [
      slice('destination', 4802, [e], [post(e, 960)]),
      slice('application_fee', 98, [e], [post(e, 20)]),
      slice('head_coach_split', 245, [e], [post(e, 49, later)]),
    ]);
    expect(out).toEqual([
      ['2026-09-10T10:00:00.000Z', '9.80', '0.00', '-9.60', '-0.20'],
      ['2026-09-10T12:00:00.000Z', '', '-0.49', '0.00', '0.00'],
    ]);
  });

  it('two refunds in the same millisecond keep their own rows: client_refunded 0.99 + 1.01', () => {
    const at = T('2026-09-12T08:00:00.000Z');
    const a = { id: 'r-a', at, cents: 99 };
    const b = { id: 'r-b', at, cents: 101 };
    const out = rows(SEP, [slice('destination', 4802, [a, b], [post(a, 97), post(b, 98)])]);
    expect(out.map((r) => r[1]).sort()).toEqual(['0.99', '1.01']);
    expect(out.map((r) => r[3]).sort()).toEqual(['-0.97', '-0.98']);
  });

  it('a recovery dated in the next window shows there with no client_refunded; the first file is unchanged', () => {
    const e = { id: 'r-1', at: T('2026-09-30T23:00:00.000Z'), cents: 2450 };
    const parts = [post(e, 2401)];
    const sep = rows(SEP, [slice('destination', 4802, [e], parts)]);
    const head = slice('head_coach_split', 245, [e], [post(e, 122, T('2026-10-01T01:00:00.000Z'))]);
    expect(rows(SEP, [slice('destination', 4802, [e], parts), head])).toEqual(sep);
    expect(rows(OCT, [slice('destination', 4802, [e], parts), head])).toEqual([
      ['2026-10-01T01:00:00.000Z', '', '-1.22', '0.00', '0.00'],
    ]);
  });
});

describe('B-676-4 — churn counts only billed purchases of clients who left', () => {
  const NOW = T('2026-09-30T00:00:00.000Z');
  const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
  function recurring(purchases: Array<[string, string, string, boolean, Date | null, boolean]>) {
    const db = new StatefulPrisma();
    for (const m of ['user', 'coachPackage', 'clientPurchase', 'splitLedgerEntry', 'chargeRefund'])
      db.model(m);
    for (const m of ['chargeDispute', 'connectTransfer', 'connectAccount', 'dunningState', 'dunningAttempt'])
      db.model(m);
    db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly', interval: 'month', interval_count: 1 });
    for (const [id, client, status, entitled, canceledAt, billed] of purchases) {
      db.state.clientPurchase.push({
        id,
        coach_user_id: COACH,
        client_user_id: client,
        package_id: 'pkg-1',
        amount_cents: 4900,
        currency: 'usd',
        billing_type: 'recurring',
        source: null,
        status,
        entitlement_active: entitled,
        canceled_at: canceledAt,
        created_at: ago(60),
        updated_at: ago(1),
      });
      if (billed) {
        db.state.splitLedgerEntry.push({
          id: `${id}-dest`,
          purchase_id: id,
          kind: 'destination',
          payee_user_id: COACH,
          amount_cents: 4802,
          reversed_cents: 0,
          currency: 'usd',
          status: 'posted',
          stripe_charge_id: `ch_${id}`,
          posted_at: ago(40),
          reversed_at: null,
          created_at: ago(40),
        });
      }
    }
    const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
    return svc.getSummary(COACH, { from: ago(30), to: NOW }, null, NOW).then((s) => s.recurring);
  }

  it('a trial cancelled before its first bill is not churn; a billed cancellation is', async () => {
    await expect(
      recurring([
        ['s-trial', 'client-1', 'canceled', false, ago(5), false],
        ['s-paid', 'client-2', 'canceled', false, ago(5), true],
      ]),
    ).resolves.toMatchObject({ churned_30d: 1, mrr_cents: 0, paying_clients: 0, trial_clients: 0 });
  });

  it('a client who cancelled plan A and is trialing plan B is not churn', async () => {
    await expect(
      recurring([
        ['s-a', 'client-1', 'canceled', false, ago(5), true],
        ['s-b', 'client-1', 'trialing', true, null, false],
      ]),
    ).resolves.toMatchObject({ churned_30d: 0, trial_clients: 1, paying_clients: 0, mrr_cents: 0 });
  });
});
