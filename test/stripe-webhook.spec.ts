import {
  resolveStripeWebhookSecrets,
  signStripePayload,
  StripeSignatureError,
  verifyStripeSignature,
} from '../src/billing/stripe-signature';
import { BillingService } from '../src/billing/billing.service';

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_123';
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });

  it('accepts a freshly-signed payload', () => {
    const header = signStripePayload({ payload, secret });
    expect(() =>
      verifyStripeSignature({ payload, signatureHeader: header, secret }),
    ).not.toThrow();
  });

  it('rejects a missing header', () => {
    expect(() =>
      verifyStripeSignature({ payload, signatureHeader: '', secret }),
    ).toThrow(StripeSignatureError);
  });

  it('rejects when the secret is wrong', () => {
    const header = signStripePayload({ payload, secret });
    expect(() =>
      verifyStripeSignature({ payload, signatureHeader: header, secret: 'wrong' }),
    ).toThrow(StripeSignatureError);
  });

  it('rejects when the body has been tampered with', () => {
    const header = signStripePayload({ payload, secret });
    expect(() =>
      verifyStripeSignature({ payload: payload + 'x', signatureHeader: header, secret }),
    ).toThrow(StripeSignatureError);
  });

  it('rejects timestamps outside the tolerance window', () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const header = signStripePayload({ payload, secret, timestamp: old });
    expect(() =>
      verifyStripeSignature({ payload, signatureHeader: header, secret }),
    ).toThrow(StripeSignatureError);
  });

  it('rejects malformed signature header', () => {
    expect(() =>
      verifyStripeSignature({ payload, signatureHeader: 'not-a-header', secret }),
    ).toThrow(StripeSignatureError);
  });

  // Dual-secret rotation support (audit ref: /audits/00_MASTER_REPORT.md line 195).
  it('accepts a signature that matches the OLD secret during rotation', () => {
    const oldSecret = 'whsec_old_111';
    const newSecret = 'whsec_new_222';
    const header = signStripePayload({ payload, secret: oldSecret });
    expect(() =>
      verifyStripeSignature({
        payload,
        signatureHeader: header,
        secrets: [oldSecret, newSecret],
      }),
    ).not.toThrow();
  });

  it('accepts a signature that matches the NEW secret during rotation', () => {
    const oldSecret = 'whsec_old_111';
    const newSecret = 'whsec_new_222';
    const header = signStripePayload({ payload, secret: newSecret });
    expect(() =>
      verifyStripeSignature({
        payload,
        signatureHeader: header,
        secrets: [oldSecret, newSecret],
      }),
    ).not.toThrow();
  });

  it('rejects when no configured secret matches', () => {
    const header = signStripePayload({ payload, secret: 'whsec_unrelated' });
    expect(() =>
      verifyStripeSignature({
        payload,
        signatureHeader: header,
        secrets: ['whsec_a', 'whsec_b'],
      }),
    ).toThrow(StripeSignatureError);
  });

  it('rejects an empty secret list as not configured', () => {
    expect(() =>
      verifyStripeSignature({
        payload,
        signatureHeader: 'whatever',
        secrets: ['', '   '],
      }),
    ).toThrow(/secret not configured/i);
  });
});

describe('resolveStripeWebhookSecrets', () => {
  it('returns a single secret when only STRIPE_WEBHOOK_SECRET is set', () => {
    expect(
      resolveStripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: 'whsec_a' } as any),
    ).toEqual(['whsec_a']);
  });

  it('returns both secrets, in order, during a rotation', () => {
    expect(
      resolveStripeWebhookSecrets({
        STRIPE_WEBHOOK_SECRET: 'whsec_a',
        STRIPE_WEBHOOK_SECRET_NEXT: 'whsec_b',
      } as any),
    ).toEqual(['whsec_a', 'whsec_b']);
  });

  it('drops empty / whitespace-only env values', () => {
    expect(
      resolveStripeWebhookSecrets({
        STRIPE_WEBHOOK_SECRET: '',
        STRIPE_WEBHOOK_SECRET_NEXT: '   ',
      } as any),
    ).toEqual([]);
  });

  it('de-duplicates when both env vars hold the same secret', () => {
    expect(
      resolveStripeWebhookSecrets({
        STRIPE_WEBHOOK_SECRET: 'whsec_a',
        STRIPE_WEBHOOK_SECRET_NEXT: 'whsec_a',
      } as any),
    ).toEqual(['whsec_a']);
  });
});

