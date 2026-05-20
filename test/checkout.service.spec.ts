import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CheckoutService } from '../src/checkout/checkout.service';
import { ConnectModuleState } from '../src/connect/connect.module-state';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { PackagesService } from '../src/packages/packages.service';

// Stripe-API stub — overrides every method we exercise.
class StripeStub extends StripeConnectApiService {
  createCustomer = jest.fn(async (args: any) => ({
    id: 'cus_new_' + args.idempotencyKey.slice(-4),
    email: args.email ?? null,
  }));
  retrieveCustomer = jest.fn();
  retrievePaymentMethod = jest.fn();
  retrieveSubscription = jest.fn();
  createProduct = jest.fn(async (args: any) => ({
    id: 'prod_' + args.idempotencyKey,
    name: args.name,
    active: true,
  }));
  createPrice = jest.fn(async (args: any) => ({
    id: 'price_' + args.unit_amount,
    product: args.product,
    active: true,
    unit_amount: args.unit_amount,
    currency: args.currency,
  }));
  createCheckoutSession = jest.fn(async (args: any) => ({
    id: 'cs_test_' + args.idempotencyKey.slice(-6),
    url: 'https://checkout.stripe.com/test/' + args.idempotencyKey,
    customer: args.customer,
    payment_intent: args.mode === 'payment' ? 'pi_test' : null,
    subscription: args.mode === 'subscription' ? 'sub_test' : null,
  }));
  retrieveCheckoutSession = jest.fn();
}

function makePrismaStub() {
  const packages: any[] = [];
  const purchases: any[] = [];
  const customers: any[] = [];
  const accounts: any[] = [];
  const users: any[] = [];
  return {
    _packages: packages,
    _purchases: purchases,
    _customers: customers,
    _accounts: accounts,
    _users: users,
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
      ),
    },
    coachPackage: {
      findUnique: jest.fn(async ({ where }: any) =>
        packages.find((p) => p.id === where.id) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        packages.find(
          (p) =>
            p.id === where.id &&
            (where.coach_id === undefined || p.coach_id === where.coach_id) &&
            p.is_active !== false &&
            !p.archived_at,
        ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = packages.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    connectAccount: {
      findUnique: jest.fn(async ({ where }: any) =>
        accounts.find((a) => a.coach_user_id === where.coach_user_id) ?? null,
      ),
    },
    connectCustomer: {
      findUnique: jest.fn(async ({ where }: any) =>
        customers.find((c) =>
          where.client_user_id
            ? c.client_user_id === where.client_user_id
            : c.stripe_customer_id === where.stripe_customer_id,
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (customers.some((c) => c.client_user_id === data.client_user_id)) {
          const err: any = new Error('dup');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `cc-${customers.length + 1}`, ...data };
        customers.push(row);
        return { ...row };
      }),
      update: jest.fn(),
    },
    clientPurchase: {
      findUnique: jest.fn(async ({ where }: any) =>
        purchases.find((p) =>
          where.idempotency_key
            ? p.idempotency_key === where.idempotency_key
            : where.stripe_checkout_session_id
              ? p.stripe_checkout_session_id === where.stripe_checkout_session_id
              : p.id === where.id,
        ) ?? null,
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          purchases.find((p) => {
            for (const [k, v] of Object.entries(where)) {
              if (k === 'OR' && Array.isArray(v)) {
                const ok = (v as any[]).some((clause) =>
                  Object.entries(clause).every(([ck, cv]) => {
                    if (cv === null) return p[ck] === null || p[ck] === undefined;
                    if (typeof cv === 'object' && cv !== null) {
                      if ('gt' in (cv as any)) {
                        return p[ck] && p[ck] > (cv as any).gt;
                      }
                    }
                    return p[ck] === cv;
                  }),
                );
                if (!ok) return false;
                continue;
              }
              if (v === null) {
                if (!(p[k] === null || p[k] === undefined)) return false;
                continue;
              }
              if (typeof v === 'object' && v !== null) {
                if ('gt' in (v as any) && !(p[k] && p[k] > (v as any).gt)) {
                  return false;
                }
                continue;
              }
              if (p[k] !== v) return false;
            }
            return true;
          }) ?? null
        );
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = purchases.find(
          (p) => p.idempotency_key === where.idempotency_key,
        );
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return { ...existing };
        }
        const row = {
          id: `cp-${purchases.length + 1}`,
          created_at: new Date(),
          updated_at: new Date(),
          ...create,
        };
        purchases.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        purchases.filter((p) =>
          Object.entries(where).every(([k, v]) => p[k] === v),
        ),
      ),
    },
  };
}

