import { randomBytes } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { mintBuyerToken, recoverySecretKey } from '../src/storefront/buyer-check';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';

// Positive controls for the new reuse seam, through the public service entry.
// Fixtures are synthetic; no network or external account is involved.
describe('LS-1201: public checkout proves account ownership before customer reuse', () => {
  it.each([
    ['unproved same-coach client', 'same', 'none', 0, 'BUYER_CODE_REQUIRED'],
    ['another email proof', 'same', 'foreign-email', 0, 'BUYER_CODE_REQUIRED'],
    ['another package proof', 'same', 'foreign-package', 0, 'BUYER_CODE_REQUIRED'],
    ['proved other-coach client', 'other', 'valid', 7, 'BUYER_HAS_COACH'],
    ['proved non-client', 'staff', 'valid', 0, 'BUYER_NOT_CLIENT'],
    ['proved same-coach paid client', 'same', 'valid', 0, null],
    ['proved same-coach trial client', 'same', 'valid', 7, null],
    ['proved coachless client', 'none', 'valid', 0, null],
    ['new paid buyer', 'new', 'none', 0, null],
    ['new trial buyer', 'new', 'none', 7, null],
  ])('%s', async (_label, kind, proof, trialDays, error) => {
    const link = 'synthetic-share-link';
    const email = ['buyer', 'example.invalid'].join('@');
    const config = new ConfigService({ CHECKOUT_RECOVERY_SECRET: randomBytes(48).toString('hex') });
    const account = kind === 'new' ? null : {
      id: 'client-own', name: 'Buyer', role: kind === 'staff' ? 'coach' : 'student',
      coach_id: kind === 'none' ? null : kind === 'other' ? 'coach-other' : 'coach-own',
    };
    const pkg = {
      id: 'package-own', coach_id: 'coach-own', name: 'Monthly coaching',
      amount_cents: 14900, currency: 'usd', billing_type: 'recurring',
      interval: 'month', interval_count: 1, recurring_amount_cents: null,
      recurring_interval: null, trial_days: trialDays, is_active: true,
      archived_at: null, published_at: new Date(0), share_link_enabled: true,
      coach: {
        id: 'coach-own', name: 'Coach',
        connect_account: {
          stripe_account_id: 'account-own', charges_enabled: true,
          payouts_enabled: true, details_submitted: true, disabled_reason: null,
        },
      },
    };
    const db = {
      coachPackage: { findUnique: jest.fn(async () => pkg) },
      user: { findFirst: jest.fn(async () => account) },
      connectCustomer: {
        findUnique: jest.fn(async () => ({ stripe_customer_id: 'customer-own' })),
      },
      guestCheckout: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'guest-own' })),
        update: jest.fn(async () => ({})),
      },
    };
    const stripe = {
      createCustomer: jest.fn(async () => ({ id: 'customer-new' })),
      createSubscription: jest.fn(async () => trialDays > 0 ? {
        id: 'subscription-own', status: 'trialing',
        pending_setup_intent: { id: 'setup-own', client_secret: 'synthetic-value' },
      } : {
        id: 'subscription-own',
        latest_invoice: { payment_intent: { id: 'payment-own', client_secret: 'synthetic-value' } },
      }),
    };
    const checkout = { ensurePriceForPackage: jest.fn(async () => 'price-own') };
    const module = await Test.createTestingModule({
      providers: [
        GuestCheckoutService,
        { provide: PrismaService, useValue: db },
        { provide: StripeConnectApiService, useValue: stripe },
        { provide: SupabaseService, useValue: {} },
        { provide: ConfigService, useValue: config },
        { provide: NotificationsService, useValue: {} },
        { provide: CheckoutService, useValue: checkout },
        { provide: FeePolicyService, useValue: {} },
      ],
    }).compile();
    const buyerToken = proof === 'none' ? undefined : mintBuyerToken(
      recoverySecretKey(config),
      proof === 'foreign-email' ? ['other', 'example.invalid'].join('@') : email,
      proof === 'foreign-package' ? 'other-share-link' : link,
    );
    const request = module.get(GuestCheckoutService).createIntent(link, {
      guest_name: 'Buyer Name', guest_email: email, guest_phone: '+10000000000',
      idempotency_key: 'synthetic-checkout-attempt', buyer_token: buyerToken,
    });
    try {
      if (error) {
        await expect(request).rejects.toMatchObject({ response: expect.objectContaining({ error }) });
        expect(db.guestCheckout.create).not.toHaveBeenCalled();
        expect(db.connectCustomer.findUnique).not.toHaveBeenCalled();
        expect(stripe.createCustomer).not.toHaveBeenCalled();
        expect(stripe.createSubscription).not.toHaveBeenCalled();
      } else {
        await request;
        const customer = kind === 'new' ? 'customer-new' : 'customer-own';
        expect(stripe.createSubscription).toHaveBeenCalledWith(
          expect.objectContaining({
            customer, onBehalfOf: 'account-own',
            trialPeriodDays: trialDays > 0 ? trialDays : undefined,
          }),
        );
        expect(db.guestCheckout.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ stripe_customer_id: customer }) }),
        );
        if (kind === 'new') {
          expect(db.connectCustomer.findUnique).not.toHaveBeenCalled();
          expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
        } else {
          expect(db.connectCustomer.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { client_user_id: 'client-own' } }),
          );
          expect(stripe.createCustomer).not.toHaveBeenCalled();
        }
      }
    } finally {
      await module.close();
    }
  });
});
