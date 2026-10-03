// S-COACH-BE-2 (agent 112) — backend #641 fix round: the Money read model
// reads what production actually writes.
//
// The REAL write paths run first, on a stateful Prisma double:
//   - DunningService.recordFailure + tick (the v1 cadence that sends the
//     "Update payment" reminder email and stamps DunningAttempt sent),
//   - RefundDisputeHandlerService.handle for charge.dispute.created /
//     charge.dispute.closed (lost and won) and charge.refunded, with the
//     real SplitLedgerService reversing ledger slices.
// Then CoachMoneyService answers from those rows through its own where
// clauses (test/support/money-read-double.ts). No hand-shaped read rows.
//
// B-641-1  card_update_link_sent_at comes from the sent DunningAttempt.
// B-641-2  a lost chargeback is `charged_back`: never paid, never a new
//          client, never the first client payment; a won dispute is paid.
// C-641-1  a refund lands in the window it happened in.

import 'reflect-metadata';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { DunningService } from '../src/checkout/dunning.service';
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
  db.model('dunningAttempt', [
    ['id'],
    ['dunning_state_id', 'step_index'],
    ['email_idempotency_key'],
  ]);
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
    { id: 'client-2', name: 'Sam Lee', email: 'sam@example.test' },
  );
  db.state.coachPackage.push({ id: 'pkg-1', name: 'Monthly coaching', interval: 'month' });
  return db;
}

