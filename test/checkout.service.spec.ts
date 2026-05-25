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
  createPaymentIntent = jest.fn(async (args: any) => ({
    id: 'pi_test_' + args.idempotencyKey.slice(-6),
    client_secret: 'pi_test_secret_' + args.idempotencyKey.slice(-6),
    amount: args.amount,
    currency: args.currency,
    customer: args.customer,
    application_fee_amount: args.applicationFeeAmount,
  }));
  createEphemeralKey = jest.fn(
    async (_customerId: string, _idempotencyKey: string) => ({
      secret: 'ek_test_secret',
    }),
  );
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
      create: jest.fn(async ({ data }: any) => {
        // Mimic Prisma unique-constraint failure on idempotency_key or
        // stripe_checkout_session_id collision.
        const collision = purchases.find(
          (p) =>
            p.idempotency_key === data.idempotency_key ||
            (data.stripe_checkout_session_id &&
              p.stripe_checkout_session_id === data.stripe_checkout_session_id),
        );
        if (collision) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          id: `cp-${purchases.length + 1}`,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        purchases.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = purchases.find((p) =>
          where.id ? p.id === where.id :
          where.idempotency_key ? p.idempotency_key === where.idempotency_key :
          false,
        );
        if (!row) {
          const err: any = new Error('Row not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = purchases.findIndex((p) =>
          where.id ? p.id === where.id :
          where.idempotency_key ? p.idempotency_key === where.idempotency_key :
          false,
        );
        if (idx === -1) {
          const err: any = new Error('Row not found');
          err.code = 'P2025';
          throw err;
        }
        const [row] = purchases.splice(idx, 1);
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

// ──────────────────────────────────────────────────────────────────────
// Audit #1 P0/P1 — createPaymentIntentForClient behavioral coverage.
//
// Covers the IDOR hard-block (P0-1), the client idempotency-key dedup
// (P1-4), the fee math handed to Stripe, and the Stripe parameter
// assertion (destination account + application fee). These cases assert
// observable behavior on the prisma stub + Stripe stub — no grep theater.
// ──────────────────────────────────────────────────────────────────────

function seedSoloCoachFixture(prisma: any) {
  prisma._packages.push({
    id: 'pkg-x',
    coach_id: 'coach-x',
    name: 'Plan',
    amount_cents: 10000, // $100
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
    coach_user_id: 'coach-x',
    stripe_account_id: 'acct_coach_x',
    charges_enabled: true,
    deauthorized_at: null,
  });
  prisma._users.push({
    id: 'coach-x',
    email: 'coach-x@example.com',
    name: 'Coach X',
  });
}

describe('CheckoutService.createPaymentIntentForClient — IDOR + idempotency', () => {
  it('assigned client buying their own coach\'s package: Stripe called with correct destination + 2% application fee', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-ok',
      email: 'a@b.c',
      name: 'A',
      coach_id: 'coach-x',
    });

    const out = await svc.createPaymentIntentForClient('client-ok', {
      package_id: 'pkg-x',
      idempotency_key: '11111111-1111-4111-8111-111111111111',
    });

    expect(out.client_secret).toMatch(/^pi_test_secret_/);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    const call = (stripe.createPaymentIntent as jest.Mock).mock.calls[0][0];
    expect(call.amount).toBe(10000);
    expect(call.currency).toBe('usd');
    expect(call.transferDestination).toBe('acct_coach_x');
    // Audit #3 P1-10 — connected coach is the merchant of record so
    // on_behalf_of matches transferDestination.
    expect(call.onBehalfOf).toBe('acct_coach_x');
    // Solo coach (no head-coach assignment): platform 2% of $100 = 200 cents.
    expect(call.applicationFeeAmount).toBe(200);
    // Stripe idempotency key includes the client-supplied UUID.
    expect(call.idempotencyKey).toContain('11111111-1111-4111-8111-111111111111');
    // Persisted purchase row + cached secret for replay.
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0].stripe_client_secret).toBe(out.client_secret);
  });

  it('cross-coach IDOR: client assigned to Coach C trying to buy Coach B\'s package → NotFoundException, Stripe NOT called', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    // A second coach the client is actually assigned to.
    prisma._users.push({
      id: 'coach-other',
      email: 'other@example.com',
      name: 'Other Coach',
    });
    prisma._users.push({
      id: 'client-cross',
      email: 'c@x.com',
      name: 'Cross',
      coach_id: 'coach-other',
    });

    await expect(
      svc.createPaymentIntentForClient('client-cross', {
        package_id: 'pkg-x',
        idempotency_key: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(0);
  });

  it('unassigned client (coach_id null): NotFoundException, Stripe NOT called', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-unassigned',
      email: 'u@x.com',
      name: 'Unassigned',
      coach_id: null,
    });

    await expect(
      svc.createPaymentIntentForClient('client-unassigned', {
        package_id: 'pkg-x',
        idempotency_key: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(0);
  });

  it('duplicate idempotency key: Stripe called once, both calls return same client_secret', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-dup',
      email: 'd@x.com',
      name: 'Dup',
      coach_id: 'coach-x',
    });

    const key = '44444444-4444-4444-8444-444444444444';
    const first = await svc.createPaymentIntentForClient('client-dup', {
      package_id: 'pkg-x',
      idempotency_key: key,
    });
    const second = await svc.createPaymentIntentForClient('client-dup', {
      package_id: 'pkg-x',
      idempotency_key: key,
    });

    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.createEphemeralKey).toHaveBeenCalledTimes(1);
    expect(second.client_secret).toBe(first.client_secret);
    expect(prisma._purchases).toHaveLength(1);
  });

  it('rejects missing idempotency_key with 400', async () => {
    const { svc, prisma } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-no-key',
      email: 'n@x.com',
      name: 'NK',
      coach_id: 'coach-x',
    });

    await expect(
      svc.createPaymentIntentForClient('client-no-key', {
        package_id: 'pkg-x',
        idempotency_key: '',
      } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fee math: $100 package with default fee policy yields 200 cents application fee (2%)', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-fee',
      email: 'f@x.com',
      name: 'F',
      coach_id: 'coach-x',
    });

    await svc.createPaymentIntentForClient('client-fee', {
      package_id: 'pkg-x',
      idempotency_key: '55555555-5555-4555-8555-555555555555',
    });
    const call = (stripe.createPaymentIntent as jest.Mock).mock.calls[0][0];
    // Platform 2% = 200; no head coach assigned → split 0; total = 200.
    expect(call.applicationFeeAmount).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #2 P0-3 — createCheckoutForClient IDOR hard-block. The same
