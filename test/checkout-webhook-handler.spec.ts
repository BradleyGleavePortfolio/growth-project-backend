import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';

class StripeStub extends StripeConnectApiService {
  retrieveSubscription = jest.fn();
  retrievePaymentMethod = jest.fn();
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
      findFirst: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          Object.entries(where).every(([k, v]) => {
            if (v === null) return p[k] === null;
            return p[k] === v;
          }),
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
    },
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
