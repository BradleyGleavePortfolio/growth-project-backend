// CONTRACT-1 Option 1 (owner): "The old coach keeps their own money records
// for that client (name, date, amount) and nothing else, for taxes, refunds
// and disputes." One store answers every coach money route the way the
// database would; each route is read before and after the client moves to
// another coach.
import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CheckoutService } from '../src/checkout/checkout.service';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { MONEY_RECORD_FIELDS, movedAwayClientIds } from '../src/checkout/moved-client-money';
import { CoachPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { PackagesService } from '../src/packages/packages.service';
import { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import { findMany } from './support/money-read-double';
import { StatefulPrisma } from './support/stateful-prisma';

type Row = Record<string, unknown>;
const OLD = 'coach-old';
const NEW = 'coach-new';
const CLIENT = 'client-ana';
const ANA = 'Ana Ruiz';
const KEY = '33333333-3333-4333-8333-333333333333';
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12));
/** Never in the old coach's responses once Ana has moved: her id, email, card error, new coach. */
const GONE_AFTER_MOVE = [CLIENT, 'ana@example.test', 'card_declined', NEW];

const read = (db: StatefulPrisma, model: string) => ({
  findMany: async (args: Row = {}) => findMany(db, model, args),
  findFirst: async (args: Row = {}) => findMany(db, model, { ...args, take: 1 })[0] ?? null,
  findUnique: async (args: Row = {}) => findMany(db, model, { ...args, take: 1 })[0] ?? null,
});

