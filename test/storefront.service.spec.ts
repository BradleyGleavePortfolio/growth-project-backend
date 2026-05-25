import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { StorefrontService } from '../src/storefront/storefront.service';

// R43 — StorefrontService unit tests. Prisma + Stripe Connect API are
// stubbed so the suite is hermetic.

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pkg-1',
    name: '12-Week Transformation',
    description: 'Complete body recomp.',
    amount_cents: 29700,
    currency: 'usd',
    // Audit #4 P2-5 — Phase 1 storefront only exposes one-time USD
    // packages. Test fixture matches the only billing_type the public
    // GET will ever serve.
    billing_type: 'one_time',
    interval: null,
    interval_count: 1,
    is_active: true,
    archived_at: null,
    share_token: 'tok1234567890abcDEFGH',
    share_link_enabled: true,
    // Audit #4 P2-4 — fixture defaults to non-expired and non-revoked.
    share_link_expires_at: null,
    share_link_revoked_at: null,
    coach: {
      id: 'coach-1',
      name: 'Bradley Gleave',
      // Audit #4 P1-7 — fixture must include the GDPR deletion fields
      // so the public-GET gate is exercised; the default coach is alive.
      deletion_scheduled_at: null,
      deleted_at: null,
      profile: { avatar_url: 'https://cdn.example/avatar.jpg' },
      coach_profile: { bio: 'Ex-athlete. 500+ clients.' },
      connect_account: {
        stripe_account_id: 'acct_test',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: null,
      },
    },
    ...overrides,
  };
}

