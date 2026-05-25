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
import { StorefrontService } from './storefront.service';

// R43 — StorefrontService unit tests. Prisma + Stripe Connect API are
// stubbed so the suite is hermetic.

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pkg-1',
    name: '12-Week Transformation',
    description: 'Complete body recomp.',
    amount_cents: 29700,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
    is_active: true,
    archived_at: null,
    share_token: 'tok123',
    share_link_enabled: true,
    coach: {
      id: 'coach-1',
      name: 'Bradley Gleave',
      profile: { avatar_url: 'https://cdn.example/avatar.jpg' },
      coach_profile: { bio: 'Ex-athlete. 500+ clients.' },
      connect_account: {
        stripe_account_id: 'acct_test',
        charges_enabled: true,
        details_submitted: true,
      },
    },
    ...overrides,
  };
}

describe('StorefrontService', () => {
  let service: StorefrontService;
  let findUnique: jest.Mock;
  let retrieveAccount: jest.Mock;

  beforeEach(async () => {
    findUnique = jest.fn();
    retrieveAccount = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorefrontService,
        {
          provide: PrismaService,
          useValue: { coachPackage: { findUnique } },
        },
        {
          provide: StripeConnectApiService,
          useValue: { retrieveAccount },
        },
        {
          provide: ConfigService,
          useValue: { get: () => 'https://tgp.app' },
        },
      ],
    }).compile();
    service = module.get(StorefrontService);
  });

  it('returns the public package payload for a valid token', async () => {
    findUnique.mockResolvedValueOnce(makePkg());
    retrieveAccount.mockResolvedValueOnce({ publishable_key: 'pk_live_x' });
    const data = await service.getPublicPackageByToken('tok123');
    expect(data.package_id).toBe('pkg-1');
    expect(data.package_name).toBe('12-Week Transformation');
    expect(data.price_cents).toBe(29700);
    expect(data.billing_cycle).toBe('monthly');
    expect(data.coach.display_name).toBe('Bradley Gleave');
    expect(data.coach.verified).toBe(true);
    expect(data.stripe_publishable_key).toBe('pk_live_x');
    expect(data.features).toEqual([]);
  });

  it('serves the publishable key from cache on the second call', async () => {
    findUnique.mockResolvedValue(makePkg());
    retrieveAccount.mockResolvedValueOnce({ publishable_key: 'pk_live_x' });
    await service.getPublicPackageByToken('tok123');
    await service.getPublicPackageByToken('tok123');
    expect(retrieveAccount).toHaveBeenCalledTimes(1);
  });

  it('404s when the token does not resolve to a package', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(
      service.getPublicPackageByToken('missing'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when share_link_enabled is false', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ share_link_enabled: false }),
    );
    await expect(
      service.getPublicPackageByToken('tok123'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the package is inactive or archived', async () => {
    findUnique.mockResolvedValueOnce(makePkg({ is_active: false }));
    await expect(
      service.getPublicPackageByToken('tok123'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the coach has no Connect account or charges disabled', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({
        coach: {
          ...makePkg().coach,
          connect_account: {
            stripe_account_id: 'acct_x',
            charges_enabled: false,
            details_submitted: false,
          },
        },
      }),
    );
    await expect(
      service.getPublicPackageByToken('tok123'),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns 503 when Stripe fails to provide a publishable key', async () => {
    findUnique.mockResolvedValueOnce(makePkg());
    retrieveAccount.mockRejectedValueOnce(
      new StripeConnectApiError('stripe down', 503, 'api_error', 'api_error'),
    );
    await expect(
      service.getPublicPackageByToken('tok123'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('maps billing cycles correctly', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ billing_type: 'recurring', interval: 'year', interval_count: 1 }),
    );
    retrieveAccount.mockResolvedValueOnce({ publishable_key: 'pk_test' });
    const annual = await service.getPublicPackageByToken('tok123');
    expect(annual.billing_cycle).toBe('annual');

    findUnique.mockResolvedValueOnce(
      makePkg({
        billing_type: 'recurring',
        interval: 'month',
        interval_count: 3,
      }),
    );
    const quarterly = await service.getPublicPackageByToken('tok123');
    expect(quarterly.billing_cycle).toBe('quarterly');

    findUnique.mockResolvedValueOnce(
      makePkg({ billing_type: 'one_time', interval: null, interval_count: 1 }),
    );
    const oneTime = await service.getPublicPackageByToken('tok123');
    expect(oneTime.billing_cycle).toBe('one_time');
  });
});
