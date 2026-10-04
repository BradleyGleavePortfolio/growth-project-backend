// AUDIT PROBE (AUD-OPUS-CM-118, Claude Opus 5.5) — backend#676 @ ccd60bbc.
// Never merge. REAL RefundDisputeHandlerService / SplitLedgerService /
// TransferOrchestratorService write the ledger on the PR's StatefulPrisma
// double; the REAL CoachMoneyService reads it (test/support/money-read-double.ts).
// Only Stripe is synthetic. Store and helpers copied from the AUD-OPUS-CM1-117 probe.
//
// 1. Composed C-674-12 race (writer in #674): two overlapping succeeded
//    deliveries of one refund at the month's last millisecond; the delivery
//    without the ledger claim wins the head-coach record 1 ms later (April).
//    Controls: client_refunded once across both files, ledger-exact totals.
//    Expected red: the head-coach share is in the refund's own (March) row.
// 2. Candidate C-676-4: MRR / paying_clients count a recurring purchase that
//    never billed (post-trial first charge failed -> past_due, entitled
//    during dunning, no paid status, no ledger slice). Ruling 10-03: MRR
//    excludes never-billed trials. Expected red.
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

function csvRows(csv: string): Array<Record<string, string>> {
  const [head, ...lines] = csv.trim().split('\r\n');
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}
const cents = (s: string) => (s === '' ? 0 : Math.round(Number(s) * 100));

function money(db: StatefulPrisma): CoachMoneyService {
  return Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
}


const T0 = new Date('2027-03-31T23:59:59.999Z');
const MARCH: MoneyWindow = { from: new Date('2027-03-01T00:00:00.000Z'), to: new Date('2027-04-01T00:00:00.000Z') };
const APRIL: MoneyWindow = { from: new Date('2027-04-01T00:00:00.000Z'), to: new Date('2027-05-01T00:00:00.000Z') };

function seedTeamSale(db: StatefulPrisma, at: Date): void {
  db.state.clientPurchase.push({
    id: 'p-a', coach_user_id: COACH, client_user_id: 'client-1', package_id: 'pkg-1',
    amount_cents: 4900, currency: 'usd', billing_type: 'one_time', status: 'paid',
    entitlement_active: true, source: null, created_at: at, updated_at: at,
  });
  for (const [kind, amount, payee] of [
    ['destination', 4312, COACH],
    ['application_fee', 98, null],
    ['head_coach_split', 490, HEAD],
  ] as Array<[string, number, string | null]>) {
    db.state.splitLedgerEntry.push({
      id: `p-a-${kind}`, purchase_id: 'p-a', kind, payee_user_id: payee, amount_cents: amount,
      reversed_cents: 0, currency: 'usd', status: 'posted', stripe_charge_id: 'ch_a',
      posted_at: at, reversed_at: null, created_at: at, updated_at: at,
    });
  }
  db.state.connectTransfer.push({
    id: 'tr-a', purchase_id: 'p-a', ledger_entry_id: 'p-a-head_coach_split', amount_cents: 490,
    reversed_amount_cents: 0, status: 'succeeded', stripe_transfer_id: 'tr_a', reversed_at: null,
  });
}