function world() {
  const db = new StatefulPrisma();
  db.state = {
    user: [{ id: CLIENT, name: ANA, email: 'ana@example.test', coach_id: OLD }],
    coachPackage: [{
      id: 'pkg-1', coach_id: OLD, name: 'Monthly coaching', currency: 'usd',
      interval: 'month', interval_count: 1,
    }],
    clientPurchase: [{
      id: 'p1', client_user_id: CLIENT, coach_user_id: OLD, package_id: 'pkg-1',
      amount_cents: 4900, currency: 'usd', billing_type: 'recurring', status: 'past_due',
      entitlement_active: true, access_expires_at: at(30), current_period_end: at(30),
      cancel_at_period_end: false, canceled_at: null, last_error: 'card_declined',
      source: null, created_at: at(1), updated_at: at(2), stripe_subscription_id: null,
      settlements: [{
        stripe_charge_id: 'ch_1', currency: 'usd', gross_cents: 4900, refunded_cents: 0,
        dispute_withdrawn_cents: 0, created_at: at(1),
      }],
    }],
    dunningState: [{
      id: 'd1', purchase_id: 'p1', status: 'active', failure_count: 1, step_index: 0,
      last_failed_amount_cents: 4900, last_failure_at: at(2), last_failure_reason: 'card_declined',
    }],
    chargeDispute: [{
      id: 'dp1', purchase_id: 'p1', status: 'needs_response', amount_cents: 4900,
      currency: 'usd', reason: 'fraudulent', evidence_due_by: at(20), created_at: at(3),
    }],
    splitLedgerEntry: [{
      id: 'l1', purchase_id: 'p1', kind: 'destination', payee_user_id: OLD, amount_cents: 4802,
      reversed_cents: 0, currency: 'usd', status: 'posted', created_at: at(1),
    }],
    partialRefundDecision: [{
      id: 'prd1', client_purchase_id: 'p1', stripe_refund_id: 're_1', decision: 'pending',
      created_at: at(4),
    }],
  };
  const models = [
    'user', 'teamSubCoachAssignment', 'coachPackage', 'clientPurchase', 'dunningState',
    'chargeDispute', 'chargeRefund', 'splitLedgerEntry', 'connectTransfer', 'connectAccount',
    'partialRefundDecision',
  ];
  const prisma = Object.fromEntries(models.map((m) => [m, read(db, m)]));
  const refunds = {
    createAdminRefund: jest.fn(async (a: Row) => ({
      id: 'r1', amount_cents: a.amount_cents, status: 'succeeded',
    })),
  };
  const headOf = { resolveHeadCoachId: async () => null };
  const audit = { write: async () => undefined };
  const make = <T>(cls: new (...args: never[]) => T, ...deps: unknown[]): T =>
    Reflect.construct(cls, [prisma, ...deps]);
  return {
    refunds,
    moveTo: (coachId: string) => Object.assign(db.state.user[0], { coach_id: coachId }),
    checkout: make(CheckoutService, {}, {}, {}, {}, {}),
    ops: make(CoachPaymentOpsController, {}, {}, {}, {}, {}),
    packages: make(PackagesService, {}),
    money: make(CoachMoneyService),
    payments: make(CoachClientPaymentsService, {}, refunds, {}, headOf, audit),
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

describe('CONTRACT-1 — the old coach keeps only the money records of a moved client', () => {
  it('a client has moved away unless their coach is the coach or an active sub-coach', async () => {
    const db = new StatefulPrisma();
    db.state = {
      user: [
        { id: 'own', coach_id: OLD },
        { id: 'other', coach_id: NEW },
        { id: 'none', coach_id: null },
        { id: 'team', coach_id: 'sub-a' },
        { id: 'left-team', coach_id: 'sub-b' },
      ],
      teamSubCoachAssignment: [
        { head_coach_id: OLD, sub_coach_id: 'sub-a', archived_at: null },
        { head_coach_id: OLD, sub_coach_id: 'sub-b', archived_at: at(1) },
      ],
    };
    const prisma = {
      user: read(db, 'user'),
      teamSubCoachAssignment: read(db, 'teamSubCoachAssignment'),
    };
    const ids = ['own', 'other', 'none', 'team', 'left-team', null];
    const moved: Set<string> = await Reflect.apply(movedAwayClientIds, undefined, [
      prisma, OLD, ids,
    ]);
    expect([...moved].sort()).toEqual(['left-team', 'none', 'other']);
  });

  it('before the move every route is unchanged: full rows, client links, dates', async () => {
    const r = await readAll(world());
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
    expect(r.attention.map((i) => [i.kind, i.client])).toEqual([
      ['failed_payment', linked],
      ['dispute', linked],
    ]);
    expect(r.plans[0]).toMatchObject({
      current_period_end: at(30).toISOString(), access_expires_at: at(30).toISOString(),
    });
    expect(r.decisions[0].client_user_id).toBe(CLIENT);
  });

  it('after the move each purchase row keeps only the money record', async () => {
    const w = world();
    w.moveTo(NEW);
    const r = await readAll(w);
    const kept = [...MONEY_RECORD_FIELDS].sort();
    for (const row of [...r.purchases, ...r.payments, r.payment.purchase, ...r.failed]) {
      expect(Object.keys(row).sort()).toEqual(kept);
      expect(row).toMatchObject({
        id: 'p1', amount_cents: 4900, currency: 'usd', status: 'past_due', created_at: at(1),
      });
    }
    expect(Object.keys(r.subscribers[0]).sort()).toEqual([...kept, 'client'].sort());
    expect(r.subscribers[0].client).toEqual({ name: ANA });
    expect(r.payment.dunning).toBeNull();
    expect(r.payment.split_ledger).toEqual([
      expect.objectContaining({ id: 'l1', amount_cents: 4802 }),
    ]);
    for (const gone of GONE_AFTER_MOVE) expect(JSON.stringify(r)).not.toContain(gone);
  });

  it('after the move Money keeps name, date and amount; nothing opens the client', async () => {
    const w = world();
    const before = await readAll(w);
    w.moveTo(NEW);
    const r = await readAll(w);
    const unlinked = { id: '', name: ANA };
    expect(r.charges).toEqual([{ ...before.charges[0], client: unlinked }]);
    expect(r.charge).toEqual({
      ...before.charge,
      charge: { ...before.charge.charge, client: unlinked },
    });
    // Both to-dos (failed card, dispute) were "Message Ana"; the charge above keeps its state.
    expect(r.attention).toEqual([]);
    expect(r.decisions).toEqual([{ ...before.decisions[0], client_user_id: null }]);
  });

  it('after the move the refund still works; the plan keeps payments, not dates', async () => {
    const w = world();
    const before = await readAll(w);
    w.moveTo(NEW);
    const noDates = { current_period_end: null, access_expires_at: null };
    const { plans } = await w.payments.list(coach(OLD), CLIENT);
    expect(plans).toEqual([{ ...before.plans[0], ...noDates }]);
    const out = await w.payments.refund(coach(OLD), CLIENT, 'p1', {
      idempotency_key: KEY, charge_id: 'ch_1', amount_cents: 1000,
    });
    expect(w.refunds.createAdminRefund).toHaveBeenCalledWith(expect.objectContaining({
      purchase_id: 'p1', charge_id: 'ch_1', amount_cents: 1000, initiated_by_user_id: OLD,
    }));
    expect(out.refund).toMatchObject({ charge_id: 'ch_1', amount_cents: 1000 });
    expect(out.plan).toMatchObject({ purchase_id: 'p1', ...noDates });
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
    expect(await w.decisions.listPendingForCoach(NEW)).toEqual([]);
    expect(w.refunds.createAdminRefund).not.toHaveBeenCalled();
  });
});
