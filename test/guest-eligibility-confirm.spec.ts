/**
 * GUEST-ELIGIBILITY 2 (owner #170-2) — a new buyer, after paying: the invite
 * link confirms the email and lands on the pay page's confirm-and-download
 * state (/p/<token>?confirmed=1) when the pay page is on, and the
 * post-checkout email is the approved confirm email (A6.0-170).
 */
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';

type Svc = {
  generateInviteLink(email: string, shareToken?: string | null): Promise<string | null>;
  sendWelcomeEmail(checkout: unknown, inviteLink: string | null): Promise<void>;
};

async function service(env: Record<string, string | undefined>) {
  const generateLink = jest.fn(async () => ({
    data: { properties: { action_link: 'https://sb.example/auth/v1/verify?token=t&type=invite' } },
    error: null,
  }));
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      { provide: PrismaService, useValue: {} },
      { provide: StripeConnectApiService, useValue: {} },
      { provide: SupabaseService, useValue: { getClient: () => ({ auth: { admin: { generateLink } } }) } },
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      { provide: NotificationsService, useValue: {} },
      { provide: CheckoutService, useValue: {} },
      { provide: FeePolicyService, useValue: {} },
    ],
  }).compile();
  return { svc: moduleRef.get(GuestCheckoutService) as unknown as Svc, generateLink };
}

const checkout = {
  id: 'gc-1',
  guest_email: 'ann@example.com',
  guest_name: 'Ann Buyer',
  package: { name: '12-Week Transformation', coach: { name: 'Coach One' } },
};

describe('GUEST-ELIGIBILITY 2 — the new buyer confirms the email, then lands on download + login', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('pay page on: the invite link redirects to /p/<token>?confirmed=1 on the storefront origin', async () => {
    const { svc, generateLink } = await service({ GUEST_PAY_PAGE_ENABLED: 'true' });
    await svc.generateInviteLink('ann@example.com', 'tok A/1');
    expect(generateLink).toHaveBeenCalledWith({
      type: 'invite',
      email: 'ann@example.com',
      options: { redirectTo: 'https://app.trygrowthproject.com/p/tok%20A%2F1?confirmed=1' },
    });
  });

  it.each([
    ['pay page off', { GUEST_PAY_PAGE_ENABLED: 'false' }, 'tokA'],
    ['no share token', { GUEST_PAY_PAGE_ENABLED: 'true' }, null],
  ])('%s: the invite link is unchanged (Supabase Site URL)', async (_l, env, token) => {
    const { svc, generateLink } = await service(env);
    await svc.generateInviteLink('ann@example.com', token);
    expect(generateLink).toHaveBeenCalledWith({ type: 'invite', email: 'ann@example.com' });
  });

  async function sent(inviteLink: string | null) {
    const { svc } = await service({ RESEND_API_KEY: 're_test', EMAIL_FROM_ADDRESS: 'TGP Fitness <hello@trygrowthproject.com>' });
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = fetchMock as never;
    await svc.sendWelcomeEmail(checkout, inviteLink);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { subject: string; html: string };
  }

  it('new account: the approved confirm email (subject, button, fallback line)', async () => {
    const mail = await sent('https://sb.example/auth/v1/verify?token=t&type=invite');
    expect(mail.subject).toBe('Confirm your email to start with Coach One on TGP Fitness');
    expect(mail.html).toContain("Confirm this is your email, and we'll finish setting up your TGP Fitness account.");
    expect(mail.html).toContain('>Confirm my email</a>');
    expect(mail.html).toContain('href="https://sb.example/auth/v1/verify?token=t&amp;type=invite"');
    expect(mail.html).toContain('The link works for 24 hours. If it runs out, open the TGP Fitness app, tap Forgot password? and enter <strong>ann@example.com</strong>.');
    expect(mail.html).not.toContain('Activate your account');
  });

  it('existing account (no invite link): unchanged sign-in nudge and subject', async () => {
    const mail = await sent(null);
    expect(mail.subject).toBe('Coach One is ready for you on Growth Project');
    expect(mail.html).toContain('to your existing Growth Project account');
    expect(mail.html).not.toContain('Confirm my email');
  });
});
