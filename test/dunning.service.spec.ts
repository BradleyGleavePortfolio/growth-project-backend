import { DunningService } from '../src/checkout/dunning.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

function makePrismaStub() {
  const dunning: any[] = [];
  const reminders: any[] = [];
  const purchases: any[] = [];
  let n = 0;
  return {
    _dunning: dunning,
    _reminders: reminders,
    _purchases: purchases,
    dunningState: {
      findUnique: jest.fn(async ({ where }: any) =>
        dunning.find((d) => d.purchase_id === where.purchase_id) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        dunning.filter((d) => {
          if (where.status && d.status !== where.status) return false;
          if (where.OR) {
            const ok = where.OR.some((clause: any) => {
              if (clause.grace_period_ends_at?.lte) {
                return (
                  d.grace_period_ends_at && d.grace_period_ends_at <= clause.grace_period_ends_at.lte
                );
              }
              if (clause.cancel_scheduled_at?.lte) {
                return (
                  d.cancel_scheduled_at && d.cancel_scheduled_at <= clause.cancel_scheduled_at.lte
                );
              }
              return false;
            });
            if (!ok) return false;
          }
          if (where.cancel_scheduled_at) {
            const c = where.cancel_scheduled_at;
            if (c.not === null && d.cancel_scheduled_at == null) return false;
            if (c.gt && !(d.cancel_scheduled_at && d.cancel_scheduled_at > c.gt)) return false;
            if (c.lte && !(d.cancel_scheduled_at && d.cancel_scheduled_at <= c.lte)) return false;
          }
          return true;
        }),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 'd-' + ++n, created_at: new Date(), ...data };
        dunning.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = dunning.find((d) =>
          where.purchase_id ? d.purchase_id === where.purchase_id : d.id === where.id,
        );
        if (data.failure_count?.increment) {
          row.failure_count = (row.failure_count ?? 0) + data.failure_count.increment;
          delete data.failure_count;
        }
        Object.assign(row, data);
        return { ...row };
      }),
    },
    paymentReminder: {
      create: jest.fn(async ({ data }: any) => {
        const dupe = reminders.find(
          (r) =>
            r.purchase_id === data.purchase_id &&
            r.kind === data.kind &&
            r.channel === data.channel &&
            r.window_key === data.window_key,
        );
        if (dupe) {
          const err: any = new Error('unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: 'r-' + ++n, created_at: new Date(), ...data };
        reminders.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = reminders.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => p.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
}

class StripeStub extends StripeConnectApiService {
  cancelSubscription = jest.fn(async (id: string) => ({ id, status: 'canceled' }));
}

const PURCHASE = {
  id: 'p1',
  client_user_id: 'cli-1',
  coach_user_id: 'coach-1',
  stripe_subscription_id: 'sub_abc',
  status: 'past_due',
} as any;

describe('DunningService', () => {
  let prisma: any;
  let svc: DunningService;
  let stripe: StripeStub;

  beforeEach(() => {
    prisma = makePrismaStub();
    stripe = new StripeStub();
    svc = new DunningService(prisma, stripe as any);
    prisma._purchases.push({ ...PURCHASE });
  });

  it('opens a dunning window on first failure', async () => {
    const row = await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'card_declined',
    });
    expect(row.status).toBe('active');
    expect(row.failure_count).toBe(1);
    expect(row.last_failed_amount_cents).toBe(9900);
    expect(row.grace_period_ends_at).toBeInstanceOf(Date);
    // Two reminders queued (inapp + email), idempotency key = invoice id.
    expect(prisma._reminders).toHaveLength(2);
    expect(prisma._reminders.every((r: any) => r.window_key === 'inv_1')).toBe(true);
  });

  it('does NOT double-queue reminders for the same invoice', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'card_declined',
    });
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 2,
      reason: 'card_declined',
    });
    // Still 2 reminders, but failure_count is 2 now.
    expect(prisma._reminders).toHaveLength(2);
    expect(prisma._dunning[0].failure_count).toBe(2);
    expect(prisma._dunning[0].last_attempt_number).toBe(2);
  });

  it('schedules an immediate cancel when Stripe attempt_count is at max', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 4,
      reason: 'card_declined',
    });
    const row = prisma._dunning[0];
    const now = Date.now();
    expect(row.cancel_scheduled_at.getTime() - now).toBeLessThan(2 * 24 * 3600 * 1000);
  });

  it('resolves the window on successful renewal', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    const resolved = await svc.recordResolution(PURCHASE.id);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolved_at).toBeInstanceOf(Date);
  });

  it('sweeper cancels expired-grace-period rows on Stripe and writes a final reminder', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: 'declined',
    });
    // Force grace period into the past.
    prisma._dunning[0].grace_period_ends_at = new Date(Date.now() - 1000);
    const result = await svc.runSweeper();
    expect(result.canceled).toBe(1);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_abc');
    // The purchase row should now be canceled and entitlement off.
    expect(prisma._purchases[0].status).toBe('canceled');
    expect(prisma._purchases[0].entitlement_active).toBe(false);
    // A canceled_for_nonpayment reminder was queued.
    expect(
      prisma._reminders.some((r: any) => r.kind === 'canceled_for_nonpayment'),
    ).toBe(true);
  });

  it('emits a final_warning reminder when cancel is within 24h', async () => {
    await svc.recordFailure({
      purchase: PURCHASE,
      stripe_invoice_id: 'inv_1',
      amount_due_cents: 9900,
      attempt_number: 1,
      reason: null,
    });
    // Place cancel exactly 12h away.
    prisma._dunning[0].cancel_scheduled_at = new Date(Date.now() + 12 * 3600 * 1000);
    prisma._dunning[0].grace_period_ends_at = new Date(Date.now() + 48 * 3600 * 1000);
    const out = await svc.runSweeper();
    expect(out.final_warned).toBeGreaterThanOrEqual(1);
    expect(
      prisma._reminders.some((r: any) => r.kind === 'final_warning'),
    ).toBe(true);
  });
});
