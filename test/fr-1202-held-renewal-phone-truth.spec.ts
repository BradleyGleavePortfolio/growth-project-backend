import 'reflect-metadata';
import { CoachPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// FR-1202 (LO-1202B B1, LS-1202B B1), class-first: what a coach is told about
// a charge is true in the phone installed today (mobile main d54ca198). That
// phone reads `pending` as "No payment has gone through for this yet, so
// nothing has reached your payouts" and hides "This plan so far"
// (MoneyChargeScreen.tsx:132-198); `failed` with settled payments keeps them
// ("Latest payment failed ... Earlier payments are counted below", :128).
// So a held renewal (PF-7) is `pending` only while no payment has gone
// through on the sale; on a plan paid before it keeps main's `failed` row.
// One table over every reader of the class: Charges All, the Failed filter,
// the charge detail, and the coach's failed roster.

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

const COACH = 'truth-coach';
const HELD = { status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON };
const CARD = { status: 'active', last_failure_reason: 'card_declined' };
const CLEARED = { status: 'recovered', last_failure_reason: COACH_ACCOUNT_HOLD_REASON };

type Dunning = { status: string; last_failure_reason: string | null } | null;
interface Case {
  id: string;
  status: string;
  dunning: Dunning;
  paidBefore: boolean;
  state: 'pending' | 'failed';
  waitingOn: 'coach_account' | null;
  inFailed: boolean;
  inRoster: boolean;
}

const CASES: Case[] = [
  // The held renewal on a plan paid before keeps main's row.
  { id: 'held-paid', status: 'past_due', dunning: HELD, paidBefore: true, state: 'failed', waitingOn: null, inFailed: true, inRoster: false },
  { id: 'held-unpaid-status-paid', status: 'unpaid', dunning: HELD, paidBefore: true, state: 'failed', waitingOn: null, inFailed: true, inRoster: false },
  // The held renewal before any payment (the first charge after a trial).
  { id: 'held-never', status: 'past_due', dunning: HELD, paidBefore: false, state: 'pending', waitingOn: 'coach_account', inFailed: false, inRoster: false },
  { id: 'held-never-pf', status: 'payment_failed', dunning: HELD, paidBefore: false, state: 'pending', waitingOn: 'coach_account', inFailed: false, inRoster: false },
  // The client's own failures are unchanged, paid before or not.
  { id: 'card-paid', status: 'past_due', dunning: CARD, paidBefore: true, state: 'failed', waitingOn: null, inFailed: true, inRoster: true },
  { id: 'card-never', status: 'past_due', dunning: CARD, paidBefore: false, state: 'failed', waitingOn: null, inFailed: true, inRoster: true },
  { id: 'cleared-paid', status: 'past_due', dunning: CLEARED, paidBefore: true, state: 'failed', waitingOn: null, inFailed: true, inRoster: true },
  { id: 'none-never', status: 'unpaid', dunning: null, paidBefore: false, state: 'failed', waitingOn: null, inFailed: true, inRoster: true },
];

function row(c: Case) {
  return {
    id: c.id, status: c.status, coach_user_id: COACH, client_user_id: `client-${c.id}`, source: null,
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
    created_at: new Date('2026-10-30T09:00:00Z'),
    updated_at: new Date('2026-10-30T09:00:00Z'),
    client: { id: `client-${c.id}`, name: 'Test client' },
    package: { id: 'pkg', name: 'Monthly coaching' },
    splits: c.paidBefore ? [{ id: `slice-${c.id}`, kind: 'destination', status: 'posted' }] : [],
    refunds: [], disputes: [],
    dunning: c.dunning,
  };
}
const ROWS = CASES.map(row);

// Two earlier monthly payments on a plan paid before; none otherwise.
function slicesFor(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c?.paidBefore) return [];
  return [1, 2].map(() => ({
    kind: 'destination', payee_user_id: COACH, amount_cents: 14900, reversed_cents: 0,
    status: 'posted', purchase_id: id, currency: 'usd',
  }));
}

function prisma() {
  return {
    clientPurchase: {
      findMany: jest.fn(async ({ where, take }: { where: unknown; take?: number }) =>
        ROWS.filter((r) => matches(r, where)).slice(0, take ?? 100)),
      findFirst: jest.fn(async ({ where }: { where: unknown }) => ROWS.find((r) => matches(r, where)) ?? null),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async ({ where }: { where: { purchase_id: string } }) => slicesFor(where.purchase_id)),
    },
    user: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    notification: { findMany: jest.fn(async () => []) },
  };
}
function money() {
  const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma()]);
  return service;
}
const waitingOn = (c: object) => (c as { waiting_on?: unknown }).waiting_on;

describe('FR-1202: a held renewal is told truly in the phone installed today', () => {
  it.each(CASES)('$id: Charges All, the Failed filter and the detail agree', async (c) => {
    const svc = money();
    const all = await svc.listCharges(COACH, { status: 'all', limit: 50 });
    const listed = all.charges.find((x) => x.id === c.id);
    expect(listed).toMatchObject({ state: c.state, amount_cents: 14900 });
    expect(waitingOn(listed ?? {})).toBe(c.waitingOn);
    expect(listed?.state).not.toBe('paid');

    const failed = await svc.listCharges(COACH, { status: 'failed', limit: 50 });
    expect(failed.charges.some((x) => x.id === c.id)).toBe(c.inFailed);
    // A row the list shows as failed is always in the Failed filter, and a
    // row in the Failed filter is always shown as failed.
    expect(c.inFailed).toBe(c.state === 'failed');

    const d = await svc.getChargeBreakdown(COACH, c.id);
    expect(d.charge.state).toBe(c.state);
    expect(d.breakdown.settled).toBe(c.paidBefore);
    // The phone's never-paid card ("No payment has gone through for this
    // yet") shows only where no payment went through.
    if (d.charge.state === 'pending') expect(d.breakdown.settled).toBe(false);
    if (c.paidBefore) expect(d.breakdown.price_cents).toBe(29800);
  });

  it('the coach\'s failed roster leaves out every held renewal and keeps every client failure', async () => {
    const ctrl: CoachPaymentOpsController = Reflect.construct(CoachPaymentOpsController, [
      prisma(), {}, {}, {}, {}, {},
    ]);
    const out: { failed: Array<{ id: string }> } = await Reflect.apply(ctrl.failedOnRoster, ctrl, [
      { user: { id: COACH, role: 'coach' } },
    ]);
    expect(out.failed.map((p) => p.id).sort()).toEqual(CASES.filter((c) => c.inRoster).map((c) => c.id).sort());
  });
});