// hard-fail authorization rule that already protects the PaymentIntent
// path must apply to the Checkout-session path. Cross-coach and
// unassigned-client attempts must return NotFoundException and must NOT
// reach Stripe.
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutService.createCheckoutForClient — IDOR hard-block', () => {
  it('cross-coach: client assigned to Coach A cannot create a Checkout Session for Coach B\'s package', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-b',
      coach_id: 'coach-b',
      name: 'Coach B Plan',
      amount_cents: 10000,
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
      coach_user_id: 'coach-b',
      stripe_account_id: 'acct_coach_b',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-a', email: 'a@coach.com', name: 'A' });
    prisma._users.push({ id: 'coach-b', email: 'b@coach.com', name: 'B' });
    prisma._users.push({
      id: 'client-cross-cs',
      email: 'c@x.com',
      name: 'Cross',
      coach_id: 'coach-a',
    });

    await expect(
      svc.createCheckoutForClient('client-cross-cs', { package_id: 'pkg-b' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createPrice).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(0);
  });

  it('unassigned client (coach_id null): cannot create a Checkout Session, Stripe NOT called', async () => {
    const { svc, prisma, stripe } = makeService();
    prisma._packages.push({
      id: 'pkg-c',
      coach_id: 'coach-c',
      name: 'Coach C Plan',
      amount_cents: 10000,
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
      coach_user_id: 'coach-c',
      stripe_account_id: 'acct_coach_c',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({ id: 'coach-c', email: 'c@coach.com', name: 'C' });
    prisma._users.push({
      id: 'client-unassigned-cs',
      email: 'u@x.com',
      name: 'Unassigned',
      coach_id: null,
    });

    await expect(
      svc.createCheckoutForClient('client-unassigned-cs', {
        package_id: 'pkg-c',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(prisma._purchases).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #2 P1-8 — PaymentIntent idempotency must be race-safe. Two
// simultaneous requests with the same client-supplied idempotency_key
// must result in at most one Stripe.createPaymentIntent call.
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutService.createPaymentIntentForClient — concurrency-safe idempotency', () => {
  it('two simultaneous same-key requests: Stripe called at most once, both return same client_secret', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-race',
      email: 'r@x.com',
      name: 'Race',
      coach_id: 'coach-x',
    });

    const key = '99999999-9999-4999-8999-999999999999';
    const [a, b] = await Promise.all([
      svc.createPaymentIntentForClient('client-race', {
        package_id: 'pkg-x',
        idempotency_key: key,
      }),
      svc.createPaymentIntentForClient('client-race', {
        package_id: 'pkg-x',
        idempotency_key: key,
      }),
    ]);

    // The unique constraint on idempotency_key is the single-flight gate:
    // exactly one request reaches Stripe.
    expect(
      (stripe.createPaymentIntent as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(1);
    expect(
      (stripe.createEphemeralKey as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(1);
    // Both callers must see the same client_secret regardless of who won.
    expect(a.client_secret).toBe(b.client_secret);
    expect(a.client_secret).toMatch(/^pi_test_secret_/);
    expect(prisma._purchases).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #2 P1-9 — sub-coach 2% + 5% fee split. When the selling coach
// is a sub-coach with an active head-coach assignment, the application
// fee handed to Stripe must equal platform 2% + head-coach 5% = 7%.
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutService.createPaymentIntentForClient — sub-coach fee split', () => {
  it('$100 package from a sub-coach yields 700 cents application fee (2% platform + 5% head coach)', async () => {
    const { svc, prisma, stripe } = makeService();
    // Selling coach is a sub-coach with an active head-coach assignment.
    prisma._packages.push({
      id: 'pkg-sub',
      coach_id: 'sub-coach-1',
      name: 'Sub Plan',
      amount_cents: 10000, // $100
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
      coach_user_id: 'sub-coach-1',
      stripe_account_id: 'acct_sub_1',
      charges_enabled: true,
      deauthorized_at: null,
    });
    prisma._users.push({
      id: 'sub-coach-1',
      email: 'sub@coach.com',
      name: 'Sub',
    });
    prisma._users.push({
      id: 'head-coach-1',
      email: 'head@coach.com',
      name: 'Head',
    });
    prisma._teamAssignments.push({
      head_coach_id: 'head-coach-1',
      sub_coach_id: 'sub-coach-1',
      archived_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    prisma._users.push({
      id: 'client-sub',
      email: 's@x.com',
      name: 'Sub Client',
      coach_id: 'sub-coach-1',
    });

    await svc.createPaymentIntentForClient('client-sub', {
      package_id: 'pkg-sub',
      idempotency_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    const call = (stripe.createPaymentIntent as jest.Mock).mock.calls[0][0];
    // 2% platform = 200 cents + 5% head coach = 500 cents → 700 total.
    expect(call.applicationFeeAmount).toBe(700);
    expect(call.metadata.tgp_platform_fee_cents).toBe('200');
    expect(call.metadata.tgp_head_coach_split_cents).toBe('500');
    expect(call.metadata.tgp_head_coach_user_id).toBe('head-coach-1');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #3 P1-A — reservation failure recovery. If the winning request
// fails between reserving the idempotency key and publishing the
// client_secret, the reservation row must be cleaned up so subsequent
// same-key retries can become the new winner instead of waiting forever
// in PAYMENT_IN_PROGRESS.
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutService.createPaymentIntentForClient — reservation failure recovery', () => {
  it('Stripe failure on winner: reservation row is dropped and a retry with the same idempotency_key succeeds', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-fail',
      email: 'f@x.com',
      name: 'Fail',
      coach_id: 'coach-x',
    });

    const key = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    (stripe.createPaymentIntent as jest.Mock).mockRejectedValueOnce(
      new Error('stripe network blip'),
    );

    await expect(
      svc.createPaymentIntentForClient('client-fail', {
        package_id: 'pkg-x',
        idempotency_key: key,
      }),
    ).rejects.toThrow('stripe network blip');

    // Reservation MUST have been cleaned up — otherwise the key is
    // permanently poisoned and the next retry hangs.
    expect(prisma._purchases).toHaveLength(0);

    // Same-key retry now succeeds (becomes the new winner).
    const out = await svc.createPaymentIntentForClient('client-fail', {
      package_id: 'pkg-x',
      idempotency_key: key,
    });
    expect(out.client_secret).toMatch(/^pi_test_secret_/);
    expect(prisma._purchases).toHaveLength(1);
    expect(prisma._purchases[0].stripe_client_secret).toBe(out.client_secret);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #3 P1-B — R19: every Stripe mutation carries an Idempotency-Key.
// The EphemeralKey POST is part of the same money-moving operation as
// createPaymentIntent and must receive a deterministic key derived from
// the parent PaymentIntent idempotency key.
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutService.createPaymentIntentForClient — EphemeralKey idempotency (R19)', () => {
  it('passes a non-empty idempotency key derived from the parent PaymentIntent key to createEphemeralKey', async () => {
    const { svc, prisma, stripe } = makeService();
    seedSoloCoachFixture(prisma);
    prisma._users.push({
      id: 'client-ek',
      email: 'e@x.com',
      name: 'EK',
      coach_id: 'coach-x',
    });

    const clientKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await svc.createPaymentIntentForClient('client-ek', {
      package_id: 'pkg-x',
      idempotency_key: clientKey,
    });

    expect(stripe.createEphemeralKey).toHaveBeenCalledTimes(1);
    const call = (stripe.createEphemeralKey as jest.Mock).mock.calls[0];
    expect(call[0]).toMatch(/^cus_new_/);
    // R19: the idempotency key must exist, be non-empty, and derive from
    // the client-supplied UUID so retries collapse on Stripe's side.
    expect(typeof call[1]).toBe('string');
    expect(call[1].length).toBeGreaterThan(0);
    expect(call[1]).toContain(clientKey);
    expect(call[1]).toMatch(/-ephkey$/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit #1 P1-1 — confirm @Throttle metadata is mounted on the
// payment-intent route. Verifies the decorator was applied (it cannot
// run a real throttler from a unit test, but the metadata presence is
// the contract the global ThrottlerGuard relies on).
// ──────────────────────────────────────────────────────────────────────
describe('CheckoutController — payment-intent throttle metadata', () => {
  it('exposes a per-user throttle on POST /v1/checkout/payment-intent', () => {

    const { CheckoutController } = require('../src/checkout/checkout.controller');
    // @nestjs/throttler stores limit/ttl under `THROTTLER:LIMIT<name>` /
    // `THROTTLER:TTL<name>` keyed by the family name. Main uses the
    // named throttler "checkout-mint" instead of "default".
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITcheckout-mint',
      CheckoutController.prototype.createPaymentIntent,
    );
    const ttl = Reflect.getMetadata(
      'THROTTLER:TTLcheckout-mint',
      CheckoutController.prototype.createPaymentIntent,
    );
    expect(limit).toBeDefined();
    expect(ttl).toBeDefined();
  });
});