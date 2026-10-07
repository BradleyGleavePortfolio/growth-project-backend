// B-GUESTPAY-127: b#821 re-reads a not-ready coach from Stripe before the
// in-app Buy is refused. The share link (GET /v1/packages/public/join/:token,
// used by the web storefront and the app's PackageCheckoutScreen, and the
// guest POST .../checkout) still read only the saved ConnectAccount row, so a
// coach Stripe approved after onboarding kept refusing share-link buyers with
// "This coach is not currently accepting new clients." The share link now
// goes through the same ConnectService.refreshNotReady (cooldown, fallback).
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CheckoutService } from '../src/checkout/checkout.service';
import { ConnectService } from '../src/connect/connect.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiError, StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { ConnectPreflightService } from '../src/storefront/connect-preflight.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { StorefrontService } from '../src/storefront/storefront.service';
import { SupabaseService } from '../src/supabase/supabase.service';

type Row = Record<string, unknown>;

const TOKEN = 'tok1234567890abcDEFGH';
const KEY = '550e8400-e29b-41d4-a716-446655440000';
const DTO = { guest_name: 'Jane Smith', guest_email: 'jane@example.com', idempotency_key: KEY };

const STRIPE_APPROVED = {
  id: 'acct_coach',
  country: 'US',
  default_currency: 'usd',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  requirements: { currently_due: [], past_due: [], eventually_due: [], disabled_reason: null },
};
const STRIPE_STILL_CHECKING = {
  ...STRIPE_APPROVED,
  charges_enabled: false,
  payouts_enabled: false,
  requirements: { ...STRIPE_APPROVED.requirements, disabled_reason: 'requirements.pending_verification' },
};
const TIMEOUT = new StripeConnectApiError('timed out', 503, 'request_timeout', 'api_connection_error');

/** Stripe's answer when the saved row is re-read and the coach is not approved. */
function retrieveFor(outcome: 'still checking' | 'timeout' | 'network error'): jest.Mock {
  return jest.fn(async () => {
    if (outcome === 'still checking') return STRIPE_STILL_CHECKING;
    throw outcome === 'timeout' ? TIMEOUT : new TypeError('fetch failed');
  });
}

// What a new coach's row looks like when Stripe was still checking at the
// onboarding return and account.updated never reached the platform webhook.
function pendingAccount(): Row {
  return {
    coach_user_id: 'coach-1',
    stripe_account_id: 'acct_coach',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: true,
    requirements_due: { currently_due: [], past_due: [], eventually_due: [] },
    disabled_reason: 'requirements.pending_verification',
    deauthorized_at: null,
  };
}
const readyAccount = (): Row => ({
  ...pendingAccount(),
  charges_enabled: true,
  payouts_enabled: true,
  disabled_reason: null,
});

function makePkg(account: Row, overrides: Row = {}): Row {
  return {
    id: 'pkg-1',
    coach_id: 'coach-1',
    name: '12-Week Transformation',
    description: null,
    amount_cents: 29700,
    currency: 'usd',
    billing_type: 'one_time',
    interval: null,
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-09-01'),
    share_token: TOKEN,
    share_link_enabled: true,
    share_link_expires_at: null,
    share_link_revoked_at: null,
    coach: {
      id: 'coach-1',
      name: 'Coach One',
      deletion_scheduled_at: null,
      deleted_at: null,
      profile: null,
      coach_profile: null,
      connect_account: account,
    },
    ...overrides,
  };
}

/** A real ConnectService (b#821 refreshNotReady) over the same account row. */
function realConnect(account: Row, retrieveAccount: jest.Mock): ConnectService {
  const prisma = {
    connectAccount: {
      findUnique: jest.fn(async () => account),
      update: jest.fn(async ({ data }: { data: Row }) => ({ ...account, ...data })),
    },
  };
  return Reflect.construct(ConnectService, [prisma, { retrieveAccount }]);
}

async function storefront(account: Row, retrieveAccount: jest.Mock): Promise<StorefrontService> {
  const findUnique = jest.fn(async () => makePkg(account));
  const config = { get: (k: string) => (k === 'STRIPE_PUBLISHABLE_KEY' ? 'pk_test_platform' : undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      StorefrontService,
      { provide: PrismaService, useValue: { coachPackage: { findUnique } } },
      { provide: StripeConnectApiService, useValue: { retrieveAccount } },
      { provide: ConfigService, useValue: config },
      { provide: ConnectService, useValue: realConnect(account, retrieveAccount) },
    ],
  }).compile();
  return moduleRef.get(StorefrontService);
}

