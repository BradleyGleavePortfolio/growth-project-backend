import { ServiceUnavailableException } from '@nestjs/common';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
  retrievePaymentIntent = jest.fn();
}

// PR-18 B1 R3 P1 — minimal PurchaseSplitHandlerService stub that records
// every onChargeSucceeded invocation so tests can assert the split posting
// is DEFERRED to post-commit (never called inline while an outer tx / the
// CoachPackage FOR UPDATE lock is held).
function makeSplitsStub() {
  return {
    onChargeSucceeded: jest.fn(async () => ({
      charge_id: null,
      ledger_entries: 0,
      transfer_enqueued: false,
    })),
  };
}

// Where-clause match of the in-memory stub: equality, `null`, and the
// `{ in: [...] }` / `{ notIn: [...] }` status matches the handler uses
// (B-661-1, B-661-3, C-661-7).
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null;
    if (v && typeof v === 'object' && 'in' in v) {
      return (v as { in: unknown[] }).in.includes(row[k]);
    }
    if (v && typeof v === 'object' && 'notIn' in v) {
      return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
    }
    return row[k] === v;
  });
}

function makePrisma() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const customers: any[] = [];
  const prisma: any = {
    _packages: packages,
    _purchases: purchases,
    _customers: customers,
    // B1 (PR-18) — package-row lock taken before an entitlement activation.
    // The stub records every locked package id so tests can assert the
    // activation paths serialize on the CoachPackage row.
    _lockedPackageIds: [] as string[],
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join('?');
      // B-661-3 / B-661-8 round 5: purchase row locks and row versions. The
      // stub's `_xmin` stands in for PostgreSQL's xmin: every write bumps it.
      if (sql.includes('"ClientPurchase"')) {
        if (sql.includes('stripe_payment_intent_id')) {
          return purchases
            .filter((p) => p.stripe_payment_intent_id === vals[0])
            .map((p) => ({ id: p.id }));
        }
        const row = purchases.find((p) => p.id === vals[0]);
        return row ? [{ status: row.status, row_version: String(row._xmin ?? 0) }] : [];
      }
      // Mirror Prisma's tagged-template signature; capture the locked id.
      if (vals.length) prisma._lockedPackageIds.push(vals[0]);
      return [];
    }),
    // Interactive $transaction — invoke the callback with the stub itself
    // acting as the transaction client (all reads/writes already operate on
    // the shared in-memory arrays).
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) => {
          if (where.stripe_checkout_session_id)
            return p.stripe_checkout_session_id === where.stripe_checkout_session_id;
          if (where.stripe_subscription_id)
            return p.stripe_subscription_id === where.stripe_subscription_id;
          if (where.id) return p.id === where.id;
          return false;
        }) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: any) => purchases.find((p) => matchesWhere(p, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => purchases.filter((p) => matchesWhere(p, where))),
      // B-661-8 round 5: like Prisma, a where with more than the id is a
      // compare-and-set; no matching row is P2025.
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => matchesWhere(p, where));
        if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        Object.assign(row, data, { updated_at: new Date(), _xmin: (row._xmin ?? 0) + 1 });
        return { ...row };
      }),
      // B-661-3: a compare-and-set write. Like Postgres, it re-checks the
      // whole predicate (status included) at write time and reports how many
      // rows it changed.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = purchases.filter((p) => matchesWhere(p, where));
        for (const row of rows) {
          Object.assign(row, data, { updated_at: new Date(), _xmin: (row._xmin ?? 0) + 1 });
        }
        return { count: rows.length };
      }),
    },
    // B-661-3 round 5: no purchase in this suite was activated by a fanout.
    purchaseFanout: { findUnique: jest.fn(async () => null) },
    connectCustomer: {
      findUnique: jest.fn(async ({ where }: any) =>
        customers.find((c) => c.stripe_customer_id === where.stripe_customer_id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = customers.find(
          (c) => c.stripe_customer_id === where.stripe_customer_id,
        );
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
  };
  return prisma;
}

function makeHandler() {
  const prisma = makePrisma();
  const stripe = new StripeStub();
  const svc = new CheckoutWebhookHandlerService(prisma as any, stripe as any);
  return { svc, prisma, stripe };
}

// Variant that wires a splits stub so we can assert deferral behavior.
function makeHandlerWithSplits() {
  const prisma = makePrisma();
  const stripe = new StripeStub();
  const splits = makeSplitsStub();
  const svc = new CheckoutWebhookHandlerService(
    prisma as any,
    stripe as any,
    splits as any,
  );
  return { svc, prisma, stripe, splits };
}

describe('CheckoutWebhookHandlerService', () => {
  describe('checkout.session.completed', () => {
    it('flips one_time purchase to paid + entitlement_active=true with computed expiry', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({
        id: 'pkg-1',
        coach_id: 'coach-1',
        name: 'Transform 12',
        billing_type: 'one_time',
        duration_periods: 12,
      });
      const startedAt = new Date('2026-01-01T00:00:00Z');
      prisma._purchases.push({
        id: 'cp-1',
        package_id: 'pkg-1',
        stripe_checkout_session_id: 'cs_abc',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'one_time',
        created_at: startedAt,
      });
      const result = await svc.handle({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_abc',
            mode: 'payment',
            payment_intent: 'pi_test',
            customer: 'cus_test',
          },
        },
      });
      expect(result.claimed).toBe(true);
      expect(prisma._purchases[0].status).toBe('paid');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      // 12 weeks ≈ 12 * 7 * 86400 * 1000 ms = 7,257,600,000 ms after startedAt
      const expected = new Date(
        startedAt.getTime() + 12 * 7 * 86400 * 1000,
      ).getTime();
      expect(prisma._purchases[0].access_expires_at.getTime()).toBe(expected);
    });

    it('flips recurring purchase to active + entitlement_active=true', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({
        id: 'pkg-2',
        coach_id: 'coach-1',
        billing_type: 'recurring',
      });
      prisma._purchases.push({
        id: 'cp-2',
        package_id: 'pkg-2',
        stripe_checkout_session_id: 'cs_sub',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'recurring',
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_sub',
            mode: 'subscription',
            subscription: 'sub_test',
            customer: 'cus_test',
          },
        },
      });
      expect(prisma._purchases[0].status).toBe('active');
      expect(prisma._purchases[0].stripe_subscription_id).toBe('sub_test');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('returns claimed=false for unknown session', async () => {
      const { svc } = makeHandler();
      const result = await svc.handle({
        id: 'evt_x',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_unknown' } },
      });
      expect(result.claimed).toBe(false);
    });
  });

  describe('checkout.session.expired', () => {
    it('expires a pending purchase', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp-1',
        package_id: 'pkg-1',
        stripe_checkout_session_id: 'cs_pending',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      const result = await svc.handle({
        id: 'evt_exp',
        type: 'checkout.session.expired',
        data: { object: { id: 'cs_pending' } },
      });
      expect(result.claimed).toBe(true);
      expect(prisma._purchases[0].status).toBe('expired');
    });

    it('does NOT override a paid purchase', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp-2',
        package_id: 'pkg-1',
        stripe_checkout_session_id: 'cs_paid',
        status: 'paid',
        entitlement_active: true,
      });
      await svc.handle({
        id: 'evt_late_exp',
        type: 'checkout.session.expired',
        data: { object: { id: 'cs_paid' } },
      });
      expect(prisma._purchases[0].status).toBe('paid');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });
  });

  describe('customer.subscription.updated', () => {
    it('mirrors status, current_period_end, cancel_at_period_end', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({
        id: 'pkg-2',
        billing_type: 'recurring',
      });
      prisma._purchases.push({
        id: 'cp-2',
        package_id: 'pkg-2',
        stripe_checkout_session_id: 'cs_sub',
        stripe_subscription_id: 'sub_test',
        status: 'active',
        entitlement_active: true,
        created_at: new Date(),
      });
      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
      await svc.handle({
        id: 'evt_sub_update',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test',
            status: 'active',
            current_period_end: periodEnd,
            cancel_at_period_end: true,
          },
        },
      });
      expect(prisma._purchases[0].cancel_at_period_end).toBe(true);
      expect(prisma._purchases[0].current_period_end.getTime()).toBe(
        periodEnd * 1000,
      );
      // access_expires_at has 24h padding past current_period_end
      expect(prisma._purchases[0].access_expires_at.getTime()).toBe(
        periodEnd * 1000 + 86400_000,
      );
    });

    it('flips entitlement_active=false for canceled status', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_subscription_id: 'sub_x',
        status: 'active',
        entitlement_active: true,
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_x', status: 'canceled' } },
      });
      expect(prisma._purchases[0].status).toBe('canceled');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
    });

    it('keeps entitlement_active=true for past_due (grace period)', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_subscription_id: 'sub_x',
        status: 'active',
        entitlement_active: true,
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_x', status: 'past_due' } },
      });
      expect(prisma._purchases[0].status).toBe('past_due');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('marks status=canceled and entitlement_active=false', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_subscription_id: 'sub_done',
        status: 'active',
        entitlement_active: true,
      });
      await svc.handle({
        id: 'evt',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_done' } },
      });
      expect(prisma._purchases[0].status).toBe('canceled');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
      expect(prisma._purchases[0].canceled_at).toBeTruthy();
    });
  });

  describe('payment_intent.payment_failed', () => {
    it('flips a matching pending purchase to payment_failed', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_payment_intent_id: 'pi_bad',
        status: 'pending',
        entitlement_active: false,
      });
      await svc.handle({
        id: 'evt',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_bad',
            last_payment_error: { message: 'card declined' },
          },
        },
      });
      expect(prisma._purchases[0].status).toBe('payment_failed');
      expect(prisma._purchases[0].last_error).toBe('card declined');
    });

    it('falls back to metadata lookup when PI is not yet on the row', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp',
        client_user_id: 'c1',
        package_id: 'pkg-1',
        status: 'pending',
        entitlement_active: false,
        stripe_payment_intent_id: null,
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_orphan',
            metadata: {
              tgp_package_id: 'pkg-1',
              tgp_client_user_id: 'c1',
            },
            last_payment_error: { message: 'insufficient_funds' },
          },
        },
      });
      expect(prisma._purchases[0].status).toBe('payment_failed');
      expect(prisma._purchases[0].stripe_payment_intent_id).toBe('pi_orphan');
    });
  });

  describe('customer.updated — saved card mirror', () => {
    it('writes default card brand/last4 to ConnectCustomer', async () => {
      const { svc, prisma } = makeHandler();
      prisma._customers.push({
        id: 'cc-1',
        client_user_id: 'c1',
        stripe_customer_id: 'cus_x',
      });
      await svc.handle({
        id: 'evt',
        type: 'customer.updated',
        data: {
          object: {
            id: 'cus_x',
            invoice_settings: {
              default_payment_method: {
                id: 'pm_test',
                card: {
                  brand: 'visa',
                  last4: '4242',
                  exp_month: 4,
                  exp_year: 2030,
                },
              },
            },
          },
        },
      });
      expect(prisma._customers[0].default_card_brand).toBe('visa');
      expect(prisma._customers[0].default_card_last4).toBe('4242');
      expect(prisma._customers[0].default_payment_method_id).toBe('pm_test');
    });

    it('resolves string default_payment_method via Stripe API', async () => {
      const { svc, prisma, stripe } = makeHandler();
      prisma._customers.push({
        id: 'cc-1',
        client_user_id: 'c1',
        stripe_customer_id: 'cus_y',
      });
      stripe.retrievePaymentMethod.mockResolvedValueOnce({
        id: 'pm_remote',
        card: {
          brand: 'mastercard',
          last4: '5555',
          exp_month: 1,
          exp_year: 2031,
        },
      });
      await svc.handle({
        id: 'evt',
        type: 'customer.updated',
        data: {
          object: {
            id: 'cus_y',
            invoice_settings: { default_payment_method: 'pm_remote' },
          },
        },
      });
      expect(stripe.retrievePaymentMethod).toHaveBeenCalledWith('pm_remote');
      expect(prisma._customers[0].default_card_brand).toBe('mastercard');
      expect(prisma._customers[0].default_card_last4).toBe('5555');
    });
  });

  describe('invoice.paid', () => {
    it('refreshes subscription state on renewal', async () => {
      const { svc, prisma, stripe } = makeHandler();
      prisma._packages.push({ id: 'pkg', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_subscription_id: 'sub_renew',
        status: 'past_due',
        entitlement_active: true,
        created_at: new Date(),
      });
      const newEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
      stripe.retrieveSubscription.mockResolvedValueOnce({
        id: 'sub_renew',
        status: 'active',
        current_period_end: newEnd,
      });
      await svc.handle({
        id: 'evt',
        type: 'invoice.paid',
        data: {
          object: {
            subscription: 'sub_renew',
            status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          },
        },
      });
      expect(prisma._purchases[0].status).toBe('active');
      expect(prisma._purchases[0].last_error).toBeNull();
    });
  });

  describe('invoice.payment_failed', () => {
    it('moves purchase to past_due and records last_error', async () => {
      const { svc, prisma } = makeHandler();
      prisma._purchases.push({
        id: 'cp',
        package_id: 'pkg',
        stripe_subscription_id: 'sub_fail',
        status: 'active',
        entitlement_active: true,
      });
      await svc.handle({
        id: 'evt',
        type: 'invoice.payment_failed',
        data: {
          object: {
            subscription: 'sub_fail',
            last_payment_error: { message: 'card_declined' },
          },
        },
      });
      expect(prisma._purchases[0].status).toBe('past_due');
      expect(prisma._purchases[0].last_error).toBe('card_declined');
      // Entitlement is retained during past_due until Stripe deletes the sub.
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });
  });

  // B1 (PR-18) — pricing-lock serialization. Every webhook path that flips
  // a recurring ClientPurchase to entitlement_active=true must take the
  // SAME `CoachPackage ... FOR UPDATE` row lock that PackagesService.update()
  // takes before it counts active recurring buyers. Otherwise an activation
  // could commit without touching the package row and the pricing guard's
  // count would miss it, letting a price edit slip past during a race.
  describe('B1 pricing-lock serialization on activation', () => {
    it('checkout.session.completed (recurring) locks the package row BEFORE activating', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg-2', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-2',
        package_id: 'pkg-2',
        stripe_checkout_session_id: 'cs_sub',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'recurring',
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt_lock_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_sub',
            mode: 'subscription',
            subscription: 'sub_lock',
            customer: 'cus_x',
          },
        },
      });
      // The package row was locked for this activation.
      expect(prisma._lockedPackageIds).toContain('pkg-2');
      // The lock was taken BEFORE the entitlement flip committed: the
      // FOR UPDATE $queryRaw fired at least once before the purchase
      // update set entitlement_active=true.
      const lockCall = prisma.$queryRaw.mock.invocationCallOrder[0];
      const updateCall = prisma.clientPurchase.update.mock.invocationCallOrder[0];
      expect(lockCall).toBeLessThan(updateCall);
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('checkout.session.completed (recurring) locks on the OUTER tx when one is provided', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg-7', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-7',
        package_id: 'pkg-7',
        stripe_checkout_session_id: 'cs_tx',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'recurring',
        created_at: new Date(),
      });
      // Outer tx = the same stub (mirrors BillingService threading its tx).
      await svc.handle(
        {
          id: 'evt_lock_tx',
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_tx',
              mode: 'subscription',
              subscription: 'sub_tx',
              customer: 'cus_y',
            },
          },
        },
        prisma as any,
      );
      expect(prisma._lockedPackageIds).toContain('pkg-7');
      // With an outer tx supplied we lock on it directly and do NOT open a
      // nested $transaction for the activation.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('customer.subscription.updated locks the package row before flipping entitlement', async () => {
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg-3', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-3',
        package_id: 'pkg-3',
        stripe_subscription_id: 'sub_up',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      await svc.handle({
        id: 'evt_lock_2',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_up', status: 'active' } },
      });
      expect(prisma._lockedPackageIds).toContain('pkg-3');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('customer.subscription.updated locks on the OUTER tx (no nested $transaction) when one is provided', async () => {
      // PR-18 B1 R2 P1 — the dispatcher must thread the outer tx into
      // applySubscriptionUpdated so the lock + entitlement flip commit with
      // the StripeProcessedEvent dedup row, NOT via a nested $transaction.
      const { svc, prisma } = makeHandler();
      prisma._packages.push({ id: 'pkg-5', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-5',
        package_id: 'pkg-5',
        stripe_subscription_id: 'sub_up_tx',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      await svc.handle(
        {
          id: 'evt_sub_tx',
          type: 'customer.subscription.updated',
          data: { object: { id: 'sub_up_tx', status: 'active' } },
        },
        prisma as any,
      );
      expect(prisma._lockedPackageIds).toContain('pkg-5');
      // Lock + write ran on the supplied outer tx; no nested tx opened.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('invoice.paid locks on the OUTER tx (no nested $transaction, no in-tx Stripe HTTP) when prefetched', async () => {
      // PR-18 B1 R2 P1 — when BillingService threads its outer tx it ALSO
      // pre-resolves the subscription via prefetchForOuterTx (out-of-tx) and
      // passes it here, so the lock + activation run on the outer tx with NO
      // Stripe round-trip held inside the transaction.
      const { svc, prisma, stripe } = makeHandler();
      prisma._packages.push({ id: 'pkg-6', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-6',
        package_id: 'pkg-6',
        stripe_subscription_id: 'sub_inv_tx',
        status: 'past_due',
        entitlement_active: false,
        created_at: new Date(),
      });
      const prefetchedSub = {
        id: 'sub_inv_tx',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      };
      await svc.handle(
        {
          id: 'evt_inv_tx',
          type: 'invoice.paid',
          data: { object: { subscription: 'sub_inv_tx' } },
        },
        prisma as any,
        { invoiceSubscription: prefetchedSub as any },
      );
      expect(prisma._lockedPackageIds).toContain('pkg-6');
      // Lock + write ran on the supplied outer tx; no nested tx opened.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // No Stripe HTTP inside the tx — the subscription came from prefetch.
      expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
      expect(prisma._purchases[0].status).toBe('active');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });

    it('invoice.paid skips the resync (no in-tx Stripe HTTP) when an outer tx is held without a prefetch', async () => {
      // PR-18 B1 R2 P1 — defensive: if an outer tx is somehow held but no
      // prefetch was supplied, the handler must NOT perform Stripe HTTP
      // inside the transaction. It degrades by skipping the resync.
      const { svc, prisma, stripe } = makeHandler();
      prisma._packages.push({ id: 'pkg-8', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-8',
        package_id: 'pkg-8',
        stripe_subscription_id: 'sub_inv_skip',
        status: 'past_due',
        entitlement_active: true,
        created_at: new Date(),
      });
      const result = await svc.handle(
        {
          id: 'evt_inv_skip',
          type: 'invoice.paid',
          data: { object: { subscription: 'sub_inv_skip' } },
        },
        prisma as any,
      );
      expect(result.claimed).toBe(true);
      // No Stripe HTTP and no nested tx while the outer tx is held.
      expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('prefetchForOuterTx resolves the subscription out-of-tx for invoice.paid', async () => {
      // PR-18 B1 R2 P1 — the prefetch hook (called by BillingService BEFORE
      // opening its tx) returns the subscription so the in-tx path never
      // touches Stripe.
      const { svc, prisma, stripe } = makeHandler();
      prisma._purchases.push({
        id: 'cp-pf',
        package_id: 'pkg-pf',
        stripe_subscription_id: 'sub_pf',
        status: 'past_due',
        entitlement_active: false,
        created_at: new Date(),
      });
      const sub = { id: 'sub_pf', status: 'active', current_period_end: 123 };
      stripe.retrieveSubscription.mockResolvedValueOnce(sub);
      const pre = await svc.prefetchForOuterTx({
        id: 'evt_pf',
        type: 'invoice.paid',
        data: { object: { subscription: 'sub_pf' } },
      });
      expect(stripe.retrieveSubscription).toHaveBeenCalledWith('sub_pf');
      expect(pre.invoiceSubscription).toEqual(sub);
      // No DB transaction opened by the prefetch.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('prefetchForOuterTx is a no-op for non-invoice events and unknown subs', async () => {
      const { svc, stripe } = makeHandler();
      const a = await svc.prefetchForOuterTx({
        id: 'evt_a',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_x' } },
      });
      expect(a).toEqual({});
      const b = await svc.prefetchForOuterTx({
        id: 'evt_b',
        type: 'invoice.paid',
        data: { object: { subscription: 'sub_unknown' } },
      });
      expect(b).toEqual({});
      expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    });

    it('invoice.paid locks the package row on renewal re-activation', async () => {
      const { svc, prisma, stripe } = makeHandler();
      prisma._packages.push({ id: 'pkg-4', billing_type: 'recurring' });
      prisma._purchases.push({
        id: 'cp-4',
        package_id: 'pkg-4',
        stripe_subscription_id: 'sub_rn',
        status: 'past_due',
        entitlement_active: false,
        created_at: new Date(),
      });
      stripe.retrieveSubscription.mockResolvedValueOnce({
        id: 'sub_rn',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      });
      await svc.handle({
        id: 'evt_lock_3',
        type: 'invoice.paid',
        data: { object: { subscription: 'sub_rn' } },
      });
      expect(prisma._lockedPackageIds).toContain('pkg-4');
      expect(prisma._purchases[0].entitlement_active).toBe(true);
    });
  });

  // PR-18 B1 R3 P1 — head-coach split posting must never run inline while an
  // outer $transaction (and the CoachPackage FOR UPDATE lock) is held, because
  // onChargeSucceeded can synchronously call Stripe (retrievePaymentIntent +
  // transfers.attempt → createTransfer). When an outer tx is threaded the
  // handler DEFERS the posting to post-commit and returns a descriptor; when
  // no tx is held it runs inline as before.
  describe('B1 R3 P1 — split posting deferred outside the outer tx', () => {
    it('checkout.session.completed DEFERS split posting (no inline onChargeSucceeded) when an outer tx is held', async () => {
      const { svc, prisma, splits } = makeHandlerWithSplits();
      prisma._packages.push({ id: 'pkg-d1', billing_type: 'one_time' });
      prisma._purchases.push({
        id: 'cp-d1',
        package_id: 'pkg-d1',
        stripe_checkout_session_id: 'cs_d1',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'one_time',
        created_at: new Date(),
      });
      const result = await svc.handle(
        {
          id: 'evt_d1',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_d1', mode: 'payment', payment_intent: 'pi_d1' } },
        },
        prisma as any,
        { chargeIdByPurchaseId: { 'cp-d1': 'ch_d1' } },
      );
      // Entitlement still activated inside the tx.
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      // Split posting was NOT run inline (no Stripe HTTP inside the tx).
      expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
      // Instead a deferred descriptor carrying the pre-resolved charge id.
      expect(result.deferredSplit).toBeDefined();
      expect(result.deferredSplit!.charge_id).toBe('ch_d1');
      expect(result.deferredSplit!.purchase.id).toBe('cp-d1');
    });

    it('checkout.session.completed runs split posting INLINE when no outer tx is held (legacy path)', async () => {
      const { svc, prisma, splits } = makeHandlerWithSplits();
      prisma._packages.push({ id: 'pkg-d2', billing_type: 'one_time' });
      prisma._purchases.push({
        id: 'cp-d2',
        package_id: 'pkg-d2',
        stripe_checkout_session_id: 'cs_d2',
        status: 'pending',
        entitlement_active: false,
        billing_type: 'one_time',
        created_at: new Date(),
      });
      const result = await svc.handle({
        id: 'evt_d2',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_d2', mode: 'payment', payment_intent: 'pi_d2' } },
      });
      // No outer tx → inline posting preserved (legacy/sweeper/test path).
      expect(splits.onChargeSucceeded).toHaveBeenCalledTimes(1);
      expect(result.deferredSplit).toBeUndefined();
    });

    it('payment_intent.succeeded DEFERS split posting under an outer tx', async () => {
      const { svc, prisma, splits } = makeHandlerWithSplits();
      prisma._packages.push({ id: 'pkg-d3', billing_type: 'one_time' });
      prisma._purchases.push({
        id: 'cp-d3',
        package_id: 'pkg-d3',
        stripe_payment_intent_id: 'pi_d3',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      const result = await svc.handle(
        {
          id: 'evt_d3',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_d3' } },
        },
        prisma as any,
        { chargeIdByPurchaseId: { 'cp-d3': 'ch_d3' } },
      );
      expect(prisma._purchases[0].entitlement_active).toBe(true);
      expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
      expect(result.deferredSplit!.charge_id).toBe('ch_d3');
    });

    it('runDeferredSplit posts the split with the pre-resolved charge id', async () => {
      const { svc, splits } = makeHandlerWithSplits();
      await svc.runDeferredSplit({
        purchase: { id: 'cp-d4' } as any,
        charge_id: 'ch_d4',
        invoice_amount_cents: 4200,
      });
      expect(splits.onChargeSucceeded).toHaveBeenCalledWith({
        purchase: { id: 'cp-d4' },
        invoice_amount_cents: 4200,
        invoice_charge_id: 'ch_d4',
      });
    });

    it('prefetchForOuterTx resolves the charge id out-of-tx for checkout.session.completed', async () => {
      const { svc, prisma, stripe } = makeHandlerWithSplits();
      prisma._purchases.push({
        id: 'cp-d5',
        package_id: 'pkg-d5',
        stripe_checkout_session_id: 'cs_d5',
        stripe_payment_intent_id: 'pi_d5',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      stripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_d5',
        latest_charge: 'ch_d5',
      });
      const pre = await svc.prefetchForOuterTx({
        id: 'evt_d5',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_d5', payment_intent: 'pi_d5' } },
      });
      expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_d5');
      expect(pre.chargeIdByPurchaseId).toEqual({ 'cp-d5': 'ch_d5' });
      // The pre-resolution itself opens no DB transaction.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('prefetchForOuterTx prefers latest_charge from the PI event payload (no Stripe HTTP)', async () => {
      const { svc, prisma, stripe } = makeHandlerWithSplits();
      prisma._purchases.push({
        id: 'cp-d6',
        package_id: 'pkg-d6',
        stripe_payment_intent_id: 'pi_d6',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date(),
      });
      const pre = await svc.prefetchForOuterTx({
        id: 'evt_d6',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_d6', latest_charge: 'ch_d6' } },
      });
      expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(pre.chargeIdByPurchaseId).toEqual({ 'cp-d6': 'ch_d6' });
    });
  });

  it('returns claimed=false for unhandled event type', async () => {
    const { svc } = makeHandler();
    const result = await svc.handle({
      id: 'evt',
      type: 'random.thing',
      data: { object: {} },
    });
    expect(result.claimed).toBe(false);
  });
});

// B-SECRETS-3 (#646 C-646-2 Opus): a finished PaymentSheet payment's cached
// client credentials are erased at rest; a failed one keeps them so the
// client can retry the same PaymentIntent.
type HandleTx = Parameters<CheckoutWebhookHandlerService['handle']>[1];
function txFixture(prisma: object): HandleTx {
  return prisma as HandleTx;
}

describe('B-SECRETS-3 cached payment credentials are cleared on terminal states', () => {
  const secrets = {
    stripe_client_secret: 'pi_sec_secret_canary',
    stripe_ephemeral_key: 'ek_test_canary',
  };

  it('payment_intent.succeeded erases the client secret and the ephemeral key', async () => {
    const { svc, prisma } = makeHandlerWithSplits();
    prisma._packages.push({ id: 'pkg-s1', billing_type: 'one_time' });
    prisma._purchases.push({
      id: 'cp-s1',
      package_id: 'pkg-s1',
      stripe_payment_intent_id: 'pi_s1',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
      ...secrets,
    });
    await svc.handle(
      { id: 'evt_s1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_s1' } } },
      txFixture(prisma),
      { chargeIdByPurchaseId: { 'cp-s1': 'ch_s1' } },
    );
    expect(prisma._purchases[0].status).toBe('paid');
    expect(prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(prisma._purchases[0].stripe_ephemeral_key).toBeNull();
  });

  it('checkout.session.expired erases them too', async () => {
    const { svc, prisma } = makeHandler();
    prisma._purchases.push({
      id: 'cp-s2',
      stripe_checkout_session_id: 'cs_s2',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
      ...secrets,
    });
    await svc.handle({
      id: 'evt_s2',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_s2' } },
    });
    expect(prisma._purchases[0].status).toBe('expired');
    expect(prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(prisma._purchases[0].stripe_ephemeral_key).toBeNull();
  });
});

// B-661-1 (Opus, round 2): a declined first attempt flips the row to
// payment_failed while the PaymentIntent stays payable; the client's in-sheet
// retry of the SAME PaymentIntent succeeds. That success must be claimed.
describe('B-661-1 decline, then a successful retry of the same PaymentIntent', () => {
  const secrets = {
    stripe_client_secret: 'pi_r1_secret_canary',
    stripe_ephemeral_key: 'ek_test_canary',
  };
  const succeeded = {
    id: 'evt_r1b',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_r1', latest_charge: 'ch_r1' } },
  };

  it('ends paid and entitled, erases the credentials and defers the split with the charge id', async () => {
    const { svc, prisma, splits } = makeHandlerWithSplits();
    prisma._packages.push({ id: 'pkg-r1', billing_type: 'one_time' });
    prisma._purchases.push({
      id: 'cp-r1',
      package_id: 'pkg-r1',
      // A PaymentSheet purchase: its session id is the PaymentIntent id.
      stripe_checkout_session_id: 'pi_r1',
      stripe_payment_intent_id: 'pi_r1',
      status: 'pending',
      entitlement_active: false,
      created_at: new Date(),
      ...secrets,
    });
    await svc.handle(
      {
        id: 'evt_r1a',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_r1', last_payment_error: { message: 'card_declined' } } },
      },
      txFixture(prisma),
    );
    expect(prisma._purchases[0].status).toBe('payment_failed');
    // Kept for the retry of the same PaymentIntent.
    expect(prisma._purchases[0].stripe_client_secret).toBe(secrets.stripe_client_secret);

    const prefetched = await svc.prefetchForOuterTx(succeeded);
    expect(prefetched.chargeIdByPurchaseId).toEqual({ 'cp-r1': 'ch_r1' });
    const result = await svc.handle(succeeded, txFixture(prisma), prefetched);

    expect(result.claimed).toBe(true);
    expect(prisma._purchases[0].status).toBe('paid');
    expect(prisma._purchases[0].entitlement_active).toBe(true);
    expect(prisma._purchases[0].last_error).toBeNull();
    expect(prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(prisma._purchases[0].stripe_ephemeral_key).toBeNull();
    expect(splits.onChargeSucceeded).not.toHaveBeenCalled();
    expect(result.deferredSplit!.charge_id).toBe('ch_r1');
    expect(result.deferredSplit!.purchase.id).toBe('cp-r1');
  });

  it('(control) a paid row is not claimed again by a redelivered success', async () => {
    const { svc, prisma } = makeHandlerWithSplits();
    prisma._packages.push({ id: 'pkg-r2', billing_type: 'one_time' });
    prisma._purchases.push({
      id: 'cp-r2',
      package_id: 'pkg-r2',
      stripe_payment_intent_id: 'pi_r1',
      status: 'paid',
      entitlement_active: true,
      created_at: new Date(),
    });
    const result = await svc.handle(succeeded, txFixture(prisma), {});
    expect(result.claimed).toBe(false);
  });
});

// B-661-3 (Sol, round 3): payment_intent.payment_failed matched its purchase by
// PaymentIntent id with no status fence, so a decline delivered late (after a
// successful retry of the same PaymentIntent) flipped the paid purchase to
// payment_failed and dropped access. A decline now only writes a purchase that
// may still fail; a settled purchase ends access only when Stripe says the
// PaymentIntent did not complete.
describe('B-661-3 a late-delivered earlier decline never revokes a successful retry', () => {
  const secrets = {
    stripe_client_secret: 'pi_r3_secret_canary',
    stripe_ephemeral_key: 'ek_test_canary',
  };
  const declined = (eventId: string, piId = 'pi_r3') => ({
    id: eventId,
    type: 'payment_intent.payment_failed',
    data: { object: { id: piId, last_payment_error: { message: 'card_declined' } } },
  });
  const succeeded = {
    id: 'evt_r3_ok',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_r3', latest_charge: 'ch_r3' } },
  };

  function seedPending(prisma: ReturnType<typeof makePrisma>) {
    prisma._packages.push({ id: 'pkg-r3', billing_type: 'one_time' });
    prisma._purchases.push({
      id: 'cp-r3',
      package_id: 'pkg-r3',
      stripe_checkout_session_id: 'pi_r3',
      stripe_payment_intent_id: 'pi_r3',
      status: 'pending',
      entitlement_active: false,
      last_error: null,
      created_at: new Date(),
      ...secrets,
    });
  }

  // BillingService.handleEvent order: prefetch out of the tx, then handle
  // inside the webhook tx.
  async function deliver(
    svc: CheckoutWebhookHandlerService,
    prisma: ReturnType<typeof makePrisma>,
    event: { id: string; type: string; data: { object: Record<string, unknown> } },
  ) {
    const prefetched = await svc.prefetchForOuterTx(event);
    return svc.handle(event, txFixture(prisma), prefetched);
  }

  function expectPaidAndEntitled(prisma: ReturnType<typeof makePrisma>) {
    expect(prisma._purchases[0].status).toBe('paid');
    expect(prisma._purchases[0].entitlement_active).toBe(true);
    expect(prisma._purchases[0].last_error).toBeNull();
    expect(prisma._purchases[0].stripe_client_secret).toBeNull();
    expect(prisma._purchases[0].stripe_ephemeral_key).toBeNull();
  }

  it('failed, then succeeded, then an earlier decline arrives late: the purchase stays paid and entitled', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);

    await deliver(svc, prisma, declined('evt_r3_decline_1'));
    expect(prisma._purchases[0].status).toBe('payment_failed');
    // A purchase that may still fail never needs Stripe to decide.
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();

    await deliver(svc, prisma, succeeded);
    expectPaidAndEntitled(prisma);

    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    const late = await deliver(svc, prisma, declined('evt_r3_decline_2'));

    expectPaidAndEntitled(prisma);
    expect(late.claimed).toBe(true);
    expect(late.reason).toBe('stale_failure');
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_r3');
  });

  it('the same late decline on the no-transaction path asks Stripe inline and stays paid', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    await svc.handle(succeeded, txFixture(prisma), { chargeIdByPurchaseId: { 'cp-r3': 'ch_r3' } });
    expectPaidAndEntitled(prisma);

    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    const late = await svc.handle(declined('evt_r3_decline_nt'));

    expectPaidAndEntitled(prisma);
    expect(late.reason).toBe('stale_failure');
  });

  it('Stripe cannot confirm the PaymentIntent status: the webhook transaction throws (Stripe redelivers) and the paid purchase is untouched', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    await svc.handle(succeeded, txFixture(prisma), { chargeIdByPurchaseId: { 'cp-r3': 'ch_r3' } });

    stripe.retrievePaymentIntent.mockRejectedValue(new Error('stripe_unavailable'));
    const event = declined('evt_r3_decline_unknown');
    const prefetched = await svc.prefetchForOuterTx(event);
    const callsBeforeTx = stripe.retrievePaymentIntent.mock.calls.length;

    await expect(svc.handle(event, txFixture(prisma), prefetched)).rejects.toThrow(
      ServiceUnavailableException,
    );
    // No Stripe HTTP inside the webhook transaction.
    expect(stripe.retrievePaymentIntent.mock.calls.length).toBe(callsBeforeTx);
    expectPaidAndEntitled(prisma);
  });

  it('a success that commits between the decline reading the purchase and writing it wins; the redelivered decline is a no-op', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    const event = declined('evt_r3_decline_race');
    // The decline's out-of-tx prefetch sees a purchase that may still fail.
    const prefetched = await svc.prefetchForOuterTx(event);

    const readPurchase = prisma.clientPurchase.findFirst.getMockImplementation();
    prisma.clientPurchase.findFirst.mockImplementationOnce(async (args: unknown) => {
      // The decline's in-tx read sees `pending` ...
      const snapshot = { ...(await readPurchase(args)) };
      // ... then the success of the same PaymentIntent commits before the
      // decline writes.
      await svc.handle(succeeded, txFixture(prisma), {
        chargeIdByPurchaseId: { 'cp-r3': 'ch_r3' },
      });
      return snapshot;
    });

    await expect(svc.handle(event, txFixture(prisma), prefetched)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(prisma);

    // Stripe redelivers the decline; the PaymentIntent succeeded.
    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    const redelivered = await deliver(svc, prisma, event);
    expect(redelivered.reason).toBe('stale_failure');
    expectPaidAndEntitled(prisma);
  });

  it('(control) an ordinary decline of a pending purchase is applied and keeps the credentials for the retry', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    const result = await deliver(svc, prisma, declined('evt_r3_decline_plain'));
    expect(result.claimed).toBe(true);
    expect(prisma._purchases[0].status).toBe('payment_failed');
    expect(prisma._purchases[0].entitlement_active).toBe(false);
    expect(prisma._purchases[0].last_error).toBe('card_declined');
    expect(prisma._purchases[0].stripe_client_secret).toBe(secrets.stripe_client_secret);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it.each(['requires_payment_method', 'canceled'])(
    '(control) a real failure after the purchase settled (Stripe says the PaymentIntent is %s) still ends access',
    async (piStatus) => {
      // e.g. a hosted checkout completed while an asynchronous payment was
      // processing, and that payment then failed.
      const { svc, prisma, stripe } = makeHandlerWithSplits();
      prisma._purchases.push({
        id: 'cp-r3-async',
        package_id: 'pkg-r3',
        stripe_payment_intent_id: 'pi_r3',
        status: 'paid',
        entitlement_active: true,
        last_error: null,
        created_at: new Date(),
      });
      stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: piStatus });
      const result = await deliver(svc, prisma, declined('evt_r3_async'));
      expect(result.claimed).toBe(true);
      expect(prisma._purchases[0].status).toBe('payment_failed');
      expect(prisma._purchases[0].entitlement_active).toBe(false);
      expect(prisma._purchases[0].last_error).toBe('card_declined');
    },
  );

  it.each([
    ['refunded', false],
    ['disputed', true],
    ['chargeback_lost', false],
    ['canceled', false],
    ['expired', false],
  ])(
    'a decline never rewrites a purchase in status %s (its own events own that state)',
    async (status, entitled) => {
      const { svc, prisma, stripe } = makeHandlerWithSplits();
      prisma._purchases.push({
        id: 'cp-r3-final',
        package_id: 'pkg-r3',
        stripe_payment_intent_id: 'pi_r3',
        status,
        entitlement_active: entitled,
        last_error: null,
        created_at: new Date(),
      });
      const result = await deliver(svc, prisma, declined('evt_r3_final'));
      expect(result.claimed).toBe(true);
      expect(prisma._purchases[0].status).toBe(status);
      expect(prisma._purchases[0].entitlement_active).toBe(entitled);
      expect(prisma._purchases[0].last_error).toBeNull();
      expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    },
  );

  it('a decline of another PaymentIntent never adopts a pending purchase that holds its own PaymentIntent', async () => {
    const { svc, prisma } = makeHandlerWithSplits();
    prisma._purchases.push({
      id: 'cp-sheet',
      client_user_id: 'c1',
      package_id: 'pkg-1',
      stripe_payment_intent_id: 'pi_sheet',
      status: 'pending',
      entitlement_active: false,
      last_error: null,
      created_at: new Date(),
      ...secrets,
    });
    const result = await deliver(svc, prisma, {
      id: 'evt_r3_foreign',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_hosted',
          metadata: { tgp_package_id: 'pkg-1', tgp_client_user_id: 'c1' },
          last_payment_error: { message: 'card_declined' },
        },
      },
    });
    expect(result.claimed).toBe(false);
    expect(prisma._purchases[0].status).toBe('pending');
    // Its own PaymentIntent's success can still find it.
    expect(prisma._purchases[0].stripe_payment_intent_id).toBe('pi_sheet');
  });

  it('the metadata fallback adopts the pending purchase without a PaymentIntent, never a newer one that holds its own', async () => {
    const { svc, prisma } = makeHandlerWithSplits();
    prisma._purchases.push(
      {
        id: 'cp-sheet',
        client_user_id: 'c1',
        package_id: 'pkg-1',
        stripe_payment_intent_id: 'pi_sheet',
        status: 'pending',
        entitlement_active: false,
        created_at: new Date('2026-10-03T12:05:00Z'),
      },
      {
        id: 'cp-hosted',
        client_user_id: 'c1',
        package_id: 'pkg-1',
        stripe_payment_intent_id: null,
        status: 'pending',
        entitlement_active: false,
        created_at: new Date('2026-10-03T12:00:00Z'),
      },
    );
    const result = await deliver(svc, prisma, {
      id: 'evt_r3_hosted',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_hosted',
          metadata: { tgp_package_id: 'pkg-1', tgp_client_user_id: 'c1' },
          last_payment_error: { message: 'card_declined' },
        },
      },
    });
    expect(result).toMatchObject({ claimed: true, purchase_id: 'cp-hosted' });
    expect(prisma._purchases[1].status).toBe('payment_failed');
    expect(prisma._purchases[1].stripe_payment_intent_id).toBe('pi_hosted');
    expect(prisma._purchases[0].status).toBe('pending');
    expect(prisma._purchases[0].stripe_payment_intent_id).toBe('pi_sheet');
  });

  it('prefetchForOuterTx asks Stripe for the PaymentIntent status only when the purchase already settled', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    expect(await svc.prefetchForOuterTx(declined('evt_r3_pf_1'))).toEqual({});
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();

    prisma._purchases[0].status = 'paid';
    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    expect(await svc.prefetchForOuterTx(declined('evt_r3_pf_2'))).toEqual({
      paymentIntentStatusById: { pi_r3: 'succeeded' },
      // Round 4/5: the purchase version (xmin) that status was read against.
      paymentIntentWitnessById: {
        pi_r3: { purchase_id: 'cp-r3', status: 'paid', row_version: '0' },
      },
    });
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_r3');
  });

  // Round 4 (Sol B-661-3): Stripe's status, read before the webhook
  // transaction, applies only to the purchase version it was read against.
  const SEEDED_AT = new Date('2026-10-03T12:00:00Z');
  function seedSettledHosted(prisma: ReturnType<typeof makePrisma>) {
    // A hosted checkout that completed while its payment was processing.
    prisma._purchases.push({
      id: 'cp-r3-h',
      package_id: 'pkg-r3',
      stripe_checkout_session_id: 'cs_r3',
      stripe_payment_intent_id: 'pi_r3',
      status: 'paid',
      entitlement_active: true,
      last_error: null,
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
      created_at: SEEDED_AT,
      updated_at: SEEDED_AT,
    });
  }
  const notCompleted = { id: 'pi_r3', status: 'requires_payment_method' };

  it('round 4: a decline whose Stripe status was read before a failure and a successful retry committed never revokes that retry', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedPending(prisma);
    Object.assign(prisma._purchases[0], {
      status: 'paid',
      entitlement_active: true,
      stripe_client_secret: null,
      stripe_ephemeral_key: null,
      updated_at: SEEDED_AT,
    });
    stripe.retrievePaymentIntent.mockResolvedValue(notCompleted);
    const lateDecline = declined('evt_r3_v_old');
    const stalePrefetch = await svc.prefetchForOuterTx(lateDecline);
    expect(stalePrefetch.paymentIntentStatusById).toEqual({ pi_r3: 'requires_payment_method' });

    await deliver(svc, prisma, declined('evt_r3_v_other'));
    expect(prisma._purchases[0].status).toBe('payment_failed');
    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    await deliver(svc, prisma, succeeded);
    expectPaidAndEntitled(prisma);

    // The old delivery enters its transaction with the stale status: Stripe
    // redelivers it, and the fresh read says the PaymentIntent succeeded.
    await expect(svc.handle(lateDecline, txFixture(prisma), stalePrefetch)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(prisma);
    expect((await deliver(svc, prisma, lateDecline)).reason).toBe('stale_failure');
    expectPaidAndEntitled(prisma);
  });

  it('round 4: the success of the PaymentIntent on a provisionally paid hosted purchase records the settlement, so a decline read before it never revokes', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedSettledHosted(prisma);
    stripe.retrievePaymentIntent.mockResolvedValue(notCompleted);
    const lateDecline = declined('evt_r3_h_old');
    const stalePrefetch = await svc.prefetchForOuterTx(lateDecline);

    const confirmed = await deliver(svc, prisma, succeeded);
    expect(confirmed.claimed).toBe(false);
    expect(prisma._purchases[0].updated_at.getTime()).toBeGreaterThan(SEEDED_AT.getTime());

    await expect(svc.handle(lateDecline, txFixture(prisma), stalePrefetch)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(prisma);
    stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_r3', status: 'succeeded' });
    expect((await deliver(svc, prisma, lateDecline)).reason).toBe('stale_failure');
    expectPaidAndEntitled(prisma);
  });

  it('round 4 (no transaction): a success that commits while Stripe is being asked wins over the decline', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedSettledHosted(prisma);
    // The decline reads the purchase (a snapshot, like Postgres) ...
    const readPurchase = prisma.clientPurchase.findFirst.getMockImplementation();
    prisma.clientPurchase.findFirst.mockImplementationOnce(async (args: unknown) => ({
      ...(await readPurchase(args)),
    }));
    // ... then the success commits while Stripe still reports the old status.
    stripe.retrievePaymentIntent.mockImplementationOnce(async () => {
      await svc.handle(succeeded, txFixture(prisma), {});
      return notCompleted;
    });
    await expect(svc.handle(declined('evt_r3_nt_race'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(prisma);
  });

  it('C-661-6: Stripe answers 404 for the PaymentIntent: the decline is not applied and is not redelivered for days', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedSettledHosted(prisma);
    stripe.retrievePaymentIntent.mockRejectedValue(
      new StripeConnectApiError('missing', 404, 'resource_missing', 'invalid_request_error'),
    );
    const result = await deliver(svc, prisma, declined('evt_r3_404'));
    expect(result).toEqual({
      claimed: true,
      purchase_id: 'cp-r3-h',
      reason: 'payment_intent_unreadable',
    });
    expectPaidAndEntitled(prisma);
  });

  it('(control) C-661-6: a 429 from Stripe is transient, so Stripe redelivers the decline', async () => {
    const { svc, prisma, stripe } = makeHandlerWithSplits();
    seedSettledHosted(prisma);
    stripe.retrievePaymentIntent.mockRejectedValue(
      new StripeConnectApiError('slow down', 429, 'rate_limit', 'rate_limit_error'),
    );
    await expect(deliver(svc, prisma, declined('evt_r3_429'))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expectPaidAndEntitled(prisma);
  });
});
