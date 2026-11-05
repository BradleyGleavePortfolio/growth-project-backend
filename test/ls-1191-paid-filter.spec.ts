import 'reflect-metadata';
import { CoachMoneyService } from '../src/coach-money/coach-money.service';

// Evaluate the actual Prisma predicate supplied by listCharges. The fixture
// keeps an earlier destination slice when a later recurring invoice fails.
function matches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return value === filter;
  const clauses = filter as Record<string, unknown>;
  return Object.entries(clauses).every(([key, expected]) => {
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

function row(id: string, status: string, coach = 'review-coach') {
  return {
    id, status, coach_user_id: coach, source: null,
    amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
    created_at: new Date('2026-10-30T09:00:00Z'),
    client: { id: `client-${id}`, name: 'Test client' },
    package: { id: 'review-package', name: 'Monthly coaching' },
    splits: [{ id: `slice-${id}`, kind: 'destination', status: 'posted' }],
    refunds: [], disputes: [],
  };
}

describe('LS-1191 B1: current failed collection is not a Paid-filter result', () => {
  it.each(['past_due', 'payment_failed', 'unpaid'])(
    'LS-1191 B1: Paid excludes %s even with an earlier paid destination slice',
    async (status) => {
      const rows = [row('failed-renewal', status), row('paid-control', 'active'), row('foreign', 'active', 'other-coach')];
      const prisma = {
        clientPurchase: {
          findMany: jest.fn(async ({ where, take }: { where: unknown; take: number }) =>
            rows.filter((r) => matches(r, where)).slice(0, take)),
        },
        user: { findMany: jest.fn(async () => []) },
      };
      const service: CoachMoneyService = Reflect.construct(CoachMoneyService, [prisma]);
      const failed = await service.listCharges('review-coach', { status: 'failed' });
      expect(failed.charges.map((c) => [c.id, c.state])).toEqual([['failed-renewal', 'failed']]);
      const paid = await service.listCharges('review-coach', { status: 'paid' });
      expect(paid.charges.map((c) => [c.id, c.state])).toEqual([['paid-control', 'paid']]);
    },
  );
});
