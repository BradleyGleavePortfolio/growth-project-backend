import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { mintBuyerToken, recoverySecretKey } from '../src/storefront/buyer-check';
import { CheckoutRecoveryService } from '../src/storefront/checkout-recovery.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';

// LO-1201 lens (item 3): the checkout-time customer reuse, through the real
// createIntent gate. Who can land on which Stripe customer, and whether the
// reuse changes what, when or how the plan is charged.

type Row = Record<string, any>;
const TOKEN = 'tok1234567890abcDEFGH';
const COACH = 'coach-1';
const SECRET = 'y'.repeat(48);
const KEY = '7f0c2a1e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const config: any = { get: (k: string) => (k === 'CHECKOUT_RECOVERY_SECRET' ? SECRET : undefined) };

const ACCOUNTS: Record<string, Row> = {
  'mine@example.com': { id: 'u-me', name: 'Sam Lee', role: 'student', coach_id: COACH },
  'nocoach@example.com': { id: 'u-nc', name: 'Nia Cole', role: 'student', coach_id: null },
  'other@example.com': { id: 'u-ot', name: 'Ola Diaz', role: 'student', coach_id: 'coach-2' },
  'coach@example.com': { id: 'u-co', name: 'Cam Roe', role: 'coach', coach_id: null },
};
const CUSTOMERS: Row[] = [
  { client_user_id: 'u-me', stripe_customer_id: 'cus_me' },
  { client_user_id: 'u-nc', stripe_customer_id: 'cus_nc' },
  { client_user_id: 'u-ot', stripe_customer_id: 'cus_ot' },
];

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** check-email then verify-code, as the page does: a real buyer_token. */
async function prove(email: string): Promise<string> {
  const sent: Row[] = [];
  const db: any = {
    coachPackage: { findUnique: jest.fn(async () => ({ coach_id: COACH })) },
    user: { findFirst: jest.fn(async (a: Row) => ACCOUNTS[String(a.where.email.equals).toLowerCase()] ?? null) },
    emailSendLog: { count: jest.fn(async () => 0) },
  };
  const recovery = new CheckoutRecoveryService(db, config, { send: jest.fn(async (m: Row) => void sent.push(m)) } as any);
  await recovery.checkBuyerEmail(TOKEN, email);
  await flush();
  const out: any = await recovery.verifyBuyerCode(TOKEN, email, String(sent[sent.length - 1]?.data?.code));
  return out.buyer_token;
}

async function page(trialDays: number) {
  const stripe = {
    createCustomer: jest.fn(async () => ({ id: 'cus_fresh' })),
    createSubscription: jest.fn(async (a: Row) =>
      trialDays > 0
        ? { id: 'sub_t', status: 'trialing', pending_setup_intent: { id: 'seti_t1', client_secret: 'seti_t1_secret_x', status: 'requires_payment_method' }, customer: a.customer }
        : { id: 'sub_p', latest_invoice: { payment_intent: { id: 'pi_p1', client_secret: 'pi_p1_secret_x' } }, customer: a.customer },
    ),
    createSetupIntent: jest.fn(),
    createPaymentIntent: jest.fn(),
  };
  const account = {
    coach_user_id: COACH, stripe_account_id: 'acct_coach', charges_enabled: true,
    payouts_enabled: true, details_submitted: true, disabled_reason: null, deauthorized_at: null,
    requirements_due: { currently_due: [], past_due: [], eventually_due: [] },
  };
  const pkg = {
    id: 'pkg-1', coach_id: COACH, name: 'Monthly Coaching', description: null,
    amount_cents: 9900, currency: 'usd', billing_type: 'recurring', interval: 'month', interval_count: 1,
    recurring_amount_cents: null, recurring_interval: null, trial_days: trialDays, is_active: true, archived_at: null,
    published_at: new Date('2026-09-01'), share_token: TOKEN, share_link_enabled: true,
    share_link_expires_at: null, share_link_revoked_at: null,
    coach: { id: COACH, name: 'Coach One', deletion_scheduled_at: null, deleted_at: null, profile: null, coach_profile: null, connect_account: account },
  };
  const prisma = {
    coachPackage: { findUnique: jest.fn(async () => pkg) },
    coachLandingPage: { findFirst: jest.fn(async () => null) },
    user: { findFirst: jest.fn(async (a: Row) => ACCOUNTS[String(a.where.email.equals).toLowerCase().trim()] ?? null) },
    connectCustomer: {
      findUnique: jest.fn(async (a: Row) => {
        const w = a.where;
        return CUSTOMERS.find((c) => (w.client_user_id ? c.client_user_id === w.client_user_id : c.stripe_customer_id === w.stripe_customer_id)) ?? null;
      }),
    },
    guestCheckout: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'gc-1', idempotency_key: KEY })),
      update: jest.fn(async () => ({ id: 'gc-1' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const checkout = {
    ensurePriceForPackage: jest.fn(async () => 'price_month'),
    ensureRecurringPriceForPackage: jest.fn(async () => 'price_month'),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GuestCheckoutService,
      { provide: PrismaService, useValue: prisma },
      { provide: StripeConnectApiService, useValue: stripe },
      { provide: SupabaseService, useValue: {} },
      { provide: ConfigService, useValue: config },
      { provide: NotificationsService, useValue: {} },
      { provide: CheckoutService, useValue: checkout },
      { provide: FeePolicyService, useValue: {} },
    ],
  }).compile();
  return { svc: moduleRef.get(GuestCheckoutService), stripe, prisma };
}
const dto = (email: string, buyer_token?: string) => ({
  guest_name: 'Jane Smith', guest_phone: '+14155550100', guest_email: email, idempotency_key: KEY, buyer_token,
});
async function rejection(p: Promise<unknown>): Promise<Row> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), ...(err.getResponse() as Row) };
    throw err;
  }
  return { status: 'NO_ERROR' };
}
/** createSubscription's args minus the customer: what, when and how the plan charges. */
const terms = (call: Row) => {
  const { customer: _c, ...rest } = call;
  return rest;
};

