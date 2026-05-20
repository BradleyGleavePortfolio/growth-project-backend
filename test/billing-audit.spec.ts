import { BillingService } from '../src/billing/billing.service';
import { AuditAction } from '../src/audit/audit.service';

// Pins billing webhook auditing. Every Stripe-driven state change a sale
// audit cares about (subscription create/update/delete, invoice paid /
// payment-failed) must produce an immutable audit row scoped by
// tenant_coach_id, with the originating Stripe event id captured in
// metadata so an operator can correlate the row back to a Stripe event
// in the dashboard.

function buildPrisma() {
  const subscriptions: any[] = [];
  const invoices: any[] = [];
  const failures: any[] = [];
  const processed: any[] = [];
  const profiles = [{ user_id: 'coach-A', stripe_customer_id: 'cus_A' }];

  const stub: any = {
    _subscriptions: subscriptions,
    _invoices: invoices,
    _failures: failures,
    _processed: processed,
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) =>
        profiles.find((p) =>
          Object.entries(where).every(([k, v]) => (p as any)[k] === v),
        ) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        profiles.find((p) =>
          Object.entries(where).every(([k, v]) => (p as any)[k] === v),
        ) ?? null,
      ),
    },
    stripeProcessedEvent: {
      create: jest.fn(async ({ data }: any) => {
        if (processed.find((e) => e.stripe_event_id === data.stripe_event_id)) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        processed.push(data);
        return data;
      }),
    },
    coachSubscription: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const row = { ...create, id: 'sub-1', coach_id: where.coach_id };
        subscriptions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = subscriptions.find((s) => s.coach_id === where.coach_id) ?? {
          coach_id: where.coach_id,
          ...data,
        };
        Object.assign(r, data);
        if (!subscriptions.includes(r)) subscriptions.push(r);
        return r;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    invoice: {
      upsert: jest.fn(async ({ create }: any) => {
        const row = { ...create, id: 'inv-1' };
        invoices.push(row);
        return row;
      }),
    },
    paymentFailure: {
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: 'pf-1' };
        failures.push(row);
        return row;
      }),
    },
    $transaction: jest.fn(async (cb) => cb(stub)),
  };
  return stub;
}

function buildAudit() {
  return { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any;
}

describe('BillingService — Stripe webhook audit trail', () => {
  it('writes BILLING_SUBSCRIPTION_UPDATED with stripe event metadata on subscription.created', async () => {
    const prisma: any = buildPrisma();
    const audit = buildAudit();
    const svc = new BillingService(prisma, { capture: jest.fn() } as any, audit);

    await svc.handleEvent({
      id: 'evt_subcreate',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_A',
          status: 'active',
          current_period_end: 1764554400,
          trial_end: null,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_1' } }] },
        },
      },
    });

    expect(audit.write).toHaveBeenCalledTimes(1);
    const row = audit.write.mock.calls[0][0];
    expect(row.action).toBe(AuditAction.BILLING_SUBSCRIPTION_UPDATED);
    expect(row.actorId).toBeNull();
    expect(row.actorRole).toBe('system');
    expect(row.targetUserId).toBe('coach-A');
    expect(row.tenantCoachId).toBe('coach-A');
    expect(row.targetType).toBe('coach_subscription');
    expect(row.targetId).toBe('sub_1');
    expect(row.metadata.stripe_event_id).toBe('evt_subcreate');
    expect(row.metadata.stripe_event_type).toBe('customer.subscription.created');
    expect(row.metadata.status).toBe('active');
  });

  it('writes BILLING_SUBSCRIPTION_CANCELED on subscription.deleted', async () => {
    const prisma: any = buildPrisma();
    const audit = buildAudit();
    const svc = new BillingService(prisma, { capture: jest.fn() } as any, audit);

    await svc.handleEvent({
      id: 'evt_subdel',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_A' } },
    });
    const row = audit.write.mock.calls[0][0];
    expect(row.action).toBe(AuditAction.BILLING_SUBSCRIPTION_CANCELED);
    expect(row.metadata.stripe_event_id).toBe('evt_subdel');
  });

  it('writes BILLING_INVOICE_PAID with amount + currency', async () => {
    const prisma: any = buildPrisma();
    const audit = buildAudit();
    const svc = new BillingService(prisma, { capture: jest.fn() } as any, audit);

    await svc.handleEvent({
      id: 'evt_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_paid',
          customer: 'cus_A',
          amount_paid: 19900,
          amount_due: 19900,
          currency: 'usd',
          status: 'paid',
          status_transitions: { paid_at: 1764554400 },
        },
      },
    });
    const row = audit.write.mock.calls[0][0];
    expect(row.action).toBe(AuditAction.BILLING_INVOICE_PAID);
    expect(row.metadata.amount_paid_cents).toBe(19900);
    expect(row.metadata.currency).toBe('usd');
    expect(row.targetId).toBe('in_paid');
  });

  it('writes BILLING_INVOICE_PAYMENT_FAILED with reason', async () => {
    const prisma: any = buildPrisma();
    const audit = buildAudit();
    const svc = new BillingService(prisma, { capture: jest.fn() } as any, audit);

    await svc.handleEvent({
      id: 'evt_failed',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_failed',
          customer: 'cus_A',
          amount_due: 19900,
          last_payment_error: { message: 'card_declined' },
        },
      },
    });
    const row = audit.write.mock.calls[0][0];
    expect(row.action).toBe(AuditAction.BILLING_INVOICE_PAYMENT_FAILED);
    expect(row.metadata.reason).toBe('card_declined');
    expect(row.metadata.amount_due_cents).toBe(19900);
  });

  it('does not write any audit row when the customer cannot be resolved (no coach mirror)', async () => {
    const prisma: any = buildPrisma();
    const audit = buildAudit();
    const svc = new BillingService(prisma, { capture: jest.fn() } as any, audit);

    await svc.handleEvent({
      id: 'evt_unknown',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_unknown',
          status: 'active',
          items: { data: [] },
        },
      },
    });
    expect(audit.write).not.toHaveBeenCalled();
  });
});
