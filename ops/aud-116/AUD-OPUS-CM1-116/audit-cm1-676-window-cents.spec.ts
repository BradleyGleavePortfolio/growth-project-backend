// AUD-OPUS-CM1-116 probe (audit only, never merged): does the Money read
// model report each refund's cents exactly as the real writer posted them,
// and does a later refund leave an earlier window unchanged?
//
// The REAL RefundDisputeHandlerService + SplitLedgerService write the
// ledger on a stateful double; CoachMoneyService reads it back through
// its own where clauses (test/support/money-read-double.ts).

import 'reflect-metadata';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { StatefulPrisma } from './support/stateful-prisma';
import { moneyReadPrisma } from './support/money-read-double';

const COACH = 'coach-1';
const DAY = 86_400_000;

function store(): StatefulPrisma {
  const db = new StatefulPrisma();
  db.model('user');
  db.model('coachPackage');
  db.model('clientPurchase');
  db.model('dunningState', [['id'], ['purchase_id']]);
  db.model('dunningAttempt', [['id'], ['dunning_state_id', 'step_index'], ['email_idempotency_key']]);
  db.model('paymentReminder', [['id'], ['purchase_id', 'kind', 'channel', 'window_key']]);
  db.model('chargeDispute', [['id'], ['stripe_dispute_id']], () => ({
    ledger_reversed: false,
    closed_at: null,
    balance_transaction_id: null,
  }));
  db.model('chargeRefund', [['id'], ['stripe_refund_id']], () => ({
    ledger_reversed: false,
    transfer_reversed: false,
  }));
  db.model('splitLedgerEntry');
  db.model('connectTransfer');
  db.model('connectAccount', [['id'], ['coach_user_id']]);
  db.model('guestCheckout');
  db.model('notification');
  db.state.user.push(
    { id: COACH, name: 'Coach One', email: 'coach@example.test' },
    { id: 'client-1', name: 'Ana Ruiz', email: 'ana@example.test' },
  );
  db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly coaching', interval: 'month' });
  return db;
}

function seedPaidPurchase(db: StatefulPrisma, id: string, charge: string, postedAt: Date): void {
  db.state.clientPurchase.push({
    id,
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    entitlement_active: true,
    source: null,
    canceled_at: null,
    last_error: null,
    stripe_payment_intent_id: null,
    created_at: postedAt,
    updated_at: postedAt,
  });
  const slice = (kind: string, amount: number, payee: string | null) => ({
    id: `${id}-${kind}`,
    purchase_id: id,
    kind,
    payee_user_id: payee,
    amount_cents: amount,
    reversed_cents: 0,
    currency: 'usd',
    status: 'posted',
    stripe_charge_id: charge,
    posted_at: postedAt,
    reversed_at: null,
    created_at: postedAt,
    updated_at: postedAt,
  });
  db.state.splitLedgerEntry.push(slice('destination', 4802, COACH), slice('application_fee', 98, null));
}

function money(db: StatefulPrisma): CoachMoneyService {
  return Reflect.construct(CoachMoneyService, [moneyReadPrisma(db)]);
}

function handler(db: StatefulPrisma): RefundDisputeHandlerService {
  const ledger = Reflect.construct(SplitLedgerService, [db]);
  const stripe = { retrieveCharge: jest.fn(async () => ({ payment_intent: null })) };
  const transfers = { reverse: jest.fn(async () => null) };
  const payoutReadiness = { recordPayoutEvent: jest.fn(async () => null) };
  const notifications = { createNotification: jest.fn(async () => undefined) };
  return Reflect.construct(RefundDisputeHandlerService, [
    db,
    stripe,
    ledger,
    transfers,
    payoutReadiness,
    notifications,
  ]);
}

describe('AUD-OPUS-CM1-116 — Money reports each refund as the writer posted it', () => {
  afterEach(() => jest.useRealTimers());

  it('two unequal partial refunds: the first window keeps the cents posted for the first refund', async () => {
    const db = store();
    const now = new Date();
    seedPaidPurchase(db, 'p-a', 'ch_a', new Date(now.getTime() - 50 * DAY));
    const svc = money(db);
    const firstWindow = {
      from: new Date(now.getTime() - 60 * DAY),
      to: new Date(now.getTime() - 30 * DAY),
    };
    const secondWindow = { from: new Date(now.getTime() - 30 * DAY), to: new Date(now.getTime() + DAY) };
    const destination = () => db.state.splitLedgerEntry.find((s) => s.kind === 'destination')!;
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });

    // Refund 1: 99 cents, 40 days ago (inside the first window).
    jest.setSystemTime(new Date(now.getTime() - 40 * DAY));
    await handler(db).handle({
      id: 'evt_r1',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_a',
          amount: 4900,
          amount_refunded: 99,
          refunded: false,
          refunds: { data: [{ id: 're_1', amount: 99, status: 'succeeded' }] },
        },
      },
    });
    const postedFirst = destination().reversed_cents as number;
    jest.useRealTimers();
    const firstBefore = (await svc.getSummary(COACH, firstWindow, null, now)).totals.refunded_cents;
    const csvBefore = (await svc.exportCsv(COACH, firstWindow)).trim();

    // Refund 2: 101 cents, 5 days ago (inside the second window).
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    jest.setSystemTime(new Date(now.getTime() - 5 * DAY));
    await handler(db).handle({
      id: 'evt_r2',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_a',
          amount: 4900,
          amount_refunded: 200,
          refunded: false,
          refunds: {
            data: [
              { id: 're_1', amount: 99, status: 'succeeded' },
              { id: 're_2', amount: 101, status: 'succeeded' },
            ],
          },
        },
      },
    });
    const postedSecond = (destination().reversed_cents as number) - postedFirst;
    jest.useRealTimers();
    const firstAfter = (await svc.getSummary(COACH, firstWindow, null, now)).totals.refunded_cents;
    const secondAfter = (await svc.getSummary(COACH, secondWindow, null, now)).totals.refunded_cents;
    const csvAfter = (await svc.exportCsv(COACH, firstWindow)).trim();

    expect({
      posted_first: postedFirst,
      first_window_before: firstBefore,
      first_window_after: firstAfter,
      posted_second: postedSecond,
      second_window_after: secondAfter,
      first_window_csv_unchanged: csvAfter === csvBefore,
    }).toEqual({
      posted_first: postedFirst,
      first_window_before: postedFirst,
      first_window_after: postedFirst,
      posted_second: postedSecond,
      second_window_after: postedSecond,
      first_window_csv_unchanged: true,
    });
  });
});
