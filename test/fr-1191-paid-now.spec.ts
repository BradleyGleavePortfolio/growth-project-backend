// FR-1191 (LS-1191 B1, LO-1191 C1) class-first: every reader of the "paid"
// predicates. The Money Paid list is today's state (a failing renewal is a
// Failed row); the setup checklist's "was this coach ever paid?" read
// (status=paid&limit=1, mobile setupStatus.ts) and the recurring / new-client
// readers keep the historical evidence (PAID_WHERE, BILLED_WHERE).
import 'reflect-metadata';
import {
  BILLED_WHERE,
  CoachMoneyService,
  FAILED_PURCHASE_STATUSES,
  PAID_NOW_WHERE,
  PAID_WHERE,
} from '../src/coach-money/coach-money.service';

function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return value === filter;
  return Object.entries(filter as Record<string, unknown>).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((c) => matches(value, c));
    if (key === 'OR') return Array.isArray(expected) && expected.some((c) => matches(value, c));
    if (key === 'in') return Array.isArray(expected) && expected.includes(value);
    if (key === 'notIn') return Array.isArray(expected) && !expected.includes(value);
    if (key === 'gt') return typeof value === 'number' && typeof expected === 'number' && value > expected;
    if (key === 'some') return Array.isArray(value) && value.some((v) => matches(v, expected));
    if (key === 'none') return Array.isArray(value) && !value.some((v) => matches(v, expected));
    return value !== null && typeof value === 'object' && matches((value as Record<string, unknown>)[key], expected);
  });
}

function row(id: string, status: string, day: number) {
  return {
    id, status, coach_user_id: 'coach', source: null, amount_cents: 14900, currency: 'usd',
    billing_type: 'recurring', created_at: new Date(Date.UTC(2026, 9, day)), updated_at: new Date(Date.UTC(2026, 9, day)),
    client: { id: `client-${id}`, name: 'Test client' }, package: { id: 'pkg', name: 'Monthly coaching' },
    splits: [{ kind: 'destination', status: 'posted' }], refunds: [], disputes: [],
  };
}

function service(rows: Array<ReturnType<typeof row>>) {
  const findMany = jest.fn(async ({ where, take }: { where: unknown; take: number }) =>
    rows.filter((r) => matches(r, where)).slice(0, take));
  const prisma = { clientPurchase: { findMany }, user: { findMany: jest.fn(async () => []) } };
  return { svc: Reflect.construct(CoachMoneyService, [prisma]) as CoachMoneyService, findMany };
}

describe('FR-1191: Paid list is today, history stays for its readers', () => {
  it.each([...FAILED_PURCHASE_STATUSES])('%s after an earlier paid invoice', async (status) => {
    const failing = row('failing', status, 20);
    // The Paid list (any page size the Money screen uses) leaves it out.
    expect(PAID_WHERE.AND.length + 1).toBe(PAID_NOW_WHERE.AND.length);
    expect(matches(failing, PAID_NOW_WHERE)).toBe(false);
    expect(matches(failing, PAID_WHERE)).toBe(true);
    expect(matches(failing, BILLED_WHERE)).toBe(true);
    const only = service([failing]);
    expect((await only.svc.listCharges('coach', { status: 'paid' })).charges).toHaveLength(0);
    expect((await only.svc.listCharges('coach', { status: 'paid', limit: 5 })).charges).toHaveLength(0);
    // The setup checklist still finds the coach's first payment.
    const probe = await only.svc.listCharges('coach', { status: 'paid', limit: 1 });
    expect(probe.charges.map((c) => c.id)).toEqual(['failing']);
    // With a sale paid today, the probe reads it and never falls back.
    const both = service([failing, row('paid', 'active', 10)]);
    const first = await both.svc.listCharges('coach', { status: 'paid', limit: 1 });
    expect(first.charges.map((c) => [c.id, c.state])).toEqual([['paid', 'paid']]);
    expect(both.findMany).toHaveBeenCalledTimes(1);
  });

  it('a coach never paid stays unpaid on the setup read', async () => {
    const none = service([{ ...row('trial', 'canceled', 1), splits: [] }]);
    expect((await none.svc.listCharges('coach', { status: 'paid', limit: 1 })).charges).toHaveLength(0);
  });
});