const quiet = ['warn', 'error', 'log'].map((m) => jest.spyOn(Logger.prototype, m as 'warn').mockImplementation(() => undefined));
afterAll(() => quiet.forEach((s) => s.mockRestore()));

describe('LO-1201 — checkout-time customer reuse through the real createIntent gate', () => {
  it.each([0, 7])('existing account, no code proof (trial %i): refused, no customer read, nothing minted', async (trial) => {
    const { svc, stripe, prisma } = await page(trial);
    expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com')))).toMatchObject({ error: 'BUYER_CODE_REQUIRED' });
    // A proof for one email never opens another account's customer.
    const nc = await prove('nocoach@example.com');
    expect(await rejection(svc.createIntent(TOKEN, dto('mine@example.com', nc)))).toMatchObject({ error: 'BUYER_CODE_REQUIRED' });
    expect(prisma.connectCustomer.findUnique).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['other@example.com', 'another coach'],
    ['coach@example.com', 'a coach'],
  ])('%s (%s): no code proof is issued, and even a valid buyer_token is refused with their customer never read', async (email) => {
    // The code step itself refuses this account (no token is handed out).
    expect((await rejection(prove(email))).status).toBe(409);
    // A still-valid token (proved earlier, account changed since) is refused at createIntent.
    const token = mintBuyerToken(recoverySecretKey(config), email, TOKEN);
    const { svc, stripe, prisma } = await page(0);
    expect((await rejection(svc.createIntent(TOKEN, dto(email, token)))).status).toBe(409);
    expect(prisma.connectCustomer.findUnique).not.toHaveBeenCalled();
    expect(stripe.createSubscription).not.toHaveBeenCalled();
  });

  it.each([0, 7])('new email (trial %i): a fresh customer, no account customer read', async (trial) => {
    const { svc, stripe, prisma } = await page(trial);
    await svc.createIntent(TOKEN, dto('fresh@example.com'));
    expect(prisma.connectCustomer.findUnique).not.toHaveBeenCalled();
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(stripe.createSubscription.mock.calls[0][0]).toMatchObject({ customer: 'cus_fresh' });
  });

  it.each([
    ['mine@example.com', 'cus_me', 0],
    ['Mine@Example.com ', 'cus_me', 7],
    ['nocoach@example.com', 'cus_nc', 0],
  ])('proven %s: only its own customer (%s), and the charge terms are the fresh-customer terms (trial %i)', async (email, own, trial) => {
    const token = await prove(email.toLowerCase().trim());
    const reuse = await page(trial);
    await reuse.svc.createIntent(TOKEN, dto(email, token));
    expect(reuse.stripe.createCustomer).not.toHaveBeenCalled();
    const call = reuse.stripe.createSubscription.mock.calls[0][0];
    expect(call.customer).toBe(own);
    expect(reuse.prisma.connectCustomer.findUnique).toHaveBeenCalledTimes(1);
    expect(reuse.prisma.connectCustomer.findUnique.mock.calls[0][0]).toMatchObject({
      where: { client_user_id: ACCOUNTS[email.toLowerCase().trim()].id },
    });
    // Same price, same trial, same payment behaviour inputs as a new buyer's plan.
    const fresh = await page(trial);
    await fresh.svc.createIntent(TOKEN, dto('fresh@example.com'));
    const freshCall = fresh.stripe.createSubscription.mock.calls[0][0];
    expect(terms(call)).toEqual(terms(freshCall));
    expect(call.trialPeriodDays).toBe(trial > 0 ? trial : undefined);
    expect(reuse.prisma.guestCheckout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripe_customer_id: own }) }),
    );
  });
});