describe('BillingService', () => {
  let prisma: any;
  let svc: BillingService;

  beforeEach(() => {
    const subscriptions: any[] = [];
    const invoices: any[] = [];
    const failures: any[] = [];
    const processed: any[] = [];
    const profiles: any[] = [{ user_id: 'coach-A', stripe_customer_id: 'cus_A' }];

    prisma = {
      _subscriptions: subscriptions,
      _invoices: invoices,
      _failures: failures,
      _processed: processed,
      coachProfile: {
        findUnique: jest.fn(async ({ where }: any) => {
          return profiles.find((p) =>
            Object.entries(where).every(([k, v]) => (p as any)[k] === v),
          ) ?? null;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          return profiles.find((p) =>
            Object.entries(where).every(([k, v]) => (p as any)[k] === v),
          ) ?? null;
        }),
      },
      stripeProcessedEvent: {
        findUnique: jest.fn(async ({ where }: any) =>
          processed.find((e) => e.stripe_event_id === where.stripe_event_id) ?? null,
        ),
        // Simulates Prisma's P2002 unique-constraint violation when the same
        // event id is written twice — exercises the insert-first idempotency
        // path in BillingService.handleEvent.
        create: jest.fn(async ({ data }: any) => {
          if (processed.find((e) => e.stripe_event_id === data.stripe_event_id)) {
            const err: any = new Error(
              'Unique constraint failed on stripe_event_id',
            );
            err.code = 'P2002';
            throw err;
          }
          processed.push({ ...data, processed_at: new Date() });
          return data;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = processed.find((e) => e.stripe_event_id === where.stripe_event_id);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const existing = subscriptions.find((s) => s.coach_id === where.coach_id);
          if (existing) {
            Object.assign(existing, update, { updated_at: new Date() });
            return { ...existing };
          }
          const row = { ...create, id: 'sub-' + (subscriptions.length + 1), updated_at: new Date(), created_at: new Date() };
          subscriptions.push(row);
          return { ...row };
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const r = subscriptions.find((s) => s.coach_id === where.coach_id);
          if (!r) throw new Error('not found');
          Object.assign(r, data);
          return { ...r };
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const r of subscriptions) {
            if (r.coach_id === where.coach_id) {
              for (const [k, v] of Object.entries(data)) {
                if (typeof v === 'object' && v !== null && 'increment' in (v as any)) {
                  r[k] = (r[k] ?? 0) + (v as any).increment;
                } else {
                  r[k] = v;
                }
              }
              count++;
            }
          }
          return { count };
        }),
      },
      invoice: {
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const existing = invoices.find((i) => i.stripe_invoice_id === where.stripe_invoice_id);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const row = { ...create, id: 'inv-' + (invoices.length + 1), created_at: new Date() };
          invoices.push(row);
          return { ...row };
        }),
        findMany: jest.fn(async () => invoices),
      },
      paymentFailure: {
        create: jest.fn(async ({ data }: any) => {
          const row = { ...data, id: 'pf-' + (failures.length + 1) };
          failures.push(row);
          return row;
        }),
      },
    };
    // BillingService.handleEvent() wraps coachProfile.findFirst + coachSubscription.upsert
    // in this.prisma.$transaction(cb). The mock must invoke the callback with the same
    // prisma object so that upserts accumulate in _subscriptions.
    prisma.$transaction = jest.fn(async (cb: (tx: any) => Promise<any>) => cb(prisma));
    const analyticsStub = { capture: jest.fn(), identify: jest.fn() } as any;
    svc = new BillingService(prisma, analyticsStub, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
  });

  it('creates a subscription mirror row on customer.subscription.created', async () => {
    const result = await svc.handleEvent({
      id: 'evt_1',
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
    expect(result.processed).toBe(true);
    expect(prisma._subscriptions).toHaveLength(1);
    expect(prisma._subscriptions[0].status).toBe('active');
    expect(prisma._subscriptions[0].coach_id).toBe('coach-A');
    expect(prisma._subscriptions[0].stripe_subscription_id).toBe('sub_1');
  });

  it('is idempotent on duplicate event ids', async () => {
    const event = {
      id: 'evt_dup',
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
    };
    const a = await svc.handleEvent(event);
    const b = await svc.handleEvent(event);
    expect(a.processed).toBe(true);
    expect(b.processed).toBe(false);
    expect(b.alreadyProcessed).toBe(true);
    expect(prisma._subscriptions).toHaveLength(1);
  });

  it('marks subscription canceled on customer.subscription.deleted', async () => {
    await svc.handleEvent({
      id: 'evt_a',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_A',
          status: 'active',
          current_period_end: 1764554400,
          items: { data: [] },
        },
      },
    });
    await svc.handleEvent({
      id: 'evt_b',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_A' } },
    });
    expect(prisma._subscriptions[0].status).toBe('canceled');
  });

  it('records invoice on invoice.paid and clears last_payment_failed_at', async () => {
    // Pre-existing past_due sub
    prisma._subscriptions.push({
      id: 's1',
      coach_id: 'coach-A',
      status: 'past_due',
      last_payment_failed_at: new Date(),
      failed_payments_this_month: 2,
    });
    await svc.handleEvent({
      id: 'evt_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_A',
          amount_paid: 30000,
          amount_due: 30000,
          currency: 'usd',
          status: 'paid',
        },
      },
    });
    expect(prisma._invoices).toHaveLength(1);
    expect(prisma._invoices[0].amount_paid_cents).toBe(30000);
    expect(prisma._subscriptions[0].last_payment_failed_at).toBeNull();
    expect(prisma._subscriptions[0].failed_payments_this_month).toBe(0);
  });

  it('records a PaymentFailure row on invoice.payment_failed', async () => {
    prisma._subscriptions.push({
      id: 's1',
      coach_id: 'coach-A',
      status: 'past_due',
      last_payment_failed_at: null,
      failed_payments_this_month: 0,
    });
    await svc.handleEvent({
      id: 'evt_fail',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_2',
          customer: 'cus_A',
          amount_due: 30000,
          last_payment_error: { message: 'card declined' },
        },
      },
    });
    expect(prisma._failures).toHaveLength(1);
    expect(prisma._failures[0].reason).toBe('card declined');
    expect(prisma._subscriptions[0].failed_payments_this_month).toBe(1);
    expect(prisma._subscriptions[0].last_payment_failed_at).toBeInstanceOf(Date);
  });

  it('ignores events for unknown stripe customers (no row written)', async () => {
    await svc.handleEvent({
      id: 'evt_unknown',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_x',
          customer: 'cus_UNKNOWN',
          status: 'active',
          current_period_end: 1764554400,
          items: { data: [] },
        },
      },
    });
    expect(prisma._subscriptions).toHaveLength(0);
    // Still records the event id so retries are idempotent
    expect(prisma._processed).toHaveLength(1);
  });
});
