// AUD-SOL-CM2-117: deliberately no-op two writer boundaries in a COPY of
// the moved spec. A green run demonstrates an optional assertion-strength
// gap, not a defect in the unmodified candidate writers.
// B-676-1 (B-CM1-116, M3 tests moved to the M4 piece for size): Money reports
// each refund / lost chargeback with the cents the real writer posted for it,
// at the event's own time, so a later event never rewrites an earlier window
// or its tax CSV, and lifetime equals the sum of its windows. At 564f33bf the
// reader re-split the cumulative reversed_cents across all events on every
// read (99 + 101 posted as 97 + 98, then shown as 97 / 98 / 98 / 97 ...).
// Also the AUD-OPUS-CM2-116 ruling: MRR excludes free trials, counted apart.
import 'reflect-metadata';
import { CoachMoneyService, type MoneyWindow } from '../src/coach-money/coach-money.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StatefulPrisma } from './support/stateful-prisma';
import { moneyReadPrisma } from './support/money-read-double';

const COACH = 'coach-1';
const HEAD = 'head-1';
const DAY = 86_400_000;
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
  db.model('chargeRefund', [['id'], ['stripe_refund_id']], () => ({
    ledger_reversed: false,
    transfer_reversed: false,
  }));
  db.state.user.push(
    { id: COACH, name: 'Coach One' },
    { id: HEAD, name: 'Head Coach' },
    { id: 'client-1', name: 'Ana Ruiz' },
  );
  db.state.coachPackage.push({
    id: 'pkg-1',
    name: 'Monthly coaching',
    interval: 'month',
    interval_count: 1,
  });
  return db;
}

// A 4,900-cent sale 50 days ago: TGP fee 98, destination 4,802 or, with a
// head coach, 4,312 plus a 490-cent head_coach_split slice paid by transfer.
function seedSale(db: StatefulPrisma, withHead = false): void {
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
  const slices: Array<[string, number, string | null]> = [
    ['destination', withHead ? 4312 : 4802, COACH],
    ['application_fee', 98, null],
  ];
  if (withHead) slices.push(['head_coach_split', 490, HEAD]);
  for (const [kind, amount, payee] of slices) {
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
  if (withHead) {
    db.state.connectTransfer.push({
      id: 'tr-a',
      purchase_id: 'p-a',
      ledger_entry_id: 'p-a-head_coach_split',
      amount_cents: 490,
      reversed_amount_cents: 0,
      status: 'succeeded',
      stripe_transfer_id: 'tr_a',
      reversed_at: null,
    });
  }
}

function handler(db: StatefulPrisma): RefundDisputeHandlerService {
  const ledger = Reflect.construct(SplitLedgerService, [db]);
  if (expect.getState().currentTestName?.includes('head_coach_split slice:')) {
    const original = Reflect.get(ledger, 'applyReversal');
    Reflect.set(
      ledger,
      'applyReversal',
      async (args: { entry_id: string }, tx: StatefulPrisma = db) =>
        args.entry_id === 'p-a-head_coach_split'
          ? tx.splitLedgerEntry.findUniqueOrThrow({ where: { id: args.entry_id } })
          : Reflect.apply(original, ledger, [args, tx]),
    );
  }
  const stripe = {
    retrieveCharge: jest.fn(async () => ({ payment_intent: null })),
    reverseTransfer: jest.fn(async (a: { amount: number }) => ({
      id: `trr_${a.amount}`,
      amount: a.amount,
    })),
  };
  const transfers = Reflect.construct(TransferOrchestratorService, [db, stripe, ledger]);
  const notifications = { createNotification: jest.fn(async () => undefined) };
  const payouts = { recordPayoutEvent: jest.fn(async () => null) };
  return Reflect.construct(RefundDisputeHandlerService, [
    db,
    stripe,
    ledger,
    transfers,
    payouts,
    notifications,
  ]);
}

// Runs one webhook at `at` (the event's own time).
async function at(
  day: number,
  db: StatefulPrisma,
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
) {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
  });
  jest.setSystemTime(ago(day));
  try {
    if (
      expect.getState().currentTestName?.includes('a lost chargeback after a partial refund') &&
      event.type === 'charge.dispute.closed'
    ) {
      return;
    }
    await handler(db).handle(event);
  } finally {
    jest.useRealTimers();
  }
}

