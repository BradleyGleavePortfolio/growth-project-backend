// B-CM7-120 ADAPTED REPLAY (never merge): the probe's own store and Stripe double gain what the op
// engine needs (TransferReversalOp table; transfer kind/settlement_id/reversal_seq; Stripe lists the
// reversals it made by metadata). Every change is marked 'B-CM7-120 adaptation'.
// AUDIT PROBE (AUD-OPUS-CM1-117, Claude Opus 5.5) — backend#676 @ cf5ef18b.
// Never merge. The REAL RefundDisputeHandlerService, SplitLedgerService and
// TransferOrchestratorService write the ledger on the PR's StatefulPrisma
// double; the REAL CoachMoneyService reads it through its own where clauses
// (test/support/money-read-double.ts). Only Stripe is synthetic.
//
// Part 1 (candidate B-676-3): the head-coach slice posting is stamped with
// `new Date()` after the Stripe call (transfer-orchestrator.service.ts
// recordReversal), the destination / fee postings with the refund's
// posted_at. buildMoneyCsv keys reversal rows by p.at, so one refund on a
// sale with a head-coach split becomes TWO `refund` rows in the seller's tax
// CSV, each carrying the full client_refunded amount.
// Part 2 (ruling 10-03 21:06: MRR and churned_30d exclude never-billed
// trials): churned_30d at this head.
import 'reflect-metadata';
import { CoachMoneyService, type MoneyWindow } from '../src/coach-money/coach-money.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { StatefulPrisma } from './support/stateful-prisma';
import { moneyReadPrisma } from './support/money-read-double';

const COACH = 'coach-1';
const HEAD = 'head-1';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const FIRST: MoneyWindow = { from: ago(60), to: ago(30) };
const SECOND: MoneyWindow = { from: ago(30), to: ago(-1) };
const LIFETIME: MoneyWindow = { from: ago(60), to: ago(-1) };

function store(): StatefulPrisma {
  const db = new StatefulPrisma();
  for (const m of ['user', 'coachPackage', 'clientPurchase', 'splitLedgerEntry', 'connectTransfer'])
    db.model(m);
  for (const m of ['guestCheckout', 'notification', 'dunningState', 'dunningAttempt']) db.model(m);
  db.model('connectAccount', [['id'], ['coach_user_id']]);
  // B-CM7-120 adaptation: the durable reversal op table.
  db.model('transferReversalOp', [['id'], ['idempotency_key'], ['stripe_reversal_id']], () => ({
    status: 'pending', attempts: 0, last_attempt_at: null, last_error: null,
    stripe_reversal_id: null, resolved_at: null, created_at: new Date(), updated_at: new Date(),
  }));
  db.model('chargeDispute', [['id'], ['stripe_dispute_id']], () => ({
    ledger_reversed: false,
    closed_at: null,
  }));
  db.model('chargeRefund', [['id'], ['stripe_refund_id'], ['transfer_reversal_stripe_id']], () => ({
    ledger_reversed: false,
    transfer_reversed: false,
    transfer_reversal_first_attempt_at: null,
    transfer_reversal_review_at: null,
    transfer_reversal_last_attempt_at: null,
    transfer_reversal_stripe_id: null,
  }));
  db.state.user.push(
    { id: COACH, name: 'Coach One' },
    { id: HEAD, name: 'Head Coach' },
    { id: 'client-1', name: 'Ana Ruiz' },
    { id: 'client-2', name: 'Bo Chen' },
    { id: 'client-3', name: 'Cy Diaz' },
  );
  db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly coaching', interval: 'month', interval_count: 1 });
  return db;
}

