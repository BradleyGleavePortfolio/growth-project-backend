import 'reflect-metadata';
import { CoachPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { COACH_ACCOUNT_HOLD_REASON } from '../src/checkout/dunning-v2/coach-account-hold';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// HOLD-FU-BE F2 (LS-1195 C2): a renewal held because the coach's own Stripe
// account can't take payments (PF-7) is never shown or counted as the
// client's failed charge in Money's Charges list, the same way on every
// reader (attention already, Charges, the coach's failed roster). The real
// facts stay: the charge is still owed (never paid) and the hold is its cause.

// Evaluate the Prisma predicate each reader supplies (as LS-1191's spec does).
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

const COACH = 'hold-coach';
function row(id: string, status: string, dunning: { status: string; last_failure_reason: string | null } | null) {
  return {
    id, status, coach_user_id: COACH, client_user_id: `client-${id}`, source: null,
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
    created_at: new Date('2026-10-30T09:00:00Z'),
    updated_at: new Date('2026-10-30T09:00:00Z'),
    client: { id: `client-${id}`, name: 'Test client' },
    package: { id: 'pkg', name: 'Monthly coaching' },
    splits: [{ id: `slice-${id}`, kind: 'destination', status: 'posted' }],
    refunds: [], disputes: [],
    dunning,
  };
}
const HELD = { status: 'active', last_failure_reason: COACH_ACCOUNT_HOLD_REASON };
const rows = [
  row('held-renewal', 'past_due', HELD),
  row('client-failed', 'past_due', { status: 'active', last_failure_reason: 'card_declined' }),
  row('unpaid-no-dunning', 'unpaid', null),
  row('hold-cleared', 'past_due', { status: 'recovered', last_failure_reason: COACH_ACCOUNT_HOLD_REASON }),
  row('paid', 'active', null),
];
function prismaOver() {
  return {
    clientPurchase: {
      findMany: jest.fn(async ({ where, take }: { where: unknown; take?: number }) =>
        rows.filter((r) => matches(r, where)).slice(0, take ?? 100)),
      findFirst: jest.fn(async ({ where }: { where: unknown }) => rows.find((r) => matches(r, where)) ?? null),
    },
    user: { findMany: jest.fn(async () => []) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
  };
}
// Read without the DTO type so the spec runs (red, not a compile error) on main.
const waitingOn = (c: object) => (c as { waiting_on?: unknown }).waiting_on;
function money() {
  const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prismaOver()]);
  return service;
}

describe('HOLD-FU-BE: a held renewal is not the client\'s failed charge', () => {
  it('Charges "failed" filter leaves the held renewal out and keeps every client failure', async () => {
    const failed = await money().listCharges(COACH, { status: 'failed' });
    expect(failed.charges.map((c) => c.id).sort()).toEqual(['client-failed', 'hold-cleared', 'unpaid-no-dunning']);
    expect(failed.charges.every((c) => c.state === 'failed' && waitingOn(c) === null)).toBe(true);
  });

  it('Charges "all" keeps the held renewal as owed (pending, never paid) with the hold as its cause', async () => {
    const all = await money().listCharges(COACH, { status: 'all' });
    const held = all.charges.find((c) => c.id === 'held-renewal');
    expect(held).toMatchObject({ state: 'pending', waiting_on: 'coach_account', amount_cents: 14900 });
    expect(held?.state).not.toBe('paid');
    expect(held?.state).not.toBe('failed');
    const client = all.charges.find((c) => c.id === 'client-failed');
    expect(client).toMatchObject({ state: 'failed', waiting_on: null });
    expect(all.charges.find((c) => c.id === 'paid')).toMatchObject({ state: 'paid', waiting_on: null });
  });

  it('Charges "paid" never includes the held renewal', async () => {
    const paid = await money().listCharges(COACH, { status: 'paid' });
    expect(paid.charges.map((c) => c.id)).toEqual(['paid']);
  });

  it('the coach\'s failed roster (GET coach/payments/failed) follows the same rule as attention', async () => {
    const prisma = prismaOver();
    const ctrl: CoachPaymentOpsController = Reflect.construct(CoachPaymentOpsController, [
      prisma, {}, {}, {}, {}, {},
    ]);
    const out: { failed: Array<{ id: string }> } = await Reflect.apply(ctrl.failedOnRoster, ctrl, [
      { user: { id: COACH, role: 'coach' } },
    ]);
    expect(out.failed.map((p) => p.id).sort()).toEqual(['client-failed', 'hold-cleared', 'unpaid-no-dunning']);
  });
});
