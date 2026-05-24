/**
 * ConnectAccountService — unit tests
 *
 * Tests are written against the public API of ConnectAccountService.
 * The Stripe HTTP calls are replaced by jest.spyOn so tests remain
 * hermetic and never touch the Stripe API.
 */

import {
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConnectAccountService } from '../src/talent-marketplace/connect-account.service';
import { PrismaService } from '../src/prisma.service';

function makePrismaService(): PrismaService {
  return {
    coachConnectAccount: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe('ConnectAccountService', () => {
  let service: ConnectAccountService;
  let prisma: PrismaService;
  let stripePostSpy: jest.SpyInstance;
  let stripeFetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    prisma = makePrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConnectAccountService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConnectAccountService>(ConnectAccountService);

    // Spy on the protected Stripe helpers so tests stay hermetic.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stripePostSpy = jest.spyOn(service as any, 'stripePost');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stripeFetchSpy = jest.spyOn(service as any, 'stripeFetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createConnectAccount', () => {
    it('returns existing stripe_account_id if account already exists', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_existing',
      });

      const result = await service.createConnectAccount('user-1');

      expect(result).toBe('acct_existing');
      expect(stripePostSpy).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when user does not exist', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.createConnectAccount('bad-user')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('creates a Stripe account and persists it', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        email: 'coach@example.com',
      });
      stripePostSpy.mockResolvedValue({
        id: 'acct_new123',
        country: 'US',
        default_currency: 'usd',
      });
      (prisma.coachConnectAccount.create as jest.Mock).mockResolvedValue({
        id: 'row-1',
        stripe_account_id: 'acct_new123',
      });

      const result = await service.createConnectAccount('user-1');

      expect(stripePostSpy).toHaveBeenCalledWith(
        '/accounts',
        expect.any(URLSearchParams),
        'stripe-connect-user-1',
      );
      expect(prisma.coachConnectAccount.create).toHaveBeenCalled();
      expect(result).toBe('acct_new123');
    });
  });

  describe('createOnboardingLink', () => {
    it('returns the Stripe-hosted onboarding URL', async () => {
      // createConnectAccount path — existing account
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_exist',
      });
      stripePostSpy.mockResolvedValue({
        url: 'https://connect.stripe.com/express/onboarding/abc123',
        expires_at: 9999999999,
      });

      const result = await service.createOnboardingLink('user-1');

      expect(result.url).toMatch(/stripe\.com/);
    });
  });

  describe('getAccountStatus', () => {
    it('returns null when no account exists', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.getAccountStatus('user-1');

      expect(result).toBeNull();
    });

    it('refreshes capabilities from Stripe when onboarding is incomplete', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_123',
        onboarding_completed: false,
        capabilities: null,
      });
      stripeFetchSpy.mockResolvedValue({
        id: 'acct_123',
        details_submitted: true,
        capabilities: { transfers: 'active', card_payments: 'active' },
      });
      (prisma.coachConnectAccount.update as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_123',
        onboarding_completed: true,
        capabilities: { transfers: 'active' },
      });

      const result = await service.getAccountStatus('user-1');

      expect(stripeFetchSpy).toHaveBeenCalledWith('/accounts/acct_123');
      expect(prisma.coachConnectAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ onboarding_completed: true }),
        }),
      );
      expect(result?.onboarding_completed).toBe(true);
    });

    it('does not call Stripe when onboarding is already completed', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_done',
        onboarding_completed: true,
        capabilities: { transfers: 'active' },
      });

      await service.getAccountStatus('user-1');

      expect(stripeFetchSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Error sanitization + race + timeout ──────────────────────────────────
  //
  // These tests exercise the low-level fetch wrapper, so they run against a
  // fresh service whose Stripe spies are restored. We mock `fetch` globally
  // and the `STRIPE_SECRET_KEY` env var.

  describe('error sanitization, race, and timeout', () => {
    let bareService: ConnectAccountService;
    let barePrisma: PrismaService;
    let originalFetch: typeof globalThis.fetch | undefined;
    let originalKey: string | undefined;

    beforeEach(async () => {
      barePrisma = makePrismaService();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ConnectAccountService,
          { provide: PrismaService, useValue: barePrisma },
        ],
      }).compile();
      bareService = module.get(ConnectAccountService);

      originalFetch = globalThis.fetch;
      originalKey = process.env['STRIPE_SECRET_KEY'];
      process.env['STRIPE_SECRET_KEY'] = 'sk_test_dummy';
    });

    afterEach(() => {
      if (originalFetch) globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env['STRIPE_SECRET_KEY'];
      else process.env['STRIPE_SECRET_KEY'] = originalKey;
    });

    it('throws InternalServerError with a safe code when STRIPE_SECRET_KEY is unset', async () => {
      delete process.env['STRIPE_SECRET_KEY'];
      (barePrisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);
      (barePrisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'a@b.com',
      });

      let caught: unknown;
      try {
        await bareService.createConnectAccount('user-1');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InternalServerErrorException);
      const msg = (caught as InternalServerErrorException).message;
      // The client-facing message must NOT name the env var.
      expect(msg).not.toMatch(/STRIPE_SECRET_KEY/);
      expect(msg).toBe('CONNECT_ONBOARDING_UNAVAILABLE');
    });

    it('returns a safe PAYMENTS_PROVIDER_ERROR on Stripe 4xx and never leaks raw Stripe text', async () => {
      (barePrisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);
      (barePrisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'a@b.com',
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({
          error: {
            type: 'invalid_request_error',
            code: 'parameter_invalid_string',
            message: 'Your secret key sk_test_... is malformed',
          },
        }),
      }) as unknown as typeof globalThis.fetch;

      let caught: unknown;
      try {
        await bareService.createConnectAccount('user-1');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      const msg = (caught as ServiceUnavailableException).message;
      expect(msg).toBe('PAYMENTS_PROVIDER_ERROR');
      expect(msg).not.toMatch(/secret key/i);
      expect(msg).not.toMatch(/sk_test_/);
    });

    it('returns PAYMENTS_PROVIDER_TIMEOUT when the Stripe request aborts', async () => {
      (barePrisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue(null);
      (barePrisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'a@b.com',
      });
      // Simulate the AbortController firing.
      globalThis.fetch = jest.fn().mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }) as unknown as typeof globalThis.fetch;

      await expect(bareService.createConnectAccount('user-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('resolves a unique-constraint race to the winning row', async () => {
      const findUnique = barePrisma.coachConnectAccount.findUnique as jest.Mock;
      findUnique.mockResolvedValueOnce(null); // first check — no row yet
      findUnique.mockResolvedValueOnce({
        stripe_account_id: 'acct_winner',
      });
      (barePrisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'a@b.com',
      });
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'acct_winner',
          country: 'US',
          default_currency: 'usd',
        }),
      }) as unknown as typeof globalThis.fetch;
      (barePrisma.coachConnectAccount.create as jest.Mock).mockRejectedValue({
        code: 'P2002',
      });

      const result = await bareService.createConnectAccount('user-1');
      expect(result).toBe('acct_winner');
    });
  });
});
