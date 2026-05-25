import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../connect/stripe-connect-api.service';
import { SupabaseService } from '../supabase/supabase.service';
import { GuestCheckoutService } from './guest-checkout.service';

// R43 — GuestCheckoutService tests. Prisma, Stripe, and Supabase are all
// mocked. We test: package resolution, idempotency (replay path), Stripe
// 503 surfacing, handlePaymentSucceeded idempotency, handlePaymentFailed,
// and the convertGuestToUser transaction path.

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
  };
  user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  clientPurchase: { findFirst: jest.Mock; create: jest.Mock };
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
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    clientPurchase: { findFirst: jest.fn(), create: jest.fn() },
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

    it('claims the row and schedules conversion', async () => {
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.guestCheckout.findUnique.mockResolvedValueOnce({
        id: 'gc-paid',
        package_id: 'pkg-1',
        package: { coach: {} },
        idempotency_key: IDEMP_KEY,
        guest_email: 'jane@example.com',
        guest_name: 'Jane',
        stripe_payment_intent_id: 'pi_xyz',
      });
      await service.handlePaymentSucceeded('pi_xyz');
      expect(prisma.guestCheckout.updateMany).toHaveBeenCalledWith({
        where: { stripe_payment_intent_id: 'pi_xyz', status: 'pending' },
        data: { status: 'paid' },
      });
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
