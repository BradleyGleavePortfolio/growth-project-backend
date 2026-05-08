/**
 * ConnectAccountService — unit tests
 *
 * The Stripe HTTP calls are mocked at the `fetch` level (jest.spyOn on global
 * fetch) so tests remain hermetic and never touch the Stripe API.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConnectAccountService } from './connect-account.service';
import { PrismaService } from '../prisma.service';

// Helper to build a testable ConnectAccountService subclass that exposes
// the protected stripePost / stripeFetch as public for easier mocking.
class TestableConnectAccountService extends ConnectAccountService {
  public override stripePost = jest.fn();
  public override stripeFetch = jest.fn();
}

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
  let service: TestableConnectAccountService;
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = makePrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ConnectAccountService, useClass: TestableConnectAccountService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ConnectAccountService>(
      ConnectAccountService,
    ) as TestableConnectAccountService;
  });

  describe('createConnectAccount', () => {
    it('returns existing stripe_account_id if account already exists', async () => {
      (prisma.coachConnectAccount.findUnique as jest.Mock).mockResolvedValue({
        stripe_account_id: 'acct_existing',
      });

      const result = await service.createConnectAccount('user-1');

      expect(result).toBe('acct_existing');
      expect(service.stripePost).not.toHaveBeenCalled();
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
      (service.stripePost as jest.Mock).mockResolvedValue({
        id: 'acct_new123',
        country: 'US',
        default_currency: 'usd',
      });
      (prisma.coachConnectAccount.create as jest.Mock).mockResolvedValue({
        id: 'row-1',
        stripe_account_id: 'acct_new123',
      });

      const result = await service.createConnectAccount('user-1');

      expect(service.stripePost).toHaveBeenCalledWith(
        '/accounts',
        expect.any(URLSearchParams),
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
      (service.stripePost as jest.Mock).mockResolvedValue({
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
      (service.stripeFetch as jest.Mock).mockResolvedValue({
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

      expect(service.stripeFetch).toHaveBeenCalledWith('/accounts/acct_123');
      expect(prisma.coachConnectAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ onboarding_completed: true }),
        }),
      );
      expect(result?.onboarding_completed).toBe(true);
    });
  });
});
