import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';

// R43 — GuestCheckoutService tests. Prisma, Stripe, and Supabase are all
// mocked. We test: package resolution, idempotency (replay path), Stripe
// 503 surfacing, recurring rejection (P1-3), handlePaymentSucceeded
// idempotency, handlePaymentFailed, durable conversion (P1-4),
// listUsers pagination beyond page 1 (P1-5), expires_at gating (P2-4),
// and destination account persistence (P2-5).

const IDEMP_KEY = '550e8400-e29b-41d4-a716-446655440000';

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pkg-1',
    coach_id: 'coach-1',
    amount_cents: 29700,
    currency: 'usd',
    billing_type: 'one_time',
    is_active: true,
    archived_at: null,
    share_token: 'tok123',
    share_link_enabled: true,
    coach: {
      id: 'coach-1',
      name: 'Coach McCoach',
      connect_account: {
        stripe_account_id: 'acct_x',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: null,
      },
    },
    ...overrides,
  };
}

const baseDto = {
  guest_name: 'Jane Smith',
  guest_email: 'jane@example.com',
  idempotency_key: IDEMP_KEY,
};

interface PrismaMocks {
  coachPackage: { findUnique: jest.Mock };
  guestCheckout: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  clientPurchase: { findFirst: jest.Mock; create: jest.Mock };
  connectAccount: { findUnique: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrismaMocks(): PrismaMocks {
  const mocks: PrismaMocks = {
    coachPackage: { findUnique: jest.fn() },
    guestCheckout: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    clientPurchase: { findFirst: jest.fn(), create: jest.fn() },
    connectAccount: {
      findUnique: jest.fn().mockResolvedValue({ stripe_account_id: 'acct_x' }),
    },
    $transaction: jest.fn(),
  };
  // $transaction(cb) calls cb with `tx` — wire it through to the same
  // jest mocks so callers can assert on tx.<model>.<method> invocations.
  mocks.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(mocks),
  );
  return mocks;
}

describe('GuestCheckoutService', () => {
  let service: GuestCheckoutService;
  let prisma: PrismaMocks;
  let stripe: {
    createPaymentIntent: jest.Mock;
    retrievePaymentIntent: jest.Mock;
  };
  let supabaseAdminMock: {
    createUser: jest.Mock;
    listUsers: jest.Mock;
  };

  beforeEach(async () => {
    prisma = buildPrismaMocks();
    stripe = {
      createPaymentIntent: jest.fn(),
      retrievePaymentIntent: jest.fn(),
    };
    supabaseAdminMock = {
      createUser: jest.fn(),
      listUsers: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestCheckoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeConnectApiService, useValue: stripe },
        {
          provide: SupabaseService,
          useValue: {
            getClient: () => ({
              auth: { admin: supabaseAdminMock },
            }),
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(GuestCheckoutService);
  });

  describe('createIntent', () => {
    it('404s when the token does not resolve', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(null);
      await expect(service.createIntent('bad', baseDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    // Audit #3 P1-5 — recurring packages are displayed on the public
    // storefront but Phase 1 cannot honour subscription billing. The
    // guard MUST use the canonical schema value `recurring` (which is
    // what coach console writes), not display labels like
    // `monthly`/`quarterly`/`annual` (which live in the interval
    // columns). A previous build used the display labels and silently
    // let canonical-recurring packages through as one-off PIs.
    it('rejects recurring packages with 422 RECURRING_NOT_SUPPORTED using the canonical billing_type', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ billing_type: 'recurring', interval: 'month', interval_count: 1 }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValue(null);
      await expect(service.createIntent('tok123', baseDto)).rejects.toThrow(
        UnprocessableEntityException,
      );
      // Never burns a Stripe API call for a recurring package.
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    // Display labels in the interval column must never gate the
    // recurring guard. A `one_time` package with interval='month' is
    // still a one-off charge.
    it('allows one_time packages even when interval columns look monthly', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ billing_type: 'one_time', interval: 'month', interval_count: 1 }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({
        id: 'gc-1',
        idempotency_key: baseDto.idempotency_key,
        package_id: 'pkg-1',
        stripe_payment_intent_id: `pending_${baseDto.idempotency_key}`,
        status: 'pending',
        guest_email: baseDto.guest_email.toLowerCase(),
      });
      stripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_xyz',
        client_secret: 'pi_xyz_secret',
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});
      await expect(service.createIntent('tok123', baseDto)).resolves.toMatchObject({
        payment_intent_id: 'pi_xyz',
      });
    });

    it('mints a Stripe PaymentIntent and persists the sentinel row', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(makePkg());
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({
        id: 'gc-1',
        idempotency_key: IDEMP_KEY,
      });
      stripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_xyz',
        client_secret: 'pi_xyz_secret',
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({ id: 'gc-1' });
      const result = await service.createIntent('tok123', baseDto);
      expect(result.payment_intent_id).toBe('pi_xyz');
      expect(result.client_secret).toBe('pi_xyz_secret');
      expect(result.guest_checkout_id).toBe('gc-1');
      expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
      const call = stripe.createPaymentIntent.mock.calls[0][0];
      // 2% of 29700 = 594; floor and apply Stripe min(50).
      expect(call.applicationFeeAmount).toBe(594);
      expect(call.metadata.guest_checkout_idempotency_key).toBe(IDEMP_KEY);
      // P2-3 — `customer` must not be sent as an empty string for guest
      // PaymentIntents; omit it entirely.
      expect(call.customer).toBeUndefined();
    });

    it('clamps platform fee to Stripe minimum of 50¢', async () => {
      // 2% of $5 (500¢) = 10¢ — below Stripe min, so we charge 50¢.
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ amount_cents: 500 }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-2' });
      stripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_2',
        client_secret: 's2',
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});
      await service.createIntent('tok123', baseDto);
      expect(
        stripe.createPaymentIntent.mock.calls[0][0].applicationFeeAmount,
      ).toBe(50);
    });

    it('replays an existing pending intent without minting a new PaymentIntent', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(makePkg());
      prisma.guestCheckout.findUnique.mockResolvedValueOnce({
        id: 'gc-existing',
        package_id: 'pkg-1',
        guest_email: 'jane@example.com',
        status: 'pending',
        stripe_payment_intent_id: 'pi_prior',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      });
      stripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_prior',
        client_secret: 'pi_prior_secret',
      });
      const result = await service.createIntent('tok123', baseDto);
      expect(result.payment_intent_id).toBe('pi_prior');
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    // P2-2 — A stale `pending_<key>` sentinel must not 503 the retry
    // forever. createIntent should treat it as a stale reservation,
    // delete it, and mint a fresh PaymentIntent for the same idempotency
    // key.
    it('recovers from a stale pending_ sentinel by minting a new PaymentIntent', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(makePkg());
      prisma.guestCheckout.findUnique.mockResolvedValueOnce({
        id: 'gc-stale',
        package_id: 'pkg-1',
        guest_email: 'jane@example.com',
        status: 'pending',
        // The previous attempt crashed before Stripe responded.
        stripe_payment_intent_id: `pending_${IDEMP_KEY}`,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      });
      prisma.guestCheckout.deleteMany.mockResolvedValueOnce({ count: 1 });
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-fresh' });
      stripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_new',
        client_secret: 'pi_new_secret',
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});
      const result = await service.createIntent('tok123', baseDto);
      expect(result.payment_intent_id).toBe('pi_new');
      expect(prisma.guestCheckout.deleteMany).toHaveBeenCalled();
      expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it('marks the sentinel failed when Stripe rejects the PaymentIntent', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(makePkg());
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-3' });
      stripe.createPaymentIntent.mockRejectedValueOnce(
        new StripeConnectApiError(
          'card declined',
          402,
          'card_declined',
          'card_error',
        ),
      );
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      await expect(service.createIntent('tok123', baseDto)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.guestCheckout.updateMany).toHaveBeenCalledWith({
        where: { id: 'gc-3', status: 'pending' },
        data: { status: 'failed' },
      });
    });
  });

  describe('handlePaymentSucceeded', () => {
    it('is a no-op when no pending row exists (idempotent duplicate webhook)', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.handlePaymentSucceeded('pi_xyz');
      expect(prisma.guestCheckout.findUnique).not.toHaveBeenCalled();
    });

    // P2-4 — the atomic claim must reject rows whose checkout link has
    // already expired. A buyer holding a stale client secret cannot push
    // a paid status past expires_at.
    it('claims with expires_at gt now (P2-4)', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.handlePaymentSucceeded('pi_xyz');
      const call = prisma.guestCheckout.updateMany.mock.calls[0][0];
      expect(call.where.expires_at).toBeDefined();
      expect(call.where.expires_at.gt).toBeInstanceOf(Date);
    });

    // P1-4 — conversion must complete INLINE before the webhook returns.
    // The previous setImmediate path acknowledged Stripe before account
    // creation finished, so a crash between the claim and conversion
    // dropped the entitlement.
    it('runs convertGuestToUser inline (durable) and writes ClientPurchase + destination account', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      const checkoutRow = {
        id: 'gc-paid',
        package_id: 'pkg-1',
        package: {
          coach: { id: 'coach-1' },
          coach_id: 'coach-1',
          amount_cents: 29700,
          currency: 'usd',
          billing_type: 'one_time',
          name: 'Pack',
        },
        idempotency_key: IDEMP_KEY,
        guest_email: 'jane@example.com',
        guest_name: 'Jane',
        stripe_payment_intent_id: 'pi_xyz',
        stripe_customer_id: null,
        status: 'paid',
      };
      prisma.guestCheckout.findUnique
        .mockResolvedValueOnce(checkoutRow)
        .mockResolvedValueOnce(checkoutRow); // re-read inside convertGuestToUser
      supabaseAdminMock.createUser.mockResolvedValueOnce({
        data: { user: { id: 'sb-user-1' } },
        error: null,
      });
      prisma.connectAccount.findUnique.mockResolvedValueOnce({
        stripe_account_id: 'acct_dest',
      });
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce({
        id: 'usr-1',
        coach_id: 'coach-1',
      });
      prisma.clientPurchase.findFirst.mockResolvedValueOnce(null);
      prisma.clientPurchase.create.mockResolvedValueOnce({ id: 'cp-1' });
      prisma.guestCheckout.update.mockResolvedValueOnce({ id: 'gc-paid' });

      await service.handlePaymentSucceeded('pi_xyz');

      // Inline conversion: ClientPurchase create called WITHIN the
      // webhook turn (no setImmediate).
      expect(prisma.clientPurchase.create).toHaveBeenCalledTimes(1);
      const purchaseArgs = prisma.clientPurchase.create.mock.calls[0][0];
      // P2-5 — destination account persisted for reconciliation.
      expect(purchaseArgs.data.stripe_destination_account).toBe('acct_dest');
    });

    // Audit #3 P1-6 — when Supabase fails after Stripe took the money,
    // the row must flip to conversion_failed_retryable so the
    // reconciliation worker can pick it up. The previous terminal `failed`
    // semantics stranded paid customers without a retry path.
    it('flips checkout to conversion_failed_retryable when Supabase user creation fails', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      const checkoutRow = {
        id: 'gc-fail',
        package_id: 'pkg-1',
        package: {
          coach: { id: 'coach-1' },
          coach_id: 'coach-1',
          amount_cents: 29700,
          currency: 'usd',
          billing_type: 'one_time',
          name: 'Pack',
        },
        idempotency_key: IDEMP_KEY,
        guest_email: 'jane@example.com',
        guest_name: 'Jane',
        stripe_payment_intent_id: 'pi_fail',
        stripe_customer_id: null,
        status: 'paid',
        retry_count: 0,
      };
      prisma.guestCheckout.findUnique
        .mockResolvedValueOnce(checkoutRow) // claim-and-read inside handlePaymentSucceeded
        .mockResolvedValueOnce(checkoutRow) // inside convertGuestToUser pre-check
        .mockResolvedValueOnce(checkoutRow); // inside markRetryable retry_count read
      // Supabase admin throws an unrecoverable error.
      supabaseAdminMock.createUser.mockRejectedValueOnce(
        new Error('supabase down'),
      );
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.handlePaymentSucceeded('pi_fail');

      // Second updateMany call is markRetryable: paid → conversion_failed_retryable
      const markRetryableCall = prisma.guestCheckout.updateMany.mock.calls[1];
      expect(markRetryableCall[0].where).toEqual({
        id: 'gc-fail',
        status: { in: ['paid', 'conversion_failed_retryable'] },
      });
      expect(markRetryableCall[0].data.status).toBe('conversion_failed_retryable');
      expect(markRetryableCall[0].data.retry_count).toBe(1);
      expect(typeof markRetryableCall[0].data.last_error).toBe('string');
      expect(markRetryableCall[0].data.last_error).toMatch(/^supabase:/);
    });

    // Audit #3 P1-6 — after RECONCILIATION_MAX_ATTEMPTS (5) attempts the
    // row moves to conversion_failed_terminal and pages on-call. Tests
    // that the fifth attempt flips to terminal, not retryable.
    it('flips to conversion_failed_terminal after the retry cap', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      const checkoutRow = {
        id: 'gc-term',
        package_id: 'pkg-1',
        package: {
          coach: { id: 'coach-1' },
          coach_id: 'coach-1',
          amount_cents: 29700,
          currency: 'usd',
          billing_type: 'one_time',
          name: 'Pack',
        },
        idempotency_key: IDEMP_KEY,
        guest_email: 'jane@example.com',
        guest_name: 'Jane',
        stripe_payment_intent_id: 'pi_term',
        stripe_customer_id: null,
        status: 'paid',
        retry_count: 4, // one more failure pushes past the cap
      };
      prisma.guestCheckout.findUnique
        .mockResolvedValueOnce(checkoutRow)
        .mockResolvedValueOnce(checkoutRow)
        .mockResolvedValueOnce(checkoutRow); // markRetryable retry_count read
      supabaseAdminMock.createUser.mockRejectedValueOnce(
        new Error('supabase down'),
      );
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.handlePaymentSucceeded('pi_term');

      const markTerminalCall = prisma.guestCheckout.updateMany.mock.calls[1];
      expect(markTerminalCall[0].data.status).toBe('conversion_failed_terminal');
      expect(markTerminalCall[0].data.retry_count).toBe(5);
    });

    // P1-5 — listUsers must page beyond the first 200 users to find an
    // existing account, otherwise paid customers on page 2+ are stranded.
    it('finds existing Supabase user on page 2 when listUsers paginates', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      const checkoutRow = {
        id: 'gc-page2',
        package_id: 'pkg-1',
        package: {
          coach: { id: 'coach-1' },
          coach_id: 'coach-1',
          amount_cents: 29700,
          currency: 'usd',
          billing_type: 'one_time',
          name: 'Pack',
        },
        idempotency_key: IDEMP_KEY,
        guest_email: 'jane@example.com',
        guest_name: 'Jane',
        stripe_payment_intent_id: 'pi_p2',
        stripe_customer_id: null,
        status: 'paid',
      };
      prisma.guestCheckout.findUnique
        .mockResolvedValueOnce(checkoutRow)
        .mockResolvedValueOnce(checkoutRow);
      // createUser returns "already registered" — triggers listUsers
      // lookup of the existing account.
      supabaseAdminMock.createUser.mockResolvedValueOnce({
        data: null,
        error: { message: 'User already registered' },
      });
      // Page 1 — full page of non-matching users (forces pagination).
      const page1Users = Array.from({ length: 200 }).map((_, i) => ({
        id: `sb-${i}`,
        email: `other-${i}@example.com`,
      }));
      // Page 2 — contains the matching user.
      const page2Users = [
        { id: 'sb-other', email: 'someone@example.com' },
        { id: 'sb-match', email: 'jane@example.com' },
      ];
      supabaseAdminMock.listUsers
        .mockResolvedValueOnce({ data: { users: page1Users } })
        .mockResolvedValueOnce({ data: { users: page2Users } });
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce({
        id: 'usr-2',
        coach_id: 'coach-1',
      });
      prisma.clientPurchase.findFirst.mockResolvedValueOnce(null);
      prisma.clientPurchase.create.mockResolvedValueOnce({ id: 'cp-2' });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      await service.handlePaymentSucceeded('pi_p2');

      // listUsers called twice (page 1 and page 2).
      expect(supabaseAdminMock.listUsers).toHaveBeenCalledTimes(2);
      expect(supabaseAdminMock.listUsers.mock.calls[0][0].page).toBe(1);
      expect(supabaseAdminMock.listUsers.mock.calls[1][0].page).toBe(2);
      // User row created against the matched existing Supabase id.
      expect(prisma.user.create.mock.calls[0][0].data.supabase_id).toBe(
        'sb-match',
      );
    });

    it('never throws (webhook contract) on a Prisma failure', async () => {
      prisma.guestCheckout.updateMany.mockRejectedValueOnce(
        new Error('connection lost'),
      );
      await expect(
        service.handlePaymentSucceeded('pi_xyz'),
      ).resolves.toBeUndefined();
    });
  });

  describe('handlePaymentFailed', () => {
    it('transitions a pending row to failed', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      await service.handlePaymentFailed('pi_failed');
      expect(prisma.guestCheckout.updateMany).toHaveBeenCalledWith({
        where: { stripe_payment_intent_id: 'pi_failed', status: 'pending' },
        data: { status: 'failed' },
      });
    });

    it('swallows errors so the webhook returns 200', async () => {
      prisma.guestCheckout.updateMany.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(
        service.handlePaymentFailed('pi_x'),
      ).resolves.toBeUndefined();
    });
  });
});
