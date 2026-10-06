import { NotFoundException } from '@nestjs/common';
import { PackagesService } from '../src/packages/packages.service';

// MONEY-CONNECT-124: the actual Prisma-shaped management reads, not invented
// camel-case fixtures. No Stripe calls or database writes.
const packageRow = (over: Record<string, unknown> = {}) => ({
  id: 'pkg-49',
  coach_id: 'coach-1',
  name: 'Monthly coaching',
  amount_cents: 4900,
  currency: 'gbp',
  billing_type: 'recurring',
  interval: 'month',
  interval_count: 1,
  recurring_amount_cents: null,
  recurring_interval: null,
  recurring_interval_count: null,
  is_active: true,
  archived_at: null,
  published_at: new Date('2026-10-01T12:00:00Z'),
  ...over,
});

const purchase = (over: Record<string, unknown> = {}) => ({
  id: 'purchase-1',
  package_id: 'pkg-49',
  client_user_id: 'client-1',
  coach_user_id: 'coach-1',
  amount_cents: 4900,
  currency: 'gbp',
  billing_type: 'recurring',
  status: 'active',
  entitlement_active: true,
  source: null,
  stripe_subscription_id: 'sub_1',
  current_period_end: new Date('2026-11-01T12:00:00Z'),
  cancel_at_period_end: false,
  created_at: new Date('2026-10-01T12:00:00Z'),
  client: { name: 'Sam', email: 'sam@example.com', password: 'never-return' },
  stripe_client_secret: 'never-return',
  stripe_ephemeral_key: 'never-return',
  ...over,
});

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object') {
      const filter = value as { in?: unknown[]; not?: unknown };
      if (filter.in) return filter.in.includes(row[key]);
      if ('not' in filter) return row[key] !== filter.not;
    }
    return row[key] === value;
  });
}

function project(row: Record<string, unknown>, select: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(select).map(([key, spec]) => {
    if (spec === true) return [key, row[key]];
    const fields = (spec as { select: Record<string, unknown> }).select;
    const nested = row[key] as Record<string, unknown>;
    return [key, Object.fromEntries(Object.keys(fields).map((k) => [k, nested?.[k]]))];
  }));
}

function setup(
  packages = [packageRow()],
  purchases = [purchase()],
) {
  const prisma = {
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(),
    coachPackage: {
      findMany: jest.fn(async ({ where }) => packages.filter((p) => matches(p, where))),
      findFirst: jest.fn(async ({ where }) => packages.find((p) => matches(p, where)) ?? null),
      update: jest.fn(async ({ where, data }) => ({ ...packages.find((p) => p.id === where.id), ...data })),
    },
    coachPackageContent: { count: jest.fn(async () => 2) },
    clientPurchase: {
      count: jest.fn(async ({ where }) => purchases.filter((p) => matches(p, where)).length),
      findMany: jest.fn(async ({ where, select, skip = 0, take }) => {
        const rows = purchases.filter((p) => matches(p, where));
        return rows.slice(skip, take === undefined ? undefined : skip + take)
          .map((p) => select ? project(p, select) : p);
      }),
    },
  };
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  const svc: PackagesService = Reflect.construct(PackagesService, [prisma, {}]);
  return { prisma, svc };
}

describe('MONEY-CONNECT-124 package management reads', () => {
  it('B-PACKAGE-1: a £49 monthly sale shows one client and £49 MRR, not invented zeros', async () => {
    const { svc } = setup();
    expect(await svc.listForCoach('coach-1')).toEqual([
      expect.objectContaining({ subscriber_count: 1, monthly_revenue_cents: 4900 }),
    ]);
    expect(await svc.getOwnedDetail('coach-1', 'pkg-49')).toMatchObject({
      subscriber_count: 1, monthly_revenue_cents: 4900, content_count: 2,
    });
  });

  it('counts clients once; trials and free access are never paid MRR', async () => {
    const { svc } = setup([packageRow()], [
      purchase(),
      purchase({ id: 'duplicate-history', status: 'canceled' }),
      purchase({ id: 'trial', client_user_id: 'client-2', status: 'trialing' }),
      purchase({ id: 'grant', client_user_id: 'client-3', source: 'free_package_claim',
        status: 'granted', billing_type: 'one_time', amount_cents: 0 }),
    ]);
    expect((await svc.listForCoach('coach-1'))[0]).toMatchObject({
      subscriber_count: 3, monthly_revenue_cents: 4900,
    });
  });

  it('normalizes £49 every three months to monthly MRR and never adds another currency', async () => {
    const { svc } = setup([packageRow({ interval_count: 3 })], [
      purchase(), purchase({ id: 'usd-sale', client_user_id: 'client-us', currency: 'usd' }),
    ]);
    expect((await svc.listForCoach('coach-1'))[0]).toMatchObject({
      currency: 'gbp', subscriber_count: 2, monthly_revenue_cents: 1633,
    });
  });

  it('one-time buyers have access, not recurring revenue', async () => {
    const { svc } = setup([packageRow({ billing_type: 'one_time', interval: null })], [
      purchase({ billing_type: 'one_time', status: 'paid', stripe_subscription_id: null }),
    ]);
    expect((await svc.listForCoach('coach-1'))[0]).toMatchObject({
      subscriber_count: 1, monthly_revenue_cents: 0, pricing_locked: false,
    });
  });

  it('a saved purchase price remains the MRR amount rather than the current catalog price', async () => {
    const { svc } = setup([packageRow({ amount_cents: 5900 })]);
    expect((await svc.listForCoach('coach-1'))[0]).toMatchObject({
      amount_cents: 5900, monthly_revenue_cents: 4900,
    });
  });

  it('B-PACKAGE-2: subscriber rows include allow-listed client names and real totals/currency', async () => {
    const { svc, prisma } = setup();
    const result = await svc.listSubscribers('coach-1', 'pkg-49');
    expect(result).toMatchObject({
      package_id: 'pkg-49', currency: 'gbp', subscriber_count: 1,
      monthly_revenue_cents: 4900,
      subscribers: [expect.objectContaining({
        client_user_id: 'client-1', client: { name: 'Sam', email: 'sam@example.com' },
      })],
    });
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(prisma.clientPurchase.findMany.mock.calls[0][0].select.client).toEqual({
      select: { name: true, email: true },
    });
  });

  it('checks package ownership before reading any buyer or summary data', async () => {
    const { svc, prisma } = setup();
    await expect(svc.listSubscribers('another-coach', 'pkg-49')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.clientPurchase.findMany).not.toHaveBeenCalled();
  });

  it('B-PRICING-1: paused access cannot change terms still held by a live Stripe subscription', async () => {
    const { svc, prisma } = setup([packageRow()], [
      purchase({ status: 'past_due', entitlement_active: false }),
    ]);
    await expect(svc.update('coach-1', 'pkg-49', {
      amount_cents: 5900, interval_count: 3,
    })).rejects.toMatchObject({ response: { code: 'PACKAGE_PRICING_LOCKED' } });
    expect(prisma.coachPackage.update).not.toHaveBeenCalled();
    expect((await svc.listForCoach('coach-1'))[0]).toMatchObject({
      subscriber_count: 0, monthly_revenue_cents: 0, pricing_locked: true,
    });
  });
});