// 4,900-cent sale 50 days ago: destination 4,312, TGP fee 98, head-coach split 490 (transfer).
function seedSale(db: StatefulPrisma): void {
  const at = ago(50);
  db.state.clientPurchase.push({
    id: 'p-a',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'one_time',
    status: 'paid',
    entitlement_active: true,
    source: null,
    created_at: at,
    updated_at: at,
  });
  for (const [kind, amount, payee] of [
    ['destination', 4312, COACH],
    ['application_fee', 98, null],
    ['head_coach_split', 490, HEAD],
  ] as Array<[string, number, string | null]>) {
    db.state.splitLedgerEntry.push({
      id: `p-a-${kind}`,
      purchase_id: 'p-a',
      kind,
      payee_user_id: payee,
      amount_cents: amount,
      reversed_cents: 0,
      currency: 'usd',
      status: 'posted',
      stripe_charge_id: 'ch_a',
      posted_at: at,
      reversed_at: null,
      created_at: at,
      updated_at: at,
    });
  }
  db.state.connectTransfer.push({
    id: 'tr-a',
    kind: 'head_coach_split', settlement_id: null, reversal_seq: 0, // B-CM7-120 adaptation
    purchase_id: 'p-a',
    ledger_entry_id: 'p-a-head_coach_split',
    amount_cents: 490,
    reversed_amount_cents: 0,
    status: 'succeeded',
    stripe_transfer_id: 'tr_a',
    reversed_at: null,
  });
}

// Stripe answers after `latencyMs` (the clock moves, as it does in production).
function handler(db: StatefulPrisma, opts: { latencyMs?: number; failFirst?: boolean } = {}) {
  const ledger = Reflect.construct(SplitLedgerService, [db]);
  let calls = 0;
  const stripe = {
    retrieveCharge: jest.fn(async () => ({ payment_intent: null })),
    reverseTransfer: jest.fn(async (a: { amount: number; idempotencyKey: string }) => {
      calls += 1;
      if (opts.failFirst && calls === 1) {
        throw new StripeConnectApiError('Stripe unavailable', 503, 'api_error', 'api_error');
      }
      if (opts.latencyMs) jest.setSystemTime(Date.now() + opts.latencyMs);
      return { id: `trr_${a.idempotencyKey.replace(/[^A-Za-z0-9]/g, '')}`, amount: a.amount };
    }),
  };
  // B-CM7-120 adaptation: Stripe lists the reversals it made (metadata kept), complete.
  const madeRevs: Array<Record<string, unknown>> = [];
  const sendRev = stripe.reverseTransfer;
  (stripe as any).reverseTransfer = jest.fn(async (a: any) => {
    const r: any = await sendRev(a);
    if (!madeRevs.some((m) => m.id === r.id)) madeRevs.push({ ...r, metadata: a.metadata ?? {} });
    return r;
  });
  (stripe as any).listTransferReversals = jest.fn(async () => ({ data: madeRevs, has_more: false }));
  const transfers = Reflect.construct(TransferOrchestratorService, [db, stripe, ledger]);
  return Reflect.construct(RefundDisputeHandlerService, [
    db,
    stripe,
    ledger,
    transfers,
    { recordPayoutEvent: jest.fn(async () => null) },
    { createNotification: jest.fn(async () => undefined) },
  ]) as RefundDisputeHandlerService;
}

async function atTime<T>(t: Date, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(t);
  try {
    return await fn();
  } finally {
    jest.useRealTimers();
  }
}

