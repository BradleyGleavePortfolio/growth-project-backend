import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { BillingService } from '../src/billing/billing.service';
import {
  signStripePayload,
  verifyStripeSignature,
} from '../src/billing/stripe-signature';

// Fixture-driven smoke. Validates that:
//   1. every fixture in test/fixtures/stripe/*.json round-trips cleanly
//      through the in-process signature helper (so the smoke script and the
//      webhook controller agree on the byte sequence being signed), and
//   2. BillingService.handleEvent accepts each fixture without throwing and
//      writes the expected mirror state.
//
// This is the first line of defense against fixture drift — if Stripe
// changes a payload shape and we update one fixture but not the others,
// this test should fail loudly at CI time rather than at replay time.

const FIXTURE_DIR = join(__dirname, 'fixtures', 'stripe');

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function makePrismaStub() {
  const subscriptions: any[] = [];
  const invoices: any[] = [];
  const failures: any[] = [];
  const processed: any[] = [];
  const profiles: any[] = [
    { user_id: 'coach-A', stripe_customer_id: 'cus_test_A' },
  ];

  const stub: any = {
    _subscriptions: subscriptions,
    _invoices: invoices,
    _failures: failures,
    _processed: processed,
    coachProfile: {
      findFirst: jest.fn(async ({ where }: any) =>
        profiles.find((p) =>
          Object.entries(where).every(([k, v]) => (p as any)[k] === v),
        ) ?? null,
      ),
    },
    stripeProcessedEvent: {
      findUnique: jest.fn(async ({ where }: any) =>
        processed.find((e) => e.stripe_event_id === where.stripe_event_id) ??
        null,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (
          processed.find((e) => e.stripe_event_id === data.stripe_event_id)
        ) {
          const err: any = new Error(
            'Unique constraint failed on stripe_event_id',
          );
          err.code = 'P2002';
          throw err;
        }
        processed.push(data);
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
      findUnique: jest.fn(async ({ where }: any) =>
        subscriptions.find((s) => s.coach_id === where.coach_id) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = subscriptions.find(
          (s) => s.coach_id === where.coach_id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { ...create };
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
              if (
                typeof v === 'object' &&
                v !== null &&
                'increment' in (v as any)
              ) {
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
        const existing = invoices.find(
          (i) => i.stripe_invoice_id === where.stripe_invoice_id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { ...create };
        invoices.push(row);
        return { ...row };
      }),
    },
    paymentFailure: {
      create: jest.fn(async ({ data }: any) => {
        failures.push(data);
        return data;
      }),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(stub)),
  };
  return stub;
}

describe('Stripe webhook fixtures', () => {
  const fixtureNames = readdirSync(FIXTURE_DIR).filter((f) =>
    f.endsWith('.json'),
  );

  it('discovers all six required fixtures (subscription create/update/delete, invoice paid/failed, customer.updated)', () => {
    expect(fixtureNames.sort()).toEqual(
      [
        'customer.updated.json',
        'invoice.paid.json',
        'invoice.payment_failed.json',
        'subscription.created.json',
        'subscription.deleted.json',
        'subscription.updated.json',
      ].sort(),
    );
  });

  describe.each(fixtureNames)('%s', (name) => {
    it('signs and verifies cleanly with a local secret', () => {
      const payload = JSON.stringify(loadFixture(name));
      const secret = 'whsec_local_smoke';
      const header = signStripePayload({ payload, secret });
      expect(() =>
        verifyStripeSignature({
          payload,
          signatureHeader: header,
          secret,
        }),
      ).not.toThrow();
    });

    it('is accepted by BillingService.handleEvent', async () => {
      const prisma = makePrismaStub();
      const svc = new BillingService(prisma as any, { capture: jest.fn(), identify: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
      const fixture = loadFixture(name);
      // Some events (subscription.deleted, customer.updated) mutate an
      // existing CoachSubscription row in place — seed one so the handler
      // has something to update. The seed mirrors what
      // customer.subscription.created would have written.
      if (
        fixture.type === 'customer.subscription.deleted' ||
        fixture.type === 'customer.updated' ||
        fixture.type === 'invoice.paid' ||
        fixture.type === 'invoice.payment_failed'
      ) {
        prisma._subscriptions.push({
          coach_id: 'coach-A',
          stripe_customer_id: 'cus_test_A',
          stripe_subscription_id: 'sub_test_1',
          status: 'active',
          last_payment_failed_at: null,
          failed_payments_this_month: 0,
        });
      }
      const result = await svc.handleEvent(fixture);
      expect(result.processed).toBe(true);
      // Every fixture must record an idempotency row.
      expect(prisma._processed).toHaveLength(1);
      expect(prisma._processed[0].stripe_event_id).toBe(fixture.id);
    });
  });

  it('subscription.updated mutates an existing row in place', async () => {
    const prisma = makePrismaStub();
    const svc = new BillingService(prisma as any, { capture: jest.fn(), identify: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
    await svc.handleEvent(loadFixture('subscription.created.json'));
    expect(prisma._subscriptions[0].status).toBe('active');
    await svc.handleEvent(loadFixture('subscription.updated.json'));
    expect(prisma._subscriptions).toHaveLength(1);
    expect(prisma._subscriptions[0].status).toBe('past_due');
  });

  it('customer.updated propagates billing_email and card_last4', async () => {
    const prisma = makePrismaStub();
    const svc = new BillingService(prisma as any, { capture: jest.fn(), identify: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
    await svc.handleEvent(loadFixture('subscription.created.json'));
    await svc.handleEvent(loadFixture('customer.updated.json'));
    expect(prisma._subscriptions[0].billing_email).toBe(
      'coach-a@example.com',
    );
    expect(prisma._subscriptions[0].card_last4).toBe('4242');
  });

  it('replaying the full sequence end-to-end is idempotent on the second pass', async () => {
    const prisma = makePrismaStub();
    const svc = new BillingService(prisma as any, { capture: jest.fn(), identify: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any);
    const ordered = [
      'subscription.created.json',
      'subscription.updated.json',
      'invoice.payment_failed.json',
      'invoice.paid.json',
      'customer.updated.json',
      'subscription.deleted.json',
    ];
    for (const name of ordered) await svc.handleEvent(loadFixture(name));
    const firstPassProcessed = prisma._processed.length;
    // Replay — every event id is now in StripeProcessedEvent and must
    // short-circuit. No extra rows in any mirror table.
    for (const name of ordered) {
      const r = await svc.handleEvent(loadFixture(name));
      expect(r.processed).toBe(false);
      expect(r.alreadyProcessed).toBe(true);
    }
    expect(prisma._processed.length).toBe(firstPassProcessed);
  });
});
