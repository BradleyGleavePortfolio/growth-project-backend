// CONTRACT-1 Option 1 (owner): "The old coach keeps their own money records
// for that client (name, date, amount) and nothing else, for taxes, refunds
// and disputes." One store answers every coach money route the way the
// database would; each route is read before and after the client moves to
// another coach.
import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CheckoutService } from '../src/checkout/checkout.service';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { movedAwayClientIds } from '../src/checkout/moved-client-money';
import { CoachPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { PackagesService } from '../src/packages/packages.service';
import { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import { findMany } from './support/money-read-double';
import { StatefulPrisma } from './support/stateful-prisma';

type Row = Record<string, unknown>;
const OLD = 'coach-old';
const NEW = 'coach-new';
/** A sub-coach on OLD's team. */
const SUB = 'coach-sub';
const CLIENT = 'client-ana';
const ANA = 'Ana Ruiz';
const KEY = '33333333-3333-4333-8333-333333333333';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
/** The only fields a purchase row about Ana keeps once she has moved (listed in the PR). */
const KEPT = ['amount_cents', 'created_at', 'currency', 'id', 'status'];
/** The only fields her plan keeps on the client payments routes. */
const PLAN_KEPT = [
  'actions', 'amount_cents', 'created_at', 'currency', 'payments', 'purchase_id', 'status',
];
/** Never in the old coach's responses once Ana has moved: her id, email, card error, new coach. */
const GONE_AFTER_MOVE = [CLIENT, 'ana@example.test', 'card_declined', NEW];
/** Nor whether she still has access or renews. */
const ACCESS = [
  'entitlement_active', 'cancel_at_period_end', 'current_period_end', 'access_expires_at',
  'billing',
];

const read = (db: StatefulPrisma, model: string) => ({
  findMany: async (args: Row = {}) => findMany(db, model, args),
  findFirst: async (args: Row = {}) => findMany(db, model, { ...args, take: 1 })[0] ?? null,
  findUnique: async (args: Row = {}) => findMany(db, model, { ...args, take: 1 })[0] ?? null,
});

/** One sale to Ana by `seller`; Ana's coach is OLD. */
function world(seller = OLD) {
  const db = new StatefulPrisma();
  db.state = {
    user: [{ id: CLIENT, name: ANA, email: 'ana@example.test', coach_id: OLD }],
    coachPackage: [{
      id: 'pkg-1', coach_id: seller, name: 'Monthly coaching', currency: 'usd',
      interval: 'month', interval_count: 1,
    }],
    clientPurchase: [{
      id: 'p1', client_user_id: CLIENT, coach_user_id: seller, package_id: 'pkg-1',
      amount_cents: 4900, currency: 'usd', billing_type: 'recurring', status: 'past_due',
      entitlement_active: true, access_expires_at: at(30), current_period_end: at(30),
      cancel_at_period_end: false, canceled_at: null, last_error: 'card_declined',
      source: null, created_at: at(1), updated_at: at(2), stripe_subscription_id: 'sub_1',
      settlements: [{
        stripe_charge_id: 'ch_1', currency: 'usd', gross_cents: 4900, refunded_cents: 0,
        dispute_withdrawn_cents: 0, created_at: at(1),
      }],
    }],
    dunningState: [{
      id: 'd1', purchase_id: 'p1', status: 'active', failure_count: 1, step_index: 0,
      last_failed_amount_cents: 4900, last_failure_at: at(2), last_failure_reason: 'card_declined',
      entered_at: at(2),
    }],
    chargeDispute: [{
      id: 'dp1', purchase_id: 'p1', status: 'needs_response', amount_cents: 4900,
      currency: 'usd', reason: 'fraudulent', evidence_due_by: at(20), created_at: at(3),
    }],
    splitLedgerEntry: [{
      id: 'l1', purchase_id: 'p1', kind: 'destination', payee_user_id: seller, amount_cents: 4802,
      reversed_cents: 0, currency: 'usd', status: 'posted', created_at: at(1),
    }],
    partialRefundDecision: [{
      id: 'prd1', client_purchase_id: 'p1', stripe_refund_id: 're_1', decision: 'pending',
      created_at: at(4),
    }],
  };
  const models = [
    'user', 'subCoachAssignment', 'coachPackage', 'clientPurchase', 'dunningState',
    'chargeDispute', 'chargeRefund', 'splitLedgerEntry', 'connectTransfer', 'connectAccount',
    'partialRefundDecision', 'notification',
  ];
  const prisma = Object.fromEntries(models.map((m) => [m, read(db, m)]));
  const refunds = {
    createAdminRefund: jest.fn(async (a: Row) => ({
      id: 'r1', amount_cents: a.amount_cents, status: 'succeeded',
    })),
  };
  const stripe = { retrieveSubscription: async () => ({ pause_collection: null }) };
  const headOf = { resolveHeadCoachId: async () => null };
  const audit = { write: async () => undefined };
  const make = <T>(cls: new (...args: never[]) => T, ...deps: unknown[]): T =>
    Reflect.construct(cls, [prisma, ...deps]);
  return {
    db,
    refunds,
    moveTo: (coachId: string) => Object.assign(db.state.user[0], { coach_id: coachId }),
    checkout: make(CheckoutService, {}, {}, {}, {}, {}),
    ops: make(CoachPaymentOpsController, {}, {}, {}, {}, {}),
    packages: make(PackagesService, {}),
    money: make(CoachMoneyService),
    payments: make(CoachClientPaymentsService, stripe, refunds, {}, headOf, audit),
    decisions: make(PartialRefundDecisionService, {}),
  };
}
type World = ReturnType<typeof world>;
type OpsRoute = 'listOwn' | 'getOwn' | 'failedOnRoster';

const coach = (id: string): User => Object.assign(Object.create(null), { id, role: 'coach' });
const route = (w: World, coachId: string, name: OpsRoute, arg?: unknown) =>
  Reflect.apply(w.ops[name], w.ops, [{ user: { id: coachId, role: 'coach' } }, arg]);

/** Every coach money route that names a client, as `coachId` reads it. */
async function readAll(w: World, coachId = OLD) {
  return {
    // GET /v1/coach/purchases
    purchases: (await w.checkout.listForCoach(coachId)).items,
    // GET /v1/coach/payments/purchases, /purchases/:id and /failed
    payments: (await route(w, coachId, 'listOwn', {})).purchases,
    payment: await route(w, coachId, 'getOwn', 'p1'),
    failed: (await route(w, coachId, 'failedOnRoster')).failed,
    // GET /v1/coach/packages/:id/subscribers
    subscribers: (await w.packages.listSubscribers(coachId, 'pkg-1')).subscribers,
    // GET /v1/coach/money/charges, /charges/:id and /attention
    charges: (await w.money.listCharges(coachId, { status: 'all' })).charges,
    charge: await w.money.getChargeBreakdown(coachId, 'p1'),
    attention: (await w.money.getAttention(coachId)).items,
    // GET /v1/coach/clients/:clientId/payments
    plans: (await w.payments.list(coach(coachId), CLIENT)).plans,
    // GET /coach/refunds/pending-decisions
    decisions: await w.decisions.listPendingForCoach(coachId),
  };
}
type Reads = Awaited<ReturnType<typeof readAll>>;

/** The coach's tax export for the month, as cells per row (no header). */
const csvRows = async (w: World, coachId: string) =>
  (await w.money.exportCsv(coachId, { from: at(0), to: at(31) }))
    .trim().split('\r\n').slice(1).map((l) => l.split(','));

/** The refund reached the refund path as `by`; its reply keeps only the plan's money record. */
function expectRefunded(w: World, out: { plan: object }, by: string, amount_cents: number) {
  expect(w.refunds.createAdminRefund).toHaveBeenCalledWith(expect.objectContaining({
    purchase_id: 'p1', charge_id: 'ch_1', amount_cents, initiated_by_user_id: by,
  }));
  expect(Object.keys(out.plan).sort()).toEqual(PLAN_KEPT);
}

/** Once Ana is off the reader's roster (`before`: still on it), only her money record is left. */
function expectMoneyRecordsOnly(r: Reads, before: Reads) {
  for (const row of [...r.purchases, ...r.payments, r.payment.purchase, ...r.failed]) {
    expect(Object.keys(row).sort()).toEqual(KEPT);
    expect(row).toMatchObject({
      id: 'p1', amount_cents: 4900, currency: 'usd', status: 'past_due', created_at: at(1),
    });
  }
  // Every line of a subscriber row is her current access, so she leaves the list.
  expect(r.subscribers).toEqual([]);
  expect(r.payment.dunning).toBeNull();
  expect(r.payment.split_ledger).toEqual(before.payment.split_ledger);
  // Written out, not derived from the earlier charge: the sale, never the client or package.
  const kept = {
    id: 'p1', client: { id: '', name: ANA }, package: { id: '', name: '' },
    amount_cents: 4900, currency: 'usd', created_at: at(1).toISOString(),
    billing_type: 'recurring', billing_interval: null, billing_interval_count: null,
    state: before.charges[0].state, refunded_cents: 0, charged_back_cents: 0,
    // SWITCH-TELL-BE: only a move to the house coach tells the coach (and dates the line).
    moved_away_at: null,
  };
  expect(r.charges).toEqual([kept]);
  expect(r.charge).toEqual({ ...before.charge, charge: kept });
  for (const gone of ['pkg-1', 'Monthly coaching']) {
    expect(JSON.stringify([r.charges, r.charge])).not.toContain(gone);
  }
  // Both to-dos (failed card, dispute) were "Message Ana"; the charge above keeps its state.
  expect(r.attention).toEqual([]);
  expect(r.decisions).toEqual([{ ...before.decisions[0], client_user_id: null }]);
  for (const gone of GONE_AFTER_MOVE) expect(JSON.stringify(r)).not.toContain(gone);
  for (const key of ACCESS) expect(JSON.stringify(r)).not.toContain(`"${key}":`);
}

describe('CONTRACT-1 — the old coach keeps only the money records of a moved client', () => {
  it('a client on the coach\'s roster stays; anyone else has moved away', async () => {
    const db = new StatefulPrisma();
    db.state = {
      user: [
        { id: 'own', coach_id: OLD },
        { id: 'other', coach_id: NEW },
        { id: 'none', coach_id: null },
        { id: 'delegated', coach_id: OLD },
        { id: 'sub-a', coach_id: OLD },
        { id: 'sub-b', coach_id: NEW },
        { id: 'sub-seated', coach_id: OLD },
        { id: 'sub-removed', coach_id: OLD },
      ],
      subCoachAssignment: [
        { head_coach_id: OLD, sub_coach_id: 'sub-a', client_id: 'delegated', unassigned_at: null },
        { head_coach_id: OLD, sub_coach_id: 'sub-a', client_id: 'own', unassigned_at: at(1) },
        { head_coach_id: OLD, sub_coach_id: 'sub-b', client_id: 'delegated', unassigned_at: null },
        ...['sub-seated', 'sub-removed'].map((sub_coach_id) => ({
          head_coach_id: OLD, sub_coach_id, client_id: 'delegated', unassigned_at: null,
        })),
      ],
      // sub-a was never seated on OLD's team (only removed from another head coach's).
      teamSubCoachAssignment: [
        { head_coach_id: NEW, sub_coach_id: 'sub-a', archived_at: at(1) },
        { head_coach_id: OLD, sub_coach_id: 'sub-seated', archived_at: null },
        { head_coach_id: OLD, sub_coach_id: 'sub-removed', archived_at: at(1) },
      ],
    };
    const prisma = { user: read(db, 'user'), subCoachAssignment: read(db, 'subCoachAssignment') };
    const ids = ['own', 'other', 'none', 'delegated', null];
    const movedFrom = async (coachId: string): Promise<string[]> =>
      [...(await Reflect.apply(movedAwayClientIds, undefined, [prisma, coachId, ids]))].sort();
    // The head coach keeps every client whose coach they are, delegated or not.
    expect(await movedFrom(OLD)).toEqual(['none', 'other']);
    // A sub-coach keeps only the clients delegated to them, never the rest of the team.
    expect(await movedFrom('sub-a')).toEqual(['none', 'other', 'own']);
    // A sub-coach who left the team loses the delegated client too.
    expect(await movedFrom('sub-b')).toEqual(['delegated', 'none', 'other', 'own']);
    // A seated sub-coach keeps the delegated client; one the head coach removed (archived seat,
    // delegation still open) does not.
    expect(await movedFrom('sub-seated')).toEqual(['none', 'other', 'own']);
    expect(await movedFrom('sub-removed')).toEqual(['delegated', 'none', 'other', 'own']);
  });

  it('before the move every route is in full; after it, only the money record', async () => {
    const w = world();
    const r = await readAll(w);
    const rows = [...r.purchases, ...r.payments, r.payment.purchase, ...r.failed, ...r.subscribers];
    for (const row of rows) {
      expect(row).toMatchObject({
        client_user_id: CLIENT, current_period_end: at(30), last_error: 'card_declined',
      });
    }
    expect(r.subscribers[0].client).toEqual({ name: ANA, email: 'ana@example.test' });
    expect(r.payment.dunning).toMatchObject({ status: 'active' });
    expect(r.failed[0].dunning).toMatchObject({ status: 'active' });
    const linked = { id: CLIENT, name: ANA };
    expect([r.charges[0].client, r.charge.charge.client]).toEqual([linked, linked]);
    expect(r.charges[0]).toMatchObject({
      package: { id: 'pkg-1', name: 'Monthly coaching' }, billing_interval: 'month',
    });
    expect(r.payment.split_ledger).toEqual([expect.objectContaining({ id: 'l1', amount_cents: 4802 })]);
    expect(r.attention.map((i) => [i.kind, i.client])).toEqual([
      ['failed_payment', linked],
      ['dispute', linked],
    ]);
    expect(r.plans[0]).toMatchObject({
      current_period_end: at(30).toISOString(), access_expires_at: at(30).toISOString(),
    });
    expect(r.decisions[0].client_user_id).toBe(CLIENT);
    w.moveTo(NEW);
    expectMoneyRecordsOnly(await readAll(w), r);
  });

  it('a sub-coach the head coach removed keeps only the money records of their sale', async () => {
    // OLD delegated Ana to SUB, who sold to her. Removing SUB archives their seat and can leave
    // the delegation open; Ana stays OLD's client. An archived seat ends SUB's team membership
    // (the roster's rule, #978), so SUB keeps only the money record, and still refunds it.
    const w = world(SUB);
    w.db.state.user.push({ id: SUB, role: 'coach', coach_id: OLD });
    w.db.state.subCoachAssignment = [
      { head_coach_id: OLD, sub_coach_id: SUB, client_id: CLIENT, unassigned_at: null },
    ];
    const inFull = async () => {
      const r = await readAll(w, SUB);
      expect(r.purchases[0]).toMatchObject({ client_user_id: CLIENT });
      expect(r.charges[0].client.id).toBe(CLIENT);
      expect(r.subscribers).toHaveLength(1);
      return r;
    };
    const saleRow = async () => (await csvRows(w, SUB))[0];
    // Never seated (a legacy delegation), then seated: Ana is SUB's client in full.
    await inFull();
    const seat = { head_coach_id: OLD, sub_coach_id: SUB, archived_at: null as Date | null };
    w.db.state.teamSubCoachAssignment = [seat];
    const before = await inFull();
    const sale = await saleRow();
    expect(sale.slice(4, 6)).toEqual([ANA, 'Monthly coaching']);
    seat.archived_at = at(5);
    expectMoneyRecordsOnly(await readAll(w, SUB), before);
    expect(await saleRow()).toEqual(sale.map((c, i) => (i === 5 ? '' : c)));
    const out = await w.payments.refundSale(coach(SUB), 'p1', { idempotency_key: KEY, amount_cents: 500 });
    expectRefunded(w, out, SUB, 500);
  });

  it('after the move no tax-export row names her package, as seller or head coach', async () => {
    // OLD's sale p1: its sale, a reversal, and a refund of a later charge. SUB's sale p2 to Ana
    // paid OLD a head-coach share, later reversed. After the move OLD has no tie to Ana (nor to
    // SUB): the rows are OLD's own money history, read by payee.
    const w = world();
    const { clientPurchase, splitLedgerEntry } = w.db.state;
    Object.assign(splitLedgerEntry[0], { stripe_charge_id: 'ch_1', reversed_cents: 980, reversed_at: at(6) });
    clientPurchase.push({ id: 'p2', client_user_id: CLIENT, coach_user_id: SUB, package_id: 'pkg-1', source: null });
    splitLedgerEntry.push({
      id: 'l2', purchase_id: 'p2', kind: 'head_coach_split', payee_user_id: OLD, amount_cents: 490,
      reversed_cents: 98, reversed_at: at(7), currency: 'usd', status: 'posted', created_at: at(2),
    });
    w.db.state.chargeRefund = [{
      id: 'rf1', purchase_id: 'p1', status: 'succeeded', amount_cents: 1000, posted_at: at(8),
      stripe_charge_id: 'ch_2',
    }];
    const before = await csvRows(w, OLD);
    expect(before.map((r) => r.slice(1, 6))).toEqual([
      ['sale', 'p1', 'ch_1', ANA, 'Monthly coaching'],
      ['team_share', 'p2', '', '', 'Monthly coaching'],
      ['reversal', 'p1', 'ch_1', ANA, 'Monthly coaching'],
      ['team_share_reversal', 'p2', '', '', 'Monthly coaching'],
      ['refund', 'p1', 'ch_2', ANA, 'Monthly coaching'],
    ]);
    w.moveTo(NEW);
    expect(await csvRows(w, OLD)).toEqual(before.map((r) => r.map((c, i) => (i === 5 ? '' : c))));
  });

  it('after the move refund works; the plan keeps the sale and its payments', async () => {
    const w = world();
    const before = await readAll(w);
    w.moveTo(NEW);
    const { plans } = await w.payments.list(coach(OLD), CLIENT);
    expect(Object.keys(plans[0]).sort()).toEqual(PLAN_KEPT);
    expect(plans[0]).toMatchObject({
      purchase_id: 'p1', amount_cents: 4900, currency: 'usd', status: 'past_due',
      created_at: at(1).toISOString(), payments: before.plans[0].payments,
    });
    expect(plans[0].actions).toEqual({ refund: true, restart: false });
    const out = await w.payments.refund(coach(OLD), CLIENT, 'p1', {
      idempotency_key: KEY, charge_id: 'ch_1', amount_cents: 1000,
    });
    expectRefunded(w, out, OLD, 1000);
    expect(out.refund).toMatchObject({ charge_id: 'ch_1', amount_cents: 1000 });
    for (const act of ['pause', 'resume', 'cancel'] as const) {
      await expect(w.payments[act](coach(OLD), CLIENT, 'p1', KEY)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('after the move the record id alone refunds and shows a dispute pause', async () => {
    const w = world();
    w.moveTo(NEW);
    const [sale] = (await route(w, OLD, 'listOwn', {})).purchases;
    const out = await w.payments.refundSale(coach(OLD), sale.id, { idempotency_key: KEY, amount_cents: 500 });
    expectRefunded(w, out, OLD, 500);
    // A card failure never shows; a refund or dispute pause does, for the restart.
    expect((await route(w, OLD, 'getOwn', sale.id)).dunning).toBeNull();
    Object.assign(w.db.state.dunningState[0], { last_failure_reason: 'charge_disputed' });
    expect((await route(w, OLD, 'getOwn', sale.id)).dunning).toEqual({
      status: 'active', last_failure_reason: 'charge_disputed', entered_at: at(2),
    });
  });

  it("the client's new coach (any other coach) reads none of the old coach's records", async () => {
    const w = world();
    w.moveTo(NEW);
    const notFound = { status: 404 };
    expect((await w.checkout.listForCoach(NEW)).items).toEqual([]);
    expect((await route(w, NEW, 'listOwn', {})).purchases).toEqual([]);
    await expect(route(w, NEW, 'getOwn', 'p1')).rejects.toMatchObject(notFound);
    expect((await route(w, NEW, 'failedOnRoster')).failed).toEqual([]);
    await expect(w.packages.listSubscribers(NEW, 'pkg-1')).rejects.toMatchObject(notFound);
    expect((await w.money.listCharges(NEW, { status: 'all' })).charges).toEqual([]);
    await expect(w.money.getChargeBreakdown(NEW, 'p1')).rejects.toMatchObject(notFound);
    expect((await w.money.getAttention(NEW)).items).toEqual([]);
    expect((await w.payments.list(coach(NEW), CLIENT)).plans).toEqual([]);
    await expect(w.payments.refund(coach(NEW), CLIENT, 'p1', { idempotency_key: KEY }))
      .rejects.toMatchObject(notFound);
    await expect(w.payments.refundSale(coach(NEW), 'p1', { idempotency_key: KEY }))
      .rejects.toMatchObject(notFound);
    expect(await w.decisions.listPendingForCoach(NEW)).toEqual([]);
    expect(w.refunds.createAdminRefund).not.toHaveBeenCalled();
  });
});