async function guestCheckout(account: Row, retrieveAccount: jest.Mock, pkgOverrides: Row = {}) {
  const stripe = {
    retrieveAccount,
    createPaymentIntent: jest.fn(async () => ({ id: 'pi_guest', client_secret: 'pi_guest_secret' })),
    createCustomer: jest.fn(async () => Promise.reject(new Error('STOP_AFTER_GATE'))),
  };
  const prisma = {
    coachPackage: { findUnique: jest.fn(async () => makePkg(account, pkgOverrides)) },
    coachLandingPage: { findFirst: jest.fn(async () => null) },
    guestCheckout: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'gc-1', idempotency_key: KEY })),
      update: jest.fn(async () => ({ id: 'gc-1' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const preflight = {
    getReadiness: jest.fn(async () => ({
      charges_enabled: true,
      disabled_reason: null,
      supports_apple_pay: false,
      supports_google_pay: false,
    })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      { provide: PrismaService, useValue: prisma },
      { provide: StripeConnectApiService, useValue: stripe },
      { provide: SupabaseService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: NotificationsService, useValue: {} },
      { provide: CheckoutService, useValue: {} },
      { provide: FeePolicyService, useValue: {} },
      { provide: ConnectPreflightService, useValue: preflight },
      { provide: ConnectService, useValue: realConnect(account, retrieveAccount) },
    ],
  }).compile();
  return { svc: moduleRef.get(GuestCheckoutService), stripe };
}

async function errorOf(p: Promise<unknown>): Promise<{ error?: string } | string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NotFoundException) return err.getResponse() as { error?: string };
    return err instanceof Error ? err.message : 'unknown';
  }
  return 'NO_ERROR';
}

const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
afterAll(() => warn.mockRestore());

describe('B-GUESTPAY-127 share-link page (GET /v1/packages/public/join/:token)', () => {
  it('saved row pending + Stripe approved -> the page loads and the coach reads verified', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const svc = await storefront(pendingAccount(), retrieve);
    const page = await svc.getPublicPackageByToken(TOKEN);
    expect(page.package_id).toBe('pkg-1');
    expect(page.coach.verified).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('saved row ready -> zero Stripe account reads', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const svc = await storefront(readyAccount(), retrieve);
    expect((await svc.getPublicPackageByToken(TOKEN)).coach.verified).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each(['still checking', 'timeout'] as const)('Stripe %s -> today\'s PACKAGE_UNAVAILABLE', async (outcome) => {
    const svc = await storefront(pendingAccount(), retrieveFor(outcome));
    expect(await errorOf(svc.getPublicPackageByToken(TOKEN))).toMatchObject({ error: 'PACKAGE_UNAVAILABLE' });
  });

  it('deauthorized coach -> no Stripe read, still unavailable', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const svc = await storefront({ ...pendingAccount(), deauthorized_at: new Date('2026-10-01') }, retrieve);
    expect(await errorOf(svc.getPublicPackageByToken(TOKEN))).toMatchObject({ error: 'PACKAGE_UNAVAILABLE' });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe('B-GUESTPAY-127 guest Buy (POST /v1/packages/public/join/:token/checkout)', () => {
  it('saved row pending + Stripe approved -> the PaymentIntent is minted for the coach', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc, stripe } = await guestCheckout(pendingAccount(), retrieve);
    const out = await svc.createIntent(TOKEN, DTO);
    expect(out).toMatchObject({ payment_intent_id: 'pi_guest', client_secret: 'pi_guest_secret' });
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ onBehalfOf: 'acct_coach', amount: 29700 }),
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('recurring package, saved row pending + Stripe approved -> passes the gate to the subscription mint', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc, stripe } = await guestCheckout(pendingAccount(), retrieve, {
      billing_type: 'recurring',
      interval: 'month',
    });
    expect(await errorOf(svc.createIntent(TOKEN, DTO))).toBe('STOP_AFTER_GATE');
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
  });

  it('saved row ready -> zero Stripe account reads', async () => {
    const retrieve = jest.fn(async () => STRIPE_APPROVED);
    const { svc, stripe } = await guestCheckout(readyAccount(), retrieve);
    await svc.createIntent(TOKEN, DTO);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it.each(['still checking', 'timeout', 'network error'] as const)(
    'Stripe %s -> today\'s PACKAGE_UNAVAILABLE, nothing charged',
    async (outcome) => {
      const { svc, stripe } = await guestCheckout(pendingAccount(), retrieveFor(outcome));
      expect(await errorOf(svc.createIntent(TOKEN, DTO))).toMatchObject({ error: 'PACKAGE_UNAVAILABLE' });
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    },
  );
});
