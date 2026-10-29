import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma.service';
import { PackagesService } from '../src/packages/packages.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { StorefrontService } from '../src/storefront/storefront.service';

describe('LS-1TO1: web and in-app share one coaching seller rule', () => {
  it.each([
    ['former coach', { role: 'student' }],
    ['unnamed coach', { name: '' }],
    ['leaving coach', { deletion_scheduled_at: new Date() }],
  ])('refuses web display and payment for a %s already refused in-app', async (_label, invalid) => {
    const coach = {
      id: 'coach', role: 'coach', name: 'Coach Lee', deleted_at: null,
      deletion_confirmed_at: null, deletion_scheduled_at: null,
      connect_account: {
        stripe_account_id: 'test-account', charges_enabled: true,
        payouts_enabled: true, details_submitted: true, disabled_reason: null,
      },
    };
    const pkg = {
      id: 'package', coach_id: coach.id, name: 'Coaching', description: null,
      amount_cents: 4900, currency: 'usd', billing_type: 'one_time',
      interval: null, interval_count: 1, duration_periods: null,
      recurring_amount_cents: null, is_active: true, archived_at: null,
      published_at: new Date(), share_link_enabled: true, coach,
      share_link_revoked_at: null, share_link_expires_at: null,
    };
    // Honor the relation predicates actually sent to Prisma, rather than
    // ignoring them. The same stored account is used by all three services.
    const findUnique = jest.fn(async ({ where }: { where: {
      coach?: { role?: { in: string[] }; name?: { not: string }; deletion_scheduled_at?: null };
    } }) => {
      const rule = where.coach;
      if (rule?.role?.in && !rule.role.in.includes(coach.role)) return null;
      if (rule?.name?.not === '' && coach.name === '') return null;
      if (rule?.deletion_scheduled_at === null && coach.deletion_scheduled_at) return null;
      return pkg;
    });
    const db = {
      coachPackage: { findUnique },
      user: { findFirst: jest.fn(async () => null) },
      coachProfile: { findUnique: jest.fn(async () => null) },
      guestCheckout: {
        create: jest.fn(async () => ({ id: 'guest' })),
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => ({})),
        delete: jest.fn(async () => ({})),
      },
    } as unknown as PrismaService;
    const config = new ConfigService({ STRIPE_PUBLISHABLE_KEY: 'test-public-value' });
    const packages = new PackagesService(db, {} as SubCoachScopeService);
    const display = new StorefrontService(db, {} as never, config);
    const createIntent = jest.fn(async () => ({
      client_secret: 'test-confirmation', id: 'test-payment',
    }));
    const checkout = new GuestCheckoutService(
      db, { createPaymentIntent: createIntent } as never, {} as never,
      config, {} as never, { preflightWebSale: jest.fn() } as never,
      { getPercent: () => 2 } as never,
    );
    const input = {
      guest_email: 'new-buyer@example.test', guest_name: 'Buyer',
      guest_phone: '+14155550100', idempotency_key: 'test-idempotency',
    };
    const share = 'A'.repeat(21);
    await expect(display.getPublicPackageByToken(share)).resolves.toMatchObject({ package_id: pkg.id });
    await expect(checkout.createIntent(share, input)).resolves.toMatchObject({
      payment_intent_id: 'test-payment',
    });
    Object.assign(coach, invalid);
    await expect(packages.getById(pkg.id, 'buyer')).resolves.toBeNull();
    // Both normal web entry points must now refuse this same account.
    const outcomes = await Promise.allSettled([
      display.getPublicPackageByToken(share), checkout.createIntent(share, input),
    ]);
    expect(outcomes.map((outcome) => (
      outcome.status === 'rejected' && outcome.reason instanceof NotFoundException
    ))).toEqual([true, true]);
    expect(createIntent).toHaveBeenCalledTimes(1);
  });
});