const refunded = (amountRefunded: number, refunds: Array<[string, number]>) => ({
  id: `evt_${refunds.length}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_a',
      amount: 4900,
      amount_refunded: amountRefunded,
      refunded: false,
      refunds: { data: refunds.map(([id, amount]) => ({ id, amount, status: 'succeeded' })) },
    },
  },
});

async function view(db: StatefulPrisma, coach: string) {
  const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
  const totals = async (w: MoneyWindow) => (await svc.getSummary(coach, w, null, NOW)).totals;
  return {
    first: await totals(FIRST),
    second: await totals(SECOND),
    lifetime: await totals(LIFETIME),
    csv: (await svc.exportCsv(coach, FIRST)).trim(),
  };
}

describe('B-676-1 — Money shows each reversal as posted, and past windows never move', () => {
  it('99 then 101 cents: the first window and its CSV keep 97, the second shows 98, lifetime 195', async () => {
    const db = store();
    seedSale(db);
    await at(40, db, refunded(99, [['re_1', 99]]));
    const before = await view(db, COACH);
    await at(
      5,
      db,
      refunded(200, [
        ['re_1', 99],
        ['re_2', 101],
      ]),
    );
    const after = await view(db, COACH);
    const cents = [before.first, after.first, after.second, after.lifetime].map(
      (t) => t.refunded_cents,
    );
    expect([cents, after.csv === before.csv]).toEqual([[97, 97, 98, 195], true]);
    expect(after.lifetime.net_cents).toBe(after.first.net_cents + after.second.net_cents);
  });

  it('a lost chargeback after a partial refund lands in its own window; the refund window is unchanged', async () => {
    const db = store();
    seedSale(db);
    await at(40, db, refunded(99, [['re_1', 99]]));
    const before = await view(db, COACH);
    db.state.chargeDispute.push({
      id: 'cd-1',
      stripe_dispute_id: 'dp_1',
      purchase_id: 'p-a',
      stripe_charge_id: 'ch_a',
      amount_cents: 4801,
      status: 'needs_response',
      ledger_reversed: false,
      closed_at: null,
      created_at: ago(20),
      updated_at: ago(20),
    });
    await at(5, db, {
      id: 'evt_d',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost' } },
    });
    // A redelivery days later posts nothing and moves nothing.
    await at(1, db, {
      id: 'evt_d2',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost' } },
    });
    const after = await view(db, COACH);
    const destination = db.state.splitLedgerEntry.find((s) => s.kind === 'destination')!;
    expect([after.first.refunded_cents, after.csv === before.csv]).toEqual([
      before.first.refunded_cents,
      true,
    ]);
    expect(after.second.refunded_cents).toBe(
      destination.reversed_cents - before.first.refunded_cents,
    );
    expect(after.lifetime.refunded_cents).toBe(destination.reversed_cents);
  });

  it('head_coach_split slice: the head coach income reversal and the seller share keep their windows', async () => {
    const db = store();
    seedSale(db, true);
    await at(40, db, refunded(99, [['re_1', 99]]));
    const [sellerBefore, headBefore] = [await view(db, COACH), await view(db, HEAD)];
    await at(
      5,
      db,
      refunded(200, [
        ['re_1', 99],
        ['re_2', 101],
      ]),
    );
    const [seller, head] = [await view(db, COACH), await view(db, HEAD)];
    const slice = db.state.splitLedgerEntry.find((s) => s.kind === 'head_coach_split')!;
    expect([seller.first.head_coach_split_cents, seller.csv]).toEqual([
      sellerBefore.first.head_coach_split_cents,
      sellerBefore.csv,
    ]);
    expect([head.first.head_coach_income_cents, head.csv]).toEqual([
      headBefore.first.head_coach_income_cents,
      headBefore.csv,
    ]);
    expect(head.lifetime.head_coach_income_cents).toBe(490 - slice.reversed_cents);
    expect(head.lifetime.head_coach_income_cents).toBe(
      head.first.head_coach_income_cents + head.second.head_coach_income_cents,
    );
  });
});

describe('AUD-OPUS-CM2-116 — MRR counts billing subscriptions only; free trials are counted apart', () => {
  it('a trialing subscription adds to trial_clients / trial_mrr_cents, not MRR or paying clients', async () => {
    const db = store();
    const sub = (id: string, client: string, status: string) => ({
      id,
      coach_user_id: COACH,
      client_user_id: client,
      package_id: 'pkg-1',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      status,
      entitlement_active: true,
      source: null,
      created_at: ago(90),
      updated_at: ago(90),
    });
    db.state.clientPurchase.push(
      sub('s-1', 'client-1', 'active'),
      sub('s-2', 'client-2', 'trialing'),
    );
    const svc: CoachMoneyService = Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
    const out = await svc.getSummary(COACH, LIFETIME, null, NOW);
    expect(out.recurring).toMatchObject({
      mrr_cents: 4900,
      paying_clients: 1,
      trial_clients: 1,
      trial_mrr_cents: 4900,
    });
  });
});
