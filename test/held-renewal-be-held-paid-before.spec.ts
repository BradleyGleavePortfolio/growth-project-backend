import 'reflect-metadata';
import type { User } from '@prisma/client';
import { CoachClientPaymentsService } from '../src/checkout/coach-client-payments.service';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';
import { PackagesService } from '../src/packages/packages.service';

// HELD-RENEWAL-BE (LO-1202B C1, m#920's server half), class-first: a renewal
// TGP holds on the coach's own Stripe account (PF-7) for a client who paid
// before is sent to the coach as held, never as the client's missed payment,
// on every coach read of it: Money's charges list and charge detail (state
// `pending`, `waiting_on: 'coach_account'`, the earlier payments kept as
// `settled`; mobile main 12f158c1 MoneyChargeScreen.tsx:132-139 keeps "This
// plan so far" when `settled`), the coach's plan view (`waiting_on` set, Pause
// not answered PLAN_PAYMENT_FAILED) and a package's subscriber list (never
// "Past due"). Controls: a real failed renewal reads exactly as today, and a
// held first payment (never paid) reads as today.
// Fields the base does not send are read loosely, so the spec runs red (not a
// compile error) at the base and the controls stay green there.

const COACH = 'held-be-coach';
const HELD = { status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON };
const CARD = { status: 'active', last_failure_reason: 'card_declined' };
type Dunning = { status: string; last_failure_reason: string | null } | null;
const field = (o: unknown, k: string) => (o as Record<string, unknown> | undefined)?.[k];

function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((c) => matches(value, c));
    if (key === 'OR') return Array.isArray(expected) && expected.some((c) => matches(value, c));
    if (key === 'NOT') return !(Array.isArray(expected) ? expected : [expected]).some((c) => matches(value, c));
    if (key === 'in') return Array.isArray(expected) && expected.includes(value);
    if (key === 'notIn') return Array.isArray(expected) && !expected.includes(value);
    if (key === 'not') return !matches(value, expected);
    if (key === 'gt') return typeof value === 'number' && typeof expected === 'number' && value > expected;
    if (key === 'some') return Array.isArray(value) && value.some((v) => matches(v, expected));
    if (key === 'none') return Array.isArray(value) && !value.some((v) => matches(v, expected));
    return value !== null && typeof value === 'object'
      && matches((value as Record<string, unknown>)[key], expected);
  });
}

// ── Money: charges list and charge detail ───────────────────────────────

interface ChargeCase {
  id: string;
  status: string;
  dunning: Dunning;
  paidBefore: boolean;
  state: 'pending' | 'failed';
  waitingOn: 'coach_account' | null;
}
const HELD_CHARGES: ChargeCase[] = [
  { id: 'held-paid', status: 'past_due', dunning: HELD, paidBefore: true, state: 'pending', waitingOn: 'coach_account' },
  { id: 'held-paid-unpaid', status: 'unpaid', dunning: HELD, paidBefore: true, state: 'pending', waitingOn: 'coach_account' },
];
const CONTROL_CHARGES: ChargeCase[] = [
  // A real failed renewal, paid before or not: exactly as today.
  { id: 'card-paid', status: 'past_due', dunning: CARD, paidBefore: true, state: 'failed', waitingOn: null },
  { id: 'card-never', status: 'past_due', dunning: CARD, paidBefore: false, state: 'failed', waitingOn: null },
  { id: 'none-unpaid', status: 'unpaid', dunning: null, paidBefore: true, state: 'failed', waitingOn: null },
  // A held first payment (never paid): as today.
  { id: 'held-never', status: 'past_due', dunning: HELD, paidBefore: false, state: 'pending', waitingOn: 'coach_account' },
];
const CHARGES = [...HELD_CHARGES, ...CONTROL_CHARGES];
const CHARGE_ROWS = CHARGES.map((c) => ({
  id: c.id, status: c.status, coach_user_id: COACH, client_user_id: `client-${c.id}`, source: null,
  amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
  created_at: new Date('2026-10-30T09:00:00Z'),
  updated_at: new Date('2026-10-30T09:00:00Z'),
  client: { id: `client-${c.id}`, name: 'Test client' },
  package: { id: 'pkg', name: 'Monthly coaching' },
  splits: c.paidBefore ? [{ id: `slice-${c.id}`, kind: 'destination', status: 'posted' }] : [],
  refunds: [], disputes: [],
  dunning: c.dunning,
}));