describe('StorefrontService', () => {
  let service: StorefrontService;
  let findUnique: jest.Mock;
  let retrieveAccount: jest.Mock;
  let configGet: jest.Mock;

  beforeEach(async () => {
    findUnique = jest.fn();
    retrieveAccount = jest.fn();
    configGet = jest.fn((key: string) => {
      if (key === 'STRIPE_PUBLISHABLE_KEY') return 'pk_live_platform';
      if (key === 'STOREFRONT_BASE_URL') return 'https://joingrowthproject.com';
      return undefined;
    });
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
          useValue: { get: configGet },
        },
      ],
    }).compile();
    service = module.get(StorefrontService);
  });

  it('returns the public package payload for a valid token', async () => {
    findUnique.mockResolvedValueOnce(makePkg());
    const data = await service.getPublicPackageByToken('tok1234567890abcDEFGH');
    expect(data.package_id).toBe('pkg-1');
    expect(data.package_name).toBe('12-Week Transformation');
    expect(data.price_cents).toBe(29700);
    expect(data.billing_cycle).toBe('one_time');
    expect(data.coach.display_name).toBe('Bradley Gleave');
    expect(data.coach.verified).toBe(true);
    expect(data.features).toEqual([]);
  });

  // P1-1 — destination-charge PaymentIntents live on the PLATFORM account, so
  // the storefront must confirm with the platform publishable key. The
  // connected-account publishable key from /accounts/{acct} is the wrong
  // context and Stripe.js refuses to confirm with it.
  it('returns the PLATFORM publishable key (not the connected account key)', async () => {
    findUnique.mockResolvedValueOnce(makePkg());
    const data = await service.getPublicPackageByToken('tok1234567890abcDEFGH');
    expect(data.stripe_publishable_key).toBe('pk_live_platform');
    // Must not have called Stripe to fetch a connected-account key.
    expect(retrieveAccount).not.toHaveBeenCalled();
  });

  it('returns 503 when STRIPE_PUBLISHABLE_KEY is unset', async () => {
    configGet.mockImplementation((key: string) =>
      key === 'STRIPE_PUBLISHABLE_KEY' ? undefined : 'https://joingrowthproject.com',
    );
    findUnique.mockResolvedValueOnce(makePkg());
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('404s when the token does not resolve to a package', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(
      // 21-char nanoid-shape token that no row matches
      service.getPublicPackageByToken('NONEXISTENT_TOKEN_AAAA'.slice(0, 21)),
    ).rejects.toThrow(NotFoundException);
  });

  // P1-3 / P2-1 — malformed token shapes must 404 before Prisma is even
  // queried. This blocks path-traversal probes, length sweeps, and
  // alphabet bruteforce attempts from hitting the database.
  it.each([
    ['empty', ''],
    ['too short', 'short'],
    ['too long', 'A'.repeat(22)],
    ['path-traversal characters', '../../../etc/passwd'],
    ['spaces', 'aaaaaaaaa aaaaaaaaaaaa'],
    ['unicode', 'éééééééééééééééééééée'],
  ])('rejects malformed tokens (%s) without touching the DB', async (_label, token) => {
    await expect(
      service.getPublicPackageByToken(token as string),
    ).rejects.toThrow(NotFoundException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('404s when share_link_enabled is false', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ share_link_enabled: false }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the package is inactive or archived', async () => {
    findUnique.mockResolvedValueOnce(makePkg({ is_active: false }));
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
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
            payouts_enabled: false,
            details_submitted: false,
            disabled_reason: null,
          },
        },
      }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  // Audit #3 P1-8 — readiness gate must fail on each axis individually,
  // not just on charges_enabled. Each branch surfaces the same generic
  // 404 so the public can't enumerate which axis blocked the coach.
  it.each([
    ['payouts_enabled false', { payouts_enabled: false }],
    ['details_submitted false', { details_submitted: false }],
    ['disabled_reason set', { disabled_reason: 'rejected.terms_of_service' }],
  ])('404s when %s', async (_label, partial) => {
    findUnique.mockResolvedValueOnce(
      makePkg({
        coach: {
          ...makePkg().coach,
          connect_account: {
            ...makePkg().coach.connect_account,
            ...partial,
          },
        },
      }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  it('maps billing cycle to one_time (Phase 1 one-time only)', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ billing_type: 'one_time', interval: null, interval_count: 1 }),
    );
    const oneTime = await service.getPublicPackageByToken('tok1234567890abcDEFGH');
    expect(oneTime.billing_cycle).toBe('one_time');
  });

  // Audit #4 P2-5 — public GET MUST 404 recurring packages so we do
  // not leak their existence on a share-token enumeration scan.
  it.each(['recurring'])(
    'P2-5: 404s on billing_type=%s',
    async (billing_type) => {
      findUnique.mockResolvedValueOnce(
        makePkg({ billing_type, interval: 'month' }),
      );
      await expect(
        service.getPublicPackageByToken('tok1234567890abcDEFGH'),
      ).rejects.toThrow(NotFoundException);
    },
  );

  // Audit #4 P2-5 — public GET MUST 404 non-USD packages.
  it.each(['eur', 'gbp', 'jpy'])(
    'P2-5: 404s on currency=%s',
    async (currency) => {
      findUnique.mockResolvedValueOnce(makePkg({ currency }));
      await expect(
        service.getPublicPackageByToken('tok1234567890abcDEFGH'),
      ).rejects.toThrow(NotFoundException);
    },
  );

  // Audit #4 P1-7 — a deleted or grace-period-locked coach MUST NOT
  // be exposed on the storefront. 404 mirrors token-not-found so
  // existence is not leaked.
  it('P1-7: 404s when coach has deletion_scheduled_at set', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({
        coach: {
          ...makePkg().coach,
          deletion_scheduled_at: new Date(),
          deleted_at: null,
        },
      }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  // Audit #4 P2-4 — a revoked or expired share token MUST 404 even
  // when share_link_enabled is true.
  it('P2-4: 404s when share_link_revoked_at is set', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ share_link_revoked_at: new Date() }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  it('P2-4: 404s when share_link_expires_at is in the past', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({ share_link_expires_at: new Date(Date.now() - 1000) }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });

  it('P2-4: still serves when share_link_expires_at is in the future', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({
        share_link_expires_at: new Date(Date.now() + 24 * 3600 * 1000),
      }),
    );
    const data = await service.getPublicPackageByToken(
      'tok1234567890abcDEFGH',
    );
    expect(data.package_id).toBe('pkg-1');
  });

  it('P1-7: 404s when coach has deleted_at set', async () => {
    findUnique.mockResolvedValueOnce(
      makePkg({
        coach: {
          ...makePkg().coach,
          deletion_scheduled_at: null,
          deleted_at: new Date(),
        },
      }),
    );
    await expect(
      service.getPublicPackageByToken('tok1234567890abcDEFGH'),
    ).rejects.toThrow(NotFoundException);
  });
});
