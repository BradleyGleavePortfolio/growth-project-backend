/**
 * MetricsService — verifies the admin metrics endpoint shape, that all
 * counters come from Postgres queries (no synthesised numbers), and that
 * the only revenue figure is sourced from the Stripe-mirrored Invoice
 * table.
 */
import { MetricsService } from '../src/admin/metrics.service';

function makePrisma(overrides: Partial<Record<string, any>> = {}) {
  const counts = {
    user: jest
      .fn()
      .mockResolvedValueOnce(120) // totalUsers
      .mockResolvedValueOnce(8) // coaches
      .mockResolvedValueOnce(110) // clients
      .mockResolvedValueOnce(3), // newUsersSince
    coachProfile: { count: jest.fn().mockResolvedValueOnce(8) },
    coachSubscription: {
      count: jest
        .fn()
        .mockResolvedValueOnce(5) // active
        .mockResolvedValueOnce(2) // trialing
        .mockResolvedValueOnce(1) // canceled
        .mockResolvedValueOnce(0), // past_due
    },
    invoice: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amount_paid_cents: 150000 },
        _count: { _all: 3 },
      }),
    },
    paymentFailure: { count: jest.fn().mockResolvedValueOnce(2) },
    coachMessage: { count: jest.fn().mockResolvedValueOnce(40) },
    loggedFoodEntry: { count: jest.fn().mockResolvedValueOnce(220) },
    userProfile: { count: jest.fn().mockResolvedValueOnce(110) },
    inviteCode: {
      count: jest.fn().mockResolvedValueOnce(12),
      aggregate: jest.fn().mockResolvedValue({ _sum: { used_count: 25 } }),
    },
  };
  const prisma: any = {
    user: { count: counts.user },
    coachProfile: counts.coachProfile,
    coachSubscription: counts.coachSubscription,
    invoice: counts.invoice,
    paymentFailure: counts.paymentFailure,
    coachMessage: counts.coachMessage,
    loggedFoodEntry: counts.loggedFoodEntry,
    userProfile: counts.userProfile,
    inviteCode: counts.inviteCode,
  };
  return { prisma: { ...prisma, ...overrides }, counts };
}

describe('MetricsService.getOverview', () => {
  it('returns the documented shape with no synthesised values', async () => {
    const { prisma } = makePrisma();
    const svc = new MetricsService(prisma as any);
    const out = await svc.getOverview({ sinceDays: 30 });

    expect(out).toEqual({
      window: expect.objectContaining({ since_days: 30 }),
      users: { total: 120, coaches: 8, clients: 110, new_in_window: 3 },
      coach: { with_profile: 8 },
      billing: {
        active: 5,
        trialing: 2,
        past_due: 0,
        canceled: 1,
        invoices_paid_in_window: 3,
        invoices_paid_amount_cents_in_window: 150000,
        payment_failures_in_window: 2,
      },
      invites: { active_codes: 12, redemptions_total: 25 },
      activity: { messages_in_window: 40, food_logs_in_window: 220 },
      ai: { users_with_profile: 110 },
    });
  });

  it('uses the window only for invoice + payment-failure aggregates (Stripe-sourced)', async () => {
    const { prisma } = makePrisma();
    const svc = new MetricsService(prisma as any);
    await svc.getOverview({ sinceDays: 7 });
    const aggregateCall = (prisma.invoice.aggregate as jest.Mock).mock.calls[0][0];
    expect(aggregateCall.where.status).toBe('paid');
    expect(aggregateCall.where.paid_at.gte).toBeInstanceOf(Date);
    expect(aggregateCall._sum).toEqual({ amount_paid_cents: true });
  });

  it('defaults to 30 days when no window is provided', async () => {
    const { prisma } = makePrisma();
    const svc = new MetricsService(prisma as any);
    const out = await svc.getOverview();
    expect(out.window.since_days).toBe(30);
  });
});