function money() {
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async ({ where, take }: { where: unknown; take?: number }) =>
        CHARGE_ROWS.filter((r) => matches(r, where)).slice(0, take ?? 100)),
      findFirst: jest.fn(async ({ where }: { where: unknown }) =>
        CHARGE_ROWS.find((r) => matches(r, where)) ?? null),
    },
    splitLedgerEntry: {
      // Two earlier monthly payments that reached the coach, on a plan paid before.
      findMany: jest.fn(async ({ where }: { where: { purchase_id: string } }) =>
        CHARGES.find((c) => c.id === where.purchase_id)?.paidBefore
          ? [1, 2].map(() => ({
              kind: 'destination', payee_user_id: COACH, amount_cents: 14900, reversed_cents: 0,
              status: 'posted', purchase_id: where.purchase_id, currency: 'usd',
            }))
          : []),
    },
    user: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    notification: { findMany: jest.fn(async () => []) },
  };
  const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
  return service;
}

async function chargeReads(c: ChargeCase) {
  const svc = money();
  const all = await svc.listCharges(COACH, { status: 'all', limit: 50 });
  const failed = await svc.listCharges(COACH, { status: 'failed', limit: 50 });
  const detail = await svc.getChargeBreakdown(COACH, c.id);
  return {
    listed: all.charges.find((x) => x.id === c.id),
    inFailed: failed.charges.some((x) => x.id === c.id),
    detail,
  };
}

function expectCharge(c: ChargeCase, r: Awaited<ReturnType<typeof chargeReads>>) {
  expect(r.listed).toMatchObject({ state: c.state, amount_cents: 14900 });
  expect(field(r.listed, 'waiting_on')).toBe(c.waitingOn);
  expect(r.inFailed).toBe(c.state === 'failed');
  expect(r.detail.charge.state).toBe(c.state);
  expect(field(r.detail.charge, 'waiting_on')).toBe(c.waitingOn);
  // The earlier payments stay counted: the phone keeps "This plan so far".
  expect(r.detail.breakdown.settled).toBe(c.paidBefore);
  if (c.paidBefore) expect(r.detail.breakdown.price_cents).toBe(29800);
}

describe('HELD-RENEWAL-BE: Money sends a held renewal paid before as held', () => {
  it.each(HELD_CHARGES)('$id: charges list and charge detail say held, with waiting_on set', async (c) => {
    expectCharge(c, await chargeReads(c));
  });
  it.each(CONTROL_CHARGES)('control $id: reads exactly as today', async (c) => {
    expectCharge(c, await chargeReads(c));
  });
});

// ── The coach's plan view (GET/POST v1/coach/clients/:id/payments) ─────

const CLIENT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-10-30T09:00:00Z');
const coach = { id: COACH, role: 'coach' } as User;

function plans(status: string, dunning: Dunning) {
  const row = {
    id: 'p1', coach_user_id: COACH, client_user_id: CLIENT, package_id: 'pkg',
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status,
    stripe_subscription_id: 'sub_1', created_at: at, current_period_end: at,
    access_expires_at: at, cancel_at_period_end: false, entitlement_active: true,
    package: { name: 'Monthly coaching' }, dunning, refunds: [],
    settlements: [{
      stripe_charge_id: 'ch_earlier', currency: 'usd', gross_cents: 14900, refunded_cents: 0,
      dispute_withdrawn_cents: 0, created_at: new Date('2026-09-30T09:00:00Z'),
    }],
  };
  const stripe = {
    retrieveSubscription: jest.fn(async () => ({ id: 'sub_1', status, pause_collection: null })),
    pauseSubscriptionCollection: jest.fn(),
  };
  const prisma = {
    clientPurchase: { findMany: jest.fn(async () => [row]) },
    user: { findMany: jest.fn(async () => []) },
  };
  const feePolicy = { resolveHeadCoachId: jest.fn(async () => null) };
  const service: CoachClientPaymentsService = Reflect.construct(
    CoachClientPaymentsService,
    [prisma, stripe, {}, {}, feePolicy, { write: jest.fn() }],
  );
  return { service, stripe };
}