function makeService() {
  const prisma: any = makePrismaStub();
  // Phase 4 — feePolicy + teamSubCoachAssignment stubs used by
  // FeePolicyService when resolving the split. Solo-PT default: no
  // override row, no head-coach assignment.
  prisma._feePolicies = [];
  prisma._teamAssignments = [];
  prisma.feePolicy = {
    findUnique: jest.fn(async ({ where }: any) =>
      prisma._feePolicies.find((p: any) => p.coach_id === where.coach_id) ?? null,
    ),
    upsert: jest.fn(),
  };
  prisma.teamSubCoachAssignment = {
    findFirst: jest.fn(async ({ where }: any) => {
      const row = prisma._teamAssignments.find(
        (a: any) =>
          a.sub_coach_id === where.sub_coach_id && a.archived_at == null,
      );
      return row ?? null;
    }),
  };
  const stripe = new StripeStub();
  const packages = new PackagesService(prisma as any);
  const state = new ConnectModuleState();
  state.ready = true;
  const feePolicy = new FeePolicyService(prisma as any);
  const svc = new CheckoutService(
    prisma as any,
    stripe as any,
    packages,
    state,
    feePolicy,
  );
  return { svc, prisma, stripe, packages, state, feePolicy };
}

describe('CheckoutService', () => {
  it('returns 503 when Connect is not ready', async () => {
    const { svc, state } = makeService();
    state.ready = false;
    state.reason = 'platform check failed';
    await expect(
      svc.createCheckoutForClient('client-1', { package_id: 'p1' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('404s on unknown package', async () => {
    const { svc } = makeService();
    await expect(
      svc.createCheckoutForClient('client-1', { package_id: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s when coach has no Connect account', async () => {
    const { svc, prisma } = makeService();
    prisma._packages.push({
      id: 'pkg-1',
      coach_id: 'coach-1',
      name: 'p',
      amount_cents: 9900,
      currency: 'usd',
      billing_type: 'one_time',
      interval: null,
      interval_count: 1,
      duration_periods: null,
      is_active: true,
      archived_at: null,
      stripe_price_id: null,
      stripe_product_id: null,
    });
    prisma._users.push({
      id: 'coach-1',
      email: 'c@x.com',
      name: 'Coach',
      coach_id: null,
    });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });
    await expect(
      svc.createCheckoutForClient('client-1', { package_id: 'pkg-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('409s when coach Connect account is not payout-ready', async () => {
    const { svc, prisma } = makeService();
    prisma._packages.push({
      id: 'pkg-1',
      coach_id: 'coach-1',
      name: 'p',
      amount_cents: 9900,
      currency: 'usd',
      billing_type: 'one_time',
      interval: null,
      interval_count: 1,
      duration_periods: null,
      is_active: true,
      archived_at: null,
      stripe_price_id: null,
      stripe_product_id: null,
    });
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_1',
      charges_enabled: false,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-1', email: 'c@x.com', name: 'Coach' });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });
    await expect(
      svc.createCheckoutForClient('client-1', { package_id: 'pkg-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('end-to-end: creates customer + product + price + checkout session + purchase for one_time', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-1',
      coach_id: 'coach-1',
      name: 'Transform 12',
      description: '12-week program',
      amount_cents: 99900,
      currency: 'usd',
      billing_type: 'one_time',
      interval: null,
      interval_count: 1,
      duration_periods: 12,
      is_active: true,
      archived_at: null,
      stripe_price_id: null,
      stripe_product_id: null,
    });
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-1', email: 'c@x.com', name: 'Coach' });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });

    const out = await svc.createCheckoutForClient('client-1', {
      package_id: 'pkg-1',
    });
    expect(out.session_id).toMatch(/^cs_test_/);
    expect(out.url).toContain('checkout.stripe.com');
    expect(out.status).toBe('pending');

    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(stripe.createProduct).toHaveBeenCalledTimes(1);
    expect(stripe.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({ unit_amount: 99900, currency: 'usd' }),
    );
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        destinationAccount: 'acct_coach',
      }),
    );
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0]).toMatchObject({
      client_user_id: 'client-1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      amount_cents: 99900,
      status: 'pending',
      entitlement_active: false,
    });
    // Stripe Price was cached back onto the package row.
    expect(prisma._packages[0].stripe_price_id).toBeTruthy();
  });

  it('end-to-end: creates subscription checkout for recurring package', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-2',
      coach_id: 'coach-1',
      name: 'Monthly',
      amount_cents: 19900,
      currency: 'usd',
      billing_type: 'recurring',
      interval: 'month',
      interval_count: 1,
      duration_periods: null,
      is_active: true,
      archived_at: null,
      stripe_price_id: null,
      stripe_product_id: null,
    });
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-1', email: 'c@x.com', name: 'Coach' });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });

    await svc.createCheckoutForClient('client-1', { package_id: 'pkg-2' });
    expect(stripe.createPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        recurring: { interval: 'month', interval_count: 1 },
      }),
    );
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'subscription' }),
    );
  });

  it('reuses cached Product and Price on second checkout', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-3',
      coach_id: 'coach-1',
      name: 'X',
      amount_cents: 5000,
      currency: 'usd',
      billing_type: 'one_time',
      interval: null,
      interval_count: 1,
      duration_periods: null,
      is_active: true,
      archived_at: null,
      stripe_price_id: 'price_cached',
      stripe_product_id: 'prod_cached',
    });
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-1', email: 'c@x.com', name: 'Coach' });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });

    await svc.createCheckoutForClient('client-1', { package_id: 'pkg-3' });
    expect(stripe.createProduct).not.toHaveBeenCalled();
    expect(stripe.createPrice).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_cached' }),
    );
  });

  it('idempotency: same client+package same day collapses to one purchase row', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-4',
      coach_id: 'coach-1',
      name: 'X',
      amount_cents: 5000,
      currency: 'usd',
      billing_type: 'one_time',
      interval: null,
      interval_count: 1,
      duration_periods: null,
      is_active: true,
      archived_at: null,
      stripe_price_id: 'price_cached',
      stripe_product_id: 'prod_cached',
    });
    prisma._accounts.push({
      coach_user_id: 'coach-1',
      stripe_account_id: 'acct_coach',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-1', email: 'c@x.com', name: 'Coach' });
    prisma._users.push({ id: 'client-1', email: 'a@b.c', name: 'A', coach_id: 'coach-1' });

    // First call creates the session
    const first = await svc.createCheckoutForClient('client-1', {
      package_id: 'pkg-4',
    });

    // Set up retrieveCheckoutSession stub to return the same session URL.
    stripe.retrieveCheckoutSession.mockResolvedValueOnce({
      id: first.session_id,
      url: first.url,
    } as any);

    const second = await svc.createCheckoutForClient('client-1', {
      package_id: 'pkg-4',
    });
    expect(prisma._purchases).toHaveLength(1);
    expect(second.purchase_id).toBe(first.purchase_id);
    expect(second.url).toBe(first.url);
    // The second call does NOT mint a new checkout session.
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

describe('CheckoutService.hasActiveEntitlement', () => {
  it('returns true for non-expiring active purchase', async () => {
    const { svc, prisma } = makeService();
    prisma._purchases.push({
      id: 'cp-1',
      client_user_id: 'c1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      entitlement_active: true,
      access_expires_at: null,
    });
    expect(
      await svc.hasActiveEntitlement('c1', { coachUserId: 'coach-1' }),
    ).toBe(true);
  });

  it('returns true for active purchase with future expiry', async () => {
    const { svc, prisma } = makeService();
    prisma._purchases.push({
      id: 'cp-1',
      client_user_id: 'c1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      entitlement_active: true,
      access_expires_at: new Date(Date.now() + 86400000),
    });
    expect(await svc.hasActiveEntitlement('c1', { packageId: 'pkg-1' })).toBe(
      true,
    );
  });

  it('returns false for expired purchase', async () => {
    const { svc, prisma } = makeService();
    prisma._purchases.push({
      id: 'cp-1',
      client_user_id: 'c1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      entitlement_active: true,
      access_expires_at: new Date(Date.now() - 86400000),
    });
    expect(await svc.hasActiveEntitlement('c1', { packageId: 'pkg-1' })).toBe(
      false,
    );
  });

  it('returns false for entitlement_active=false', async () => {
    const { svc, prisma } = makeService();
    prisma._purchases.push({
      id: 'cp-1',
      client_user_id: 'c1',
      coach_user_id: 'coach-1',
      package_id: 'pkg-1',
      entitlement_active: false,
      access_expires_at: null,
    });
    expect(await svc.hasActiveEntitlement('c1', { packageId: 'pkg-1' })).toBe(
      false,
    );
  });
});