describe('AUD-OPUS-CM-118 #676 — overlapping refund deliveries at a month edge, composed CSV', () => {
  afterEach(() => jest.useRealTimers());

  async function race() {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(T0);
    const db = store();
    seedTeamSale(db, new Date('2027-03-10T12:00:00.000Z'));
    db.state.chargeRefund.push({
      id: 'rf-1', stripe_refund_id: 're_1', purchase_id: 'p-a', stripe_charge_id: 'ch_a',
      amount_cents: 980, currency: 'usd', status: 'pending', posted_at: null, ledger_reversed: false,
      transfer_reversed: false, transfer_reversal_first_attempt_at: null, transfer_reversal_review_at: null,
      transfer_reversal_last_attempt_at: null, transfer_reversal_stripe_id: null,
      transfer_reversal_amount_cents: null, reason: null, note: null, initiated_by_user_id: null,
      failure_reason: null, created_at: new Date('2027-03-31T23:00:00.000Z'),
    });
    const ledger = Reflect.construct(SplitLedgerService, [db]);
    const byKey = new Map<string, { id: string; amount: number }>();
    let enterA!: () => void;
    const aAtStripe = new Promise<void>((r) => (enterA = r));
    let releaseA!: () => void;
    const aGo = new Promise<void>((r) => (releaseA = r));
    let calls = 0;
    const stripe = {
      retrieveCharge: jest.fn(async () => ({ payment_intent: null })),
      reverseTransfer: jest.fn(async (a: { amount: number; idempotencyKey: string }) => {
        calls += 1;
        if (calls === 1) {
          enterA();
          await aGo;
        }
        const seen = byKey.get(a.idempotencyKey);
        if (seen) return seen;
        const made = { id: `trr_${byKey.size + 1}`, amount: a.amount };
        byKey.set(a.idempotencyKey, made);
        return made;
      }),
    };
    const transfers = Reflect.construct(TransferOrchestratorService, [db, stripe, ledger]);
    const svc = Reflect.construct(RefundDisputeHandlerService, [
      db, stripe, ledger, transfers,
      { recordPayoutEvent: jest.fn(async () => null) },
      { createNotification: jest.fn(async () => undefined) },
    ]) as RefundDisputeHandlerService;
    const refunded = (id: string) => ({
      id, type: 'charge.refunded',
      data: { object: { id: 'ch_a', amount: 4900, amount_refunded: 980, refunded: false,
        refunds: { data: [{ id: 're_1', amount: 980, status: 'succeeded' }] } } },
    });
    const a = svc.handle(refunded('evt_a'));
    await aAtStripe;
    jest.setSystemTime(T0.getTime() + 1);
    await svc.handle(refunded('evt_b'));
    releaseA();
    await a;
    jest.useRealTimers();
    const march = csvRows(await money(db).exportCsv(COACH, MARCH));
    const april = csvRows(await money(db).exportCsv(COACH, APRIL));
    return { db, march, april, byKey };
  }

  it('control (expected green): client_refunded once across files; ledger-exact totals; one Stripe reversal', async () => {
    const { db, march, april, byKey } = await race();
    const refundRows = [...march, ...april].filter((r) => r.type === 'refund');
    expect({
      stripe_reversals: byKey.size,
      transfer: db.state.connectTransfer[0].reversed_amount_cents,
      rows_with_client_refunded: refundRows.filter((r) => r.client_refunded !== '').length,
      client_refunded_all_files: refundRows.reduce((acc, r) => acc + cents(r.client_refunded), 0),
      head_coach_share_all_files: refundRows.reduce((acc, r) => acc + cents(r.head_coach_share), 0),
      net_to_you_all_files: refundRows.reduce((acc, r) => acc + cents(r.net_to_you), 0),
    }).toEqual({
      stripe_reversals: 1,
      transfer: 98,
      rows_with_client_refunded: 1,
      client_refunded_all_files: 980,
      head_coach_share_all_files: -98,
      net_to_you_all_files: -862,
    });
  });

  it('C-674-12 composed (expected red): the head-coach share sits on the refund row of its own month', async () => {
    const { march, april } = await race();
    const m = march.filter((r) => r.type === 'refund');
    const a = april.filter((r) => r.type === 'refund');
    expect({ march_rows: m.length, march_head: m.map((r) => r.head_coach_share), april_rows: a.length }).toEqual({
      march_rows: 1,
      march_head: ['-0.98'],
      april_rows: 0,
    });
  });
});

describe('AUD-OPUS-CM-118 #676 — MRR excludes a subscription that never billed (ruling 10-03)', () => {
  it('C-676-4 (expected red): post-trial past_due with no paid status and no ledger slice is not MRR', async () => {
    const NOW = new Date();
    const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    const db = store();
    const base = {
      coach_user_id: COACH, package_id: 'pkg-1', amount_cents: 4900, currency: 'usd',
      billing_type: 'recurring', source: null, canceled_at: null,
    };
    db.state.clientPurchase.push(
      // client-1: billed subscriber with a posted destination slice (control).
      { ...base, id: 's-1', client_user_id: 'client-1', status: 'active', entitlement_active: true, created_at: ago(90), updated_at: ago(90) },
      // client-2: trial ended 2 days ago, first charge failed: past_due, entitled during dunning, never billed.
      { ...base, id: 's-2', client_user_id: 'client-2', status: 'past_due', entitlement_active: true, created_at: ago(9), updated_at: ago(2) },
    );
    db.state.splitLedgerEntry.push({
      id: 's-1-destination', purchase_id: 's-1', kind: 'destination', payee_user_id: COACH, amount_cents: 4312,
      reversed_cents: 0, currency: 'usd', status: 'posted', stripe_charge_id: 'ch_s1',
      posted_at: ago(20), reversed_at: null, created_at: ago(20), updated_at: ago(20),
    });
    const out = await money(db).getSummary(COACH, { from: ago(30), to: ago(-1) }, null, NOW);
    expect({ mrr: out.recurring.mrr_cents, paying: out.recurring.paying_clients }).toEqual({ mrr: 4900, paying: 1 });
  });
});