describe('HELD-RENEWAL-BE: the coach plan view sends a held renewal as held', () => {
  it.each([['past_due'], ['unpaid']])('held %s paid before: waiting_on set, Pause not PLAN_PAYMENT_FAILED', async (status) => {
    const { service, stripe } = plans(status, HELD);
    const [plan] = (await service.list(coach, CLIENT)).plans;
    expect(field(plan, 'waiting_on')).toBe('coach_account');
    // The row's status and actions are unchanged: a cancel of a held renewal
    // still ends the plan now (client-billing isDelinquent), as the phone says.
    expect(plan).toMatchObject({ status, billing: 'running', actions: { cancel: true, pause: false } });
    expect(plan.payments).toHaveLength(1);
    const err = await service.pause(coach, CLIENT, 'p1', KEY).catch((e: unknown) => e);
    expect(field(field(err, 'response'), 'code')).toBe('ACTION_NOT_AVAILABLE');
    expect(stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
  });

  it.each([['past_due'], ['unpaid']])('control: a real failed %s renewal reads exactly as today', async (status) => {
    const { service, stripe } = plans(status, CARD);
    const [plan] = (await service.list(coach, CLIENT)).plans;
    expect(field(plan, 'waiting_on') ?? null).toBeNull();
    expect(plan).toMatchObject({ status, billing: 'running', actions: { cancel: true, pause: false } });
    await expect(service.pause(coach, CLIENT, 'p1', KEY)).rejects.toMatchObject({
      response: { code: 'PLAN_PAYMENT_FAILED' },
    });
    expect(stripe.pauseSubscriptionCollection).not.toHaveBeenCalled();
  });
});

// ── A package's subscriber list (GET v1/coach/packages/:id/subscribers) ─

function project(row: Record<string, unknown>, select: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(select).map(([key, spec]) => {
    if (spec === true) return [key, row[key]];
    const fields = (spec as { select: Record<string, unknown> }).select;
    const nested = row[key] as Record<string, unknown> | null | undefined;
    return [key, nested == null ? null : Object.fromEntries(Object.keys(fields).map((k) => [k, nested[k]]))];
  }));
}

function subscribers(status: string, dunning: Dunning) {
  const pkg = {
    id: 'pkg-1', coach_id: COACH, name: 'Monthly coaching', amount_cents: 14900, currency: 'usd',
    billing_type: 'recurring', interval: 'month', interval_count: 1, recurring_amount_cents: null,
    recurring_interval: null, recurring_interval_count: null, is_active: true, archived_at: null,
    published_at: at,
  };
  const purchase = {
    id: 'sale-1', package_id: 'pkg-1', client_user_id: 'client-1', coach_user_id: COACH,
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring', status, entitlement_active: true,
    source: null, stripe_subscription_id: 'sub_1', current_period_end: at, cancel_at_period_end: false,
    created_at: at, client: { name: 'Sam', email: 'redacted-address' }, dunning,
  };
  const prisma = {
    coachPackage: {
      findFirst: jest.fn(async () => pkg),
      findMany: jest.fn(async () => [pkg]),
    },
    clientPurchase: {
      findMany: jest.fn(async ({ select }: { select?: Record<string, unknown> }) =>
        [select ? project(purchase, select) : purchase]),
    },
    user: { findMany: jest.fn(async () => []) },
  };
  const svc: PackagesService = Reflect.construct(PackagesService, [prisma, {}]);
  return svc;
}

describe('HELD-RENEWAL-BE: a package subscriber list never marks a held renewal past due', () => {
  it.each([['past_due'], ['unpaid']])('held %s: not past due, waiting_on set', async (status) => {
    const { subscribers: rows } = await subscribers(status, HELD).listSubscribers(COACH, 'pkg-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(field(rows[0], 'waiting_on')).toBe('coach_account');
    // The hold marker is read, never sent.
    expect(field(rows[0], 'dunning')).toBeUndefined();
  });

  it.each([['past_due'], ['unpaid']])('control: a real failed %s renewal reads exactly as today', async (status) => {
    const { subscribers: rows } = await subscribers(status, CARD).listSubscribers(COACH, 'pkg-1');
    expect(rows[0].status).toBe(status);
    expect(field(rows[0], 'waiting_on') ?? null).toBeNull();
    expect(field(rows[0], 'dunning')).toBeUndefined();
  });
});