function seedPaidPurchase(
  db: StatefulPrisma,
  id: string,
  client: string,
  charge: string,
  postedAt: Date,
): void {
  db.state.clientPurchase.push({
    id,
    coach_user_id: COACH,
    client_user_id: client,
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
  db.state.splitLedgerEntry.push(
    slice('destination', 4802, COACH),
    slice('application_fee', 98, null),
  );
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

// The real webhook entry point; the stateful row is untyped, so call it
// reflectively instead of casting the row to ClientPurchase.
function recordFailure(dunning: DunningService, input: Record<string, unknown>): Promise<unknown> {
  return Reflect.apply(dunning.recordFailure, dunning, [input]);
}

const last30 = (now: Date) => ({
  from: new Date(now.getTime() - 30 * DAY),
  to: new Date(now.getTime() + DAY),
});

describe('B-641-1 — card update link sent comes from the dunning production write', () => {
  it('is null until the reminder email goes out, then the sent attempt time', async () => {
    const db = store();
    db.state.clientPurchase.push({
      id: 'p-fail',
      coach_user_id: COACH,
      client_user_id: 'client-1',
      package_id: 'pkg-1',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      status: 'past_due',
      entitlement_active: true,
      source: null,
      last_error: 'Your card was declined.',
      stripe_subscription_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const email = {
      send: jest.fn(async (_args: { template: string; data: Record<string, unknown> }) => ({
        status: 'sent',
        providerMessageId: 'msg_1',
      })),
    };
    const dunning: DunningService = Reflect.construct(DunningService, [db, {}, email]);
    await recordFailure(dunning, {
      purchase: db.state.clientPurchase[0],
      stripe_invoice_id: 'in_1',
      amount_due_cents: 4900,
      attempt_number: 1,
      reason: 'card_declined',
    });

    const before = await money(db).getAttention(COACH);
    const itemBefore = before.items.find((i) => i.kind === 'failed_payment')!;
    expect(itemBefore.failed_payment?.card_update_link_sent_at).toBeNull();
    // The legacy PaymentReminder rows recordFailure queues are never sent:
    // they must not be read as a sent link.
    expect(db.state.paymentReminder.length).toBeGreaterThan(0);
    expect(db.state.paymentReminder.every((r) => r.status === 'queued')).toBe(true);

    const tick = await dunning.tick(new Date(Date.now() + 60_000));
    expect(tick.sent).toBe(1);
    // The email that went out is the reminder with the Update payment button.
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].data.billing_portal_url).toEqual(expect.any(String));
    const sent = db.state.dunningAttempt.find((a) => a.status === 'sent')!;
    expect(sent.kind).toBe('soft');

    const after = await money(db).getAttention(COACH);
    const item = after.items.find((i) => i.kind === 'failed_payment')!;
    expect(item.failed_payment?.card_update_link_sent_at).toBe(sent.sent_at.toISOString());
    expect(item.failed_payment?.attempt).toBe(1);
    expect(item.failed_payment?.last_failure_reason).toBe('card_declined');
  });

  it('a failed send (provider error) is not reported as a sent link', async () => {
    const db = store();
    db.state.clientPurchase.push({
      id: 'p-fail',
      coach_user_id: COACH,
      client_user_id: 'client-1',
      package_id: 'pkg-1',
      amount_cents: 4900,
      currency: 'usd',
      billing_type: 'recurring',
      status: 'payment_failed',
      entitlement_active: true,
      source: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const email = { send: jest.fn(async () => ({ status: 'failed', error: 'provider down' })) };
    const dunning: DunningService = Reflect.construct(DunningService, [db, {}, email]);
    await recordFailure(dunning, {
      purchase: db.state.clientPurchase[0],
      stripe_invoice_id: 'in_2',
      amount_due_cents: 4900,
      attempt_number: 1,
      reason: null,
    });
    await dunning.tick(new Date(Date.now() + 60_000));
    expect(db.state.dunningAttempt.some((a) => a.status === 'failed')).toBe(true);
    const out = await money(db).getAttention(COACH);
    expect(out.items[0].failed_payment?.card_update_link_sent_at).toBeNull();
  });
});

describe('B-641-2 — a lost chargeback is never paid', () => {
  it('open dispute -> disputed; lost -> charged_back, out of paid, new clients and first payment', async () => {
    const db = store();
    const now = new Date();
    seedPaidPurchase(db, 'p-cb', 'client-1', 'ch_cb', new Date(now.getTime() - 5 * DAY));
    const h = handler(db);
    await h.handle({
      id: 'evt_open',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: 'ch_cb', status: 'needs_response', amount: 4900 } },
    });
    const svc = money(db);
    expect((await svc.listCharges(COACH, { status: 'all' })).charges[0].state).toBe('disputed');
    // Until the bank decides, the sale still counts.
    expect((await svc.listCharges(COACH, { status: 'paid', limit: 1 })).charges).toHaveLength(1);

    const closed = await h.handle({
      id: 'evt_lost',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', status: 'lost', amount: 4900 } },
    });
    expect(closed.claimed).toBe(true);
    expect(db.state.clientPurchase[0].status).toBe('chargeback_lost');

    const all = await svc.listCharges(COACH, { status: 'all' });
    expect(all.charges[0]).toMatchObject({ state: 'charged_back', charged_back_cents: 4900 });
    // The mobile "first client payment" checklist reads status=paid&limit=1.
    expect((await svc.listCharges(COACH, { status: 'paid', limit: 1 })).charges).toEqual([]);
    expect((await svc.listCharges(COACH, { status: 'refunded' })).charges.map((c) => c.id)).toEqual(
      ['p-cb'],
    );
    expect((await svc.listCharges(COACH, { status: 'disputed' })).charges.map((c) => c.id)).toEqual(
      ['p-cb'],
    );
    const summary = await svc.getSummary(COACH, last30(now), null, now);
    expect(summary.recurring.new_clients_30d).toBe(0);
    expect(summary.recurring.paying_clients).toBe(0);
    // Sale and chargeback both inside the window: the coach keeps nothing.
    expect(summary.totals.net_cents).toBe(0);
    expect(summary.totals.refunded_cents).toBe(4802);
    expect(summary.totals.platform_fee_cents).toBe(0);
  });

  it('a won dispute is paid again and still counts as a new client', async () => {
    const db = store();
    const now = new Date();
    seedPaidPurchase(db, 'p-won', 'client-2', 'ch_won', new Date(now.getTime() - 5 * DAY));
    const h = handler(db);
    await h.handle({
      id: 'evt_open',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_2', charge: 'ch_won', status: 'needs_response', amount: 4900 } },
    });
    await h.handle({
      id: 'evt_won',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_2', status: 'won', amount: 4900 } },
    });
    expect(db.state.clientPurchase[0].status).toBe('paid');
    const svc = money(db);
    const all = await svc.listCharges(COACH, { status: 'all' });
    expect(all.charges[0]).toMatchObject({ state: 'paid', charged_back_cents: 0 });
    expect((await svc.listCharges(COACH, { status: 'paid', limit: 1 })).charges).toHaveLength(1);
    const summary = await svc.getSummary(COACH, last30(now), null, now);
    expect(summary.recurring.new_clients_30d).toBe(1);
    expect(summary.totals.net_cents).toBe(4802);
  });
});

describe('C-641-1 — a refund lands in the window it happened in', () => {
  it('an old sale refunded today lowers today, and last month stays as it was', async () => {
    const db = store();
    const now = new Date();
    const saleAt = new Date(now.getTime() - 45 * DAY);
    seedPaidPurchase(db, 'p-old', 'client-1', 'ch_old', saleAt);
    const svc = money(db);
    const lastMonth = {
      from: new Date(now.getTime() - 60 * DAY),
      to: new Date(now.getTime() - 30 * DAY),
    };
    const before = await svc.getSummary(COACH, last30(now), lastMonth, now);
    expect(before.compare_totals?.net_cents).toBe(4802);
    expect(before.totals.net_cents).toBe(0);

    // A full refund today, through the real webhook handler.
    await handler(db).handle({
      id: 'evt_refund',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_old',
          amount: 4900,
          amount_refunded: 4900,
          refunded: true,
          refunds: { data: [{ id: 're_1', amount: 4900, status: 'succeeded' }] },
        },
      },
    });
    expect(db.state.splitLedgerEntry.find((s) => s.kind === 'destination')!.reversed_cents).toBe(
      4802,
    );

    const after = await svc.getSummary(COACH, last30(now), lastMonth, now);
    // Last month is not rewritten after the fact.
    expect(after.compare_totals?.net_cents).toBe(4802);
    expect(after.compare_totals?.refunded_cents).toBe(0);
    // Today carries the refund: no sales, coach share taken back, TGP fee returned.
    expect(after.totals).toMatchObject({
      gross_cents: 0,
      net_cents: -4802,
      refunded_cents: 4802,
      platform_fee_cents: -98,
    });
    // Across both windows the coach nets exactly zero.
    expect(after.totals.net_cents + (after.compare_totals?.net_cents ?? 0)).toBe(0);
    // The tax export for today has the refund row and sums to the same net.
    const csv = await svc.exportCsv(COACH, last30(now));
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    const cols = lines[1].split(',');
    expect(cols[1]).toBe('refund');
    expect(cols[4]).toBe('Ana Ruiz');
    expect(cols[8]).toBe('49.00');
    expect(cols[12]).toBe('-48.02');
  });
});

describe('B-641-6 — a refund is booked when it succeeds, not when it was requested', () => {
  afterEach(() => jest.useRealTimers());

  it('pending last month, succeeded today: last month is unchanged, today carries the refund', async () => {
    const db = store();
    const now = new Date();
    const saleAt = new Date(now.getTime() - 50 * DAY);
    seedPaidPurchase(db, 'p-pend', 'client-1', 'ch_pend', saleAt);
    const svc = money(db);
    const lastMonth = {
      from: new Date(now.getTime() - 60 * DAY),
      to: new Date(now.getTime() - 30 * DAY),
    };
    const refundEvent = (status: string, id: string) => ({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_pend',
          amount: 4900,
          amount_refunded: status === 'succeeded' ? 4900 : 0,
          refunded: status === 'succeeded',
          refunds: { data: [{ id: 're_pend', amount: 4900, status }] },
        },
      },
    });
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });

    // Requested 40 days ago (inside last month's window), still pending.
    jest.setSystemTime(new Date(now.getTime() - 40 * DAY));
    await handler(db).handle(refundEvent('pending', 'evt_pending'));
    const pending = db.state.chargeRefund.find((r) => r.stripe_refund_id === 're_pend')!;
    expect(pending.status).toBe('pending');
    expect(pending.posted_at).toBeNull();

    // Succeeds today, through the same real writer.
    jest.setSystemTime(now);
    await handler(db).handle(refundEvent('succeeded', 'evt_succeeded'));
    const done = db.state.chargeRefund.find((r) => r.stripe_refund_id === 're_pend')!;
    expect(done.posted_at).toEqual(now);

    // A Stripe redelivery two days later does not move it.
    jest.setSystemTime(new Date(now.getTime() + 2 * DAY));
    await handler(db).handle(refundEvent('succeeded', 'evt_redelivered'));
    expect(db.state.chargeRefund.find((r) => r.stripe_refund_id === 're_pend')!.posted_at).toEqual(
      now,
    );
    jest.useRealTimers();

    const after = await svc.getSummary(COACH, last30(now), lastMonth, now);
    // Last month keeps the sale and none of the refund.
    expect(after.compare_totals?.net_cents).toBe(4802);
    expect(after.compare_totals?.refunded_cents).toBe(0);
    // This window carries the completed refund.
    expect(after.totals).toMatchObject({ net_cents: -4802, refunded_cents: 4802 });
    // The tax export for last month has only the sale; this window has the refund.
    const lastCsv = (await svc.exportCsv(COACH, lastMonth)).trim().split('\r\n');
    expect(lastCsv.slice(1).map((l) => l.split(',')[1])).toEqual(['sale']);
    const nowCsv = (await svc.exportCsv(COACH, last30(now))).trim().split('\r\n');
    expect(nowCsv.slice(1).map((l) => l.split(',')[1])).toEqual(['refund']);
  });
});