const refundedEvent = (refunds: Array<[string, number]>) => ({
  id: `evt_${refunds.length}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_a',
      amount: 4900,
      amount_refunded: refunds.reduce((a, [, c]) => a + c, 0),
      refunded: false,
      refunds: { data: refunds.map(([id, amount]) => ({ id, amount, status: 'succeeded' })) },
    },
  },
});

function csvRows(csv: string): Array<Record<string, string>> {
  const [head, ...lines] = csv.trim().split('\r\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const cents = (s: string) => (s === '' ? 0 : Math.round(Number(s) * 100));

function money(db: StatefulPrisma): CoachMoneyService {
  return Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
}

describe('AUD-OPUS-CM1-117 #676 — one refund is one row in the seller tax CSV', () => {
  it('B-676-3a: a 980-cent refund on a head-coach-split sale with 1 s Stripe latency', async () => {
    const db = store();
    seedSale(db);
    await atTime(ago(40), () => handler(db, { latencyMs: 1000 }).handle(refundedEvent([['re_1', 980]])));
    const rows = csvRows(await money(db).exportCsv(COACH, FIRST)).filter((r) => r.type === 'refund');
    expect({
      refund_rows: rows.length,
      client_refunded_sum: rows.reduce((a, r) => a + cents(r.client_refunded), 0),
    }).toEqual({ refund_rows: 1, client_refunded_sum: 980 });
  });

  it('B-676-3b: head-coach reversal retried by the sweep 2 h later, across a window edge', async () => {
    const db = store();
    seedSale(db);
    const h = handler(db, { failFirst: true });
    const refundAt = new Date(FIRST.to.getTime() - HOUR);
    await atTime(refundAt, () => h.handle(refundedEvent([['re_1', 980]])));
    const sweepAt = new Date(FIRST.to.getTime() + HOUR);
    await atTime(sweepAt, () => h.retryPendingTransferReversals(sweepAt));
    const first = csvRows(await money(db).exportCsv(COACH, FIRST)).filter((r) => r.type === 'refund');
    const second = csvRows(await money(db).exportCsv(COACH, SECOND)).filter((r) => r.type === 'refund');
    // Fix-agnostic: across every file the refund is ONE refund row that carries
    // client_refunded, and client_refunded sums to the refund once.
    const all = [...first, ...second];
    expect({
      transfer_reversed: db.state.connectTransfer[0].reversed_amount_cents,
      refund_rows_with_client_refunded: all.filter((r) => r.client_refunded !== '').length,
      client_refunded_all_files: all.reduce((a, r) => a + cents(r.client_refunded), 0),
    }).toEqual({ transfer_reversed: 98, refund_rows_with_client_refunded: 1, client_refunded_all_files: 980 });
  });

  it('B-676-3c: a lost chargeback on a head-coach-split sale with 1 s Stripe latency', async () => {
    const db = store();
    seedSale(db);
    db.state.chargeDispute.push({
      id: 'cd-1',
      stripe_dispute_id: 'dp_1',
      purchase_id: 'p-a',
      stripe_charge_id: 'ch_a',
      amount_cents: 4900,
      status: 'needs_response',
      ledger_reversed: false,
      closed_at: null,
      created_at: ago(20),
      updated_at: ago(20),
    });
    await atTime(ago(5), () =>
      handler(db, { latencyMs: 1000 }).handle({
        id: 'evt_d',
        type: 'charge.dispute.closed',
        data: { object: { id: 'dp_1', status: 'lost' } },
      }),
    );
    const rows = csvRows(await money(db).exportCsv(COACH, SECOND)).filter((r) => r.type === 'chargeback');
    expect({
      chargeback_rows: rows.length,
      client_refunded_sum: rows.reduce((a, r) => a + cents(r.client_refunded), 0),
    }).toEqual({ chargeback_rows: 1, client_refunded_sum: 4900 });
  });

  it('control: same refund with frozen time (the builder spec setup) is one row', async () => {
    const db = store();
    seedSale(db);
    await atTime(ago(40), () => handler(db).handle(refundedEvent([['re_1', 980]])));
    const rows = csvRows(await money(db).exportCsv(COACH, FIRST)).filter((r) => r.type === 'refund');
    const lifetime = (await money(db).getSummary(HEAD, LIFETIME, null, NOW)).totals;
    expect([rows.length, rows.reduce((a, r) => a + cents(r.client_refunded), 0), lifetime.head_coach_income_cents]).toEqual([
      1,
      980,
      490 - 98,
    ]);
  });
});

describe('AUD-OPUS-CM1-117 #676 — churned_30d excludes never-billed trials (ruling 10-03)', () => {
  it('a free trial cancelled before it ever billed is not churn', async () => {
    const db = store();
    const base = {
      coach_user_id: COACH,
      package_id: 'pkg-1',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      source: null,
    };
    db.state.clientPurchase.push(
      // client-1: billing subscriber (control, paying).
      { ...base, id: 's-1', client_user_id: 'client-1', status: 'active', entitlement_active: true, canceled_at: null, created_at: ago(90), updated_at: ago(90) },
      // client-2: free trial cancelled 10 days ago, never billed (no ledger slice).
      { ...base, id: 's-2', client_user_id: 'client-2', status: 'canceled', entitlement_active: false, canceled_at: ago(10), created_at: ago(12), updated_at: ago(10) },
      // client-3: in a free trial now (counted apart, never churn).
      { ...base, id: 's-4', client_user_id: 'client-3', status: 'trialing', entitlement_active: true, canceled_at: null, created_at: ago(9), updated_at: ago(9) },
    );
    const out = await money(db).getSummary(COACH, LIFETIME, null, NOW);
    expect(out.recurring).toMatchObject({
      mrr_cents: 4900,
      paying_clients: 1,
      trial_clients: 1,
      churned_30d: 0,
    });
  });
});
