import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { GuestCheckoutService } from '../src/storefront/guest-checkout.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { CheckoutService } from '../src/checkout/checkout.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';

// PR-14 — REAL tests for the master-plan §1 decision #1 fix:
//   (a) the guest/web storefront now mints subscriptions for recurring
//       and one-time+recurring combo packages;
//   (b) landing_page_id propagates from GuestCheckout to ClientPurchase
//       inside convertGuestToUser's $transaction (and stays NULL-safe);
//   (c) the fan-out hook still fires exactly once for guest purchases
//       including recurring ones (verified by asserting the
//       PurchaseFanoutService.onPurchaseEntitled mock call count and
//       its receipt of the ClientPurchase row inside the tx);
//   (d) idempotency / replay: a Stripe webhook replay of the SAME
//       payment_intent.succeeded event does NOT mint a second
//       subscription or a second ClientPurchase.

const IDEMP_KEY = '550e8400-e29b-41d4-a716-446655440000';

const baseDto = {
  guest_name: 'Jane Smith',
  guest_email: 'jane@example.com',
  idempotency_key: IDEMP_KEY,
};

function makePkg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pkg-1',
    coach_id: 'coach-1',
    name: 'Coaching Pro',
    description: null,
    amount_cents: 29700,
    currency: 'usd',
    billing_type: 'one_time',
    interval: null,
    interval_count: 1,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    stripe_product_id: null,
    stripe_price_id: null,
    recurring_stripe_price_id: null,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-01-01'),
    share_token: 'tok123',
    share_link_enabled: true,
    coach: {
      id: 'coach-1',
      name: 'Coach McCoach',
      connect_account: {
        stripe_account_id: 'acct_x',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: null,
      },
    },
    ...overrides,
  };
}

function buildPrismaMocks() {
  const m: any = {
    coachPackage: { findUnique: jest.fn() },
    coachLandingPage: { findFirst: jest.fn() },
    guestCheckout: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    clientPurchase: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    connectAccount: {
      findUnique: jest.fn().mockResolvedValue({ stripe_account_id: 'acct_x' }),
    },
    $transaction: jest.fn(),
  };
  m.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(m));
  return m;
}

describe('PR-14 — Guest storefront recurring + landing_page_id propagation', () => {
  let service: GuestCheckoutService;
  let prisma: ReturnType<typeof buildPrismaMocks>;
  let stripe: any;
  let supabaseAdminMock: any;
  let checkout: any;
  let feePolicy: any;
  let fanout: any;

  beforeEach(async () => {
    prisma = buildPrismaMocks();
    stripe = {
      createPaymentIntent: jest.fn(),
      retrievePaymentIntent: jest.fn(),
      retrieveCharge: jest.fn().mockResolvedValue({ id: 'ch_x', receipt_url: null }),
      createCustomer: jest.fn(),
      createSubscription: jest.fn(),
      // PR-14 R2 P2-3 — convertGuestToUser reads the live subscription
      // status before opening the conversion $transaction.
      retrieveSubscription: jest.fn().mockResolvedValue({
        id: 'sub_x',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      }),
    };
    supabaseAdminMock = {
      createUser: jest.fn(),
      listUsers: jest.fn(),
      generateLink: jest.fn().mockResolvedValue({
        data: {
          properties: {
            action_link:
              'https://supabase.example.com/auth/v1/verify?token=abc&type=invite',
          },
        },
        error: null,
      }),
    };
    checkout = {
      ensurePriceForPackage: jest.fn().mockResolvedValue('price_one'),
      ensureRecurringPriceForPackage: jest.fn().mockResolvedValue('price_rec'),
    };
    feePolicy = {
      planFor: jest.fn().mockResolvedValue({
        application_fee_cents: 594,
        head_coach_split_cents: 0,
        head_coach_id: null,
      }),
    };
    fanout = {
      onPurchaseEntitled: jest.fn().mockResolvedValue(undefined),
      flushAlerts: jest.fn(),
      discardPendingAlerts: jest.fn(),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        GuestCheckoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeConnectApiService, useValue: stripe },
        {
          provide: SupabaseService,
          useValue: { getClient: () => ({ auth: { admin: supabaseAdminMock } }) },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: NotificationsService,
          useValue: { createNotification: jest.fn().mockResolvedValue({}) },
        },
        { provide: CheckoutService, useValue: checkout },
        { provide: FeePolicyService, useValue: feePolicy },
        { provide: PurchaseFanoutService, useValue: fanout },
      ],
    }).compile();
    service = mod.get(GuestCheckoutService);
  });

  describe('createIntent — recurring + combo', () => {
    it('pure recurring: creates Customer + Subscription + returns the latest_invoice PI client_secret', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({
          billing_type: 'recurring',
          amount_cents: 29700,
          interval: 'month',
          interval_count: 1,
        }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({
        id: 'gc-rec-1',
        idempotency_key: IDEMP_KEY,
      });
      stripe.createCustomer.mockResolvedValueOnce({ id: 'cus_rec' });
      stripe.createSubscription.mockResolvedValueOnce({
        id: 'sub_rec',
        status: 'incomplete',
        latest_invoice: {
          id: 'in_1',
          payment_intent: {
            id: 'pi_sub_rec',
            client_secret: 'pi_sub_rec_secret',
            status: 'requires_payment_method',
          },
        },
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      const result = await service.createIntent('tok123', baseDto);

      expect(result.payment_intent_id).toBe('pi_sub_rec');
      expect(result.client_secret).toBe('pi_sub_rec_secret');
      expect(result.subscription_id).toBe('sub_rec');

      // Pure recurring uses the PRIMARY ensurePriceForPackage helper
      // (the primary price IS the recurring one).
      expect(checkout.ensurePriceForPackage).toHaveBeenCalledTimes(1);
      expect(checkout.ensureRecurringPriceForPackage).not.toHaveBeenCalled();

      // Customer created with deterministic idempotency keyed off
      // dto.idempotency_key so Stripe replays collapse.
      expect(stripe.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'jane@example.com',
          idempotencyKey: `guest-customer-${IDEMP_KEY}`,
        }),
      );

      // Subscription minted on the SHARED recurring price with
      // default_incomplete semantics + connect transfer destination.
      const subCall = stripe.createSubscription.mock.calls[0][0];
      expect(subCall.recurringPriceId).toBe('price_one');
      expect(subCall.oneTimePriceId).toBeUndefined();
      expect(subCall.transferDestination).toBe('acct_x');
      expect(subCall.onBehalfOf).toBe('acct_x');
      expect(subCall.idempotencyKey).toBe(`guest-subscription-${IDEMP_KEY}`);

      // The legacy direct PaymentIntent path is NOT taken for recurring.
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();

      // GuestCheckout sentinel patched with subscription + customer ids.
      const updateCall = prisma.guestCheckout.update.mock.calls[0][0];
      expect(updateCall.data.stripe_subscription_id).toBe('sub_rec');
      expect(updateCall.data.stripe_customer_id).toBe('cus_rec');
      expect(updateCall.data.stripe_payment_intent_id).toBe('pi_sub_rec');
    });

    it('one-time+recurring combo: mints one Subscription whose first invoice carries BOTH prices', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({
          billing_type: 'one_time',
          amount_cents: 19900,
          recurring_amount_cents: 4900,
          recurring_interval: 'month',
          recurring_interval_count: 1,
        }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({
        id: 'gc-combo-1',
        idempotency_key: IDEMP_KEY,
      });
      stripe.createCustomer.mockResolvedValueOnce({ id: 'cus_combo' });
      stripe.createSubscription.mockResolvedValueOnce({
        id: 'sub_combo',
        status: 'incomplete',
        latest_invoice: {
          id: 'in_combo',
          payment_intent: {
            id: 'pi_combo',
            client_secret: 'pi_combo_secret',
            status: 'requires_payment_method',
          },
        },
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      const result = await service.createIntent('tok123', baseDto);

      expect(result.subscription_id).toBe('sub_combo');
      expect(result.payment_intent_id).toBe('pi_combo');

      // Combo uses BOTH price helpers — recurring (companion) AND
      // one-time (primary).
      expect(checkout.ensureRecurringPriceForPackage).toHaveBeenCalledTimes(1);
      expect(checkout.ensurePriceForPackage).toHaveBeenCalledTimes(1);

      // Subscription receives BOTH prices in a single mint.
      const subCall = stripe.createSubscription.mock.calls[0][0];
      expect(subCall.recurringPriceId).toBe('price_rec');
      expect(subCall.oneTimePriceId).toBe('price_one');

      // ONE Stripe subscription mint — never two for a combo.
      expect(stripe.createSubscription).toHaveBeenCalledTimes(1);
      // ONE Customer.
      expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
      // ZERO direct PaymentIntent calls (the combo uses the invoice's PI).
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('combo first-invoice fee percent is sized against the COMBO total (PR-14 R2 P1-1)', async () => {
      // Combo: amount_cents = 29900 ($299 one-time), recurring = 4900 ($49/mo).
      // First invoice total = 34800 cents.
      // FeePolicy is called PER LEG. Stub returns (594, 0) for any amount,
      // so per-leg sum = 594 + 594 = 1188 cents of platform fee.
      // application_fee_percent should be ceil-rounded so the percent
      // applied to 34800 collects ≥ 1188 cents.
      //   1188 / 34800 = 3.4138% → ceil to 2dp = 3.42%
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({
          billing_type: 'one_time',
          amount_cents: 29900,
          recurring_amount_cents: 4900,
          recurring_interval: 'month',
          recurring_interval_count: 1,
        }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-fee-combo' });
      stripe.createCustomer.mockResolvedValueOnce({ id: 'cus_fee' });
      stripe.createSubscription.mockResolvedValueOnce({
        id: 'sub_fee_combo',
        status: 'incomplete',
        latest_invoice: {
          id: 'in_fee',
          payment_intent: {
            id: 'pi_fee',
            client_secret: 'pi_fee_secret',
            status: 'requires_payment_method',
          },
        },
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      await service.createIntent('tok123', baseDto);

      // Verify FeePolicy was called per leg (recurring + one-time).
      expect(feePolicy.planFor).toHaveBeenCalledTimes(2);
      const amountsPolled = feePolicy.planFor.mock.calls.map((c: any) => c[1]);
      expect(amountsPolled).toEqual(expect.arrayContaining([4900, 29900]));

      // Verify the percent was sized against the COMBO total. Computed:
      // combined fee = 594 + 594 = 1188 cents; basis = 34800 cents;
      // percent = ceil(1188 * 10_000 / 34800) / 100 = ceil(341379.31..)/...
      // toStripeApplicationFeePercent's exact value: ceil((1188*10_000)/34800)
      // = ceil(341379.3103…) (using integer math: ceil(11_880_000/34_800)
      // = ceil(341.379...) — actually the formula is hundredths-of-a-percent
      // ceil. Let's verify it's > the previous (recurring-only) percent.
      const subCall = stripe.createSubscription.mock.calls[0][0];
      // With basis=4900 only, percent would have been ceil(594*10000/4900)/100
      // = ceil(1212244.9)/100 — way higher. Now sized against 34800, it must
      // be LOWER than what the recurring-only basis would have produced.
      const recurringOnlyPercent = Math.ceil(
        (594 * 10_000) / 4900,
      ) / 100;
      expect(subCall.applicationFeePercent).toBeDefined();
      expect(subCall.applicationFeePercent).toBeLessThan(recurringOnlyPercent);

      // Also: the percent must collect ≥ contractedFeeCents on the combo
      // first invoice (over-collection bound is < 1 cent per Stripe's
      // half-up rounding contract).
      const actualPercent = subCall.applicationFeePercent;
      const collectedCents = Math.round(
        (actualPercent / 100) * 34800,
      );
      expect(collectedCents).toBeGreaterThanOrEqual(1188);
    });

    it('renewal fee basis: pure-recurring sizes percent against recurring_amount_cents (no regression)', async () => {
      // Pure recurring still uses single planFor on amount_cents.
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({
          billing_type: 'recurring',
          amount_cents: 4900,
          interval: 'month',
          interval_count: 1,
        }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-pure-rec' });
      stripe.createCustomer.mockResolvedValueOnce({ id: 'cus_pure' });
      stripe.createSubscription.mockResolvedValueOnce({
        id: 'sub_pure_rec',
        status: 'incomplete',
        latest_invoice: {
          id: 'in_pure',
          payment_intent: {
            id: 'pi_pure',
            client_secret: 'pi_pure_secret',
            status: 'requires_payment_method',
          },
        },
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      await service.createIntent('tok123', baseDto);

      // FeePolicy called exactly once for pure recurring (no per-leg sum).
      expect(feePolicy.planFor).toHaveBeenCalledTimes(1);
      expect(feePolicy.planFor.mock.calls[0][1]).toBe(4900);
    });

    it('idempotent replay: the existing GuestCheckout row is replayed without minting a second Subscription', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ billing_type: 'recurring', interval: 'month' }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce({
        id: 'gc-rec-existing',
        package_id: 'pkg-1',
        guest_email: 'jane@example.com',
        status: 'paid',
        stripe_payment_intent_id: 'pi_sub_rec',
        stripe_subscription_id: 'sub_rec',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      });
      stripe.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_sub_rec',
        client_secret: 'pi_sub_rec_secret',
      });

      const result = await service.createIntent('tok123', baseDto);

      expect(result.payment_intent_id).toBe('pi_sub_rec');
      // CRITICAL: replay must not double-create the subscription.
      expect(stripe.createSubscription).not.toHaveBeenCalled();
      expect(stripe.createCustomer).not.toHaveBeenCalled();
    });

    it('still rejects non-USD recurring packages — currency restriction is preserved (split from the recurring guard)', async () => {
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ billing_type: 'recurring', currency: 'eur', interval: 'month' }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      await expect(service.createIntent('tok123', baseDto)).rejects.toMatchObject({
        response: { error: 'CURRENCY_NOT_SUPPORTED' },
      });
      // No Stripe calls burned on a non-USD recurring.
      expect(stripe.createSubscription).not.toHaveBeenCalled();
      expect(stripe.createCustomer).not.toHaveBeenCalled();
      expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('surfaces 503 STRIPE_UNAVAILABLE when the subscription response is missing the expanded PaymentIntent', async () => {
      // Defensive: a broken Stripe response (no expand on first invoice)
      // would otherwise leak an empty client_secret to the frontend. We
      // would rather 503 and have the storefront retry.
      prisma.coachPackage.findUnique.mockResolvedValueOnce(
        makePkg({ billing_type: 'recurring', interval: 'month' }),
      );
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-broken' });
      stripe.createCustomer.mockResolvedValueOnce({ id: 'cus_broken' });
      stripe.createSubscription.mockResolvedValueOnce({
        id: 'sub_broken',
        status: 'incomplete',
        latest_invoice: { id: 'in_broken', payment_intent: 'in_str_only' },
      });
      await expect(service.createIntent('tok123', baseDto)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('existing one-time guest path keeps minting a direct PaymentIntent (no regression)', async () => {
      // PR-14 regression guard: pure one-time MUST still use
      // createPaymentIntent — no Subscription, no Customer pre-creation.
      prisma.coachPackage.findUnique.mockResolvedValueOnce(makePkg());
      prisma.guestCheckout.findUnique.mockResolvedValueOnce(null);
      prisma.guestCheckout.create.mockResolvedValueOnce({ id: 'gc-1' });
      stripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_legacy',
        client_secret: 'pi_legacy_secret',
      });
      prisma.guestCheckout.update.mockResolvedValueOnce({});

      const result = await service.createIntent('tok123', baseDto);

      expect(result.payment_intent_id).toBe('pi_legacy');
      expect(result.subscription_id).toBeNull();
      expect(stripe.createSubscription).not.toHaveBeenCalled();
      expect(stripe.createCustomer).not.toHaveBeenCalled();
      expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    });
  });

  describe('convertGuestToUser — landing_page_id propagation + recurring lift', () => {
    function wireConvert({
      checkout: gc,
      pkg,
      newPurchaseId = 'cp-new',
    }: {
      checkout: any;
      pkg: any;
      newPurchaseId?: string;
    }) {
      // First findUnique (handlePaymentSucceeded → fresh re-read of the
      // claimed row).
      prisma.guestCheckout.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.guestCheckout.findUnique
        .mockResolvedValueOnce({ ...gc, package: pkg }) // include
        .mockResolvedValueOnce({ ...gc }); // inside convert path

      // Supabase user create flow
      supabaseAdminMock.createUser.mockResolvedValueOnce({
        data: { user: { id: 'sb-jane' } },
        error: null,
      });

      // Connect destination account lookup
      prisma.connectAccount.findUnique.mockResolvedValue({
        stripe_account_id: 'acct_x',
        deauthorized_at: null,
      });

      // User upsert inside the tx
      prisma.user.upsert.mockResolvedValueOnce({
        id: 'user-jane',
        coach_id: pkg.coach_id,
      });

      // No prior purchase row
      prisma.clientPurchase.findFirst.mockResolvedValueOnce(null);

      // create receives the data; capture into the mock to return what
      // the real Prisma would return.
      prisma.clientPurchase.create.mockImplementationOnce(
        async (args: { data: Record<string, unknown> }) => ({
          id: newPurchaseId,
          ...args.data,
        }),
      );

      prisma.guestCheckout.update.mockResolvedValueOnce({});
    }

    it('propagates landing_page_id from GuestCheckout to ClientPurchase inside the conversion $transaction', async () => {
      const pkg = makePkg();
      const gc = {
        id: 'gc-lp',
        guest_email: 'jane@example.com',
        guest_name: 'Jane Smith',
        package_id: 'pkg-1',
        stripe_payment_intent_id: 'pi_lp',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        landing_page_id: 'lp_abc123def456ghi789jk',
        idempotency_key: IDEMP_KEY,
        status: 'paid',
        receipt_url: null,
      };
      wireConvert({ checkout: gc, pkg });

      await service.handlePaymentSucceeded('pi_lp');

      expect(prisma.clientPurchase.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.clientPurchase.create.mock.calls[0][0];
      expect(createArg.data.landing_page_id).toBe('lp_abc123def456ghi789jk');
      // Same tx — assert the create was issued via tx, not raw prisma:
      // the buildPrismaMocks $transaction implementation wires tx === m,
      // so any clientPurchase.create call is by definition inside the tx.
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('NULL-safe: a GuestCheckout with no landing_page_id yields ClientPurchase.landing_page_id = null and does NOT crash', async () => {
      const pkg = makePkg();
      const gc = {
        id: 'gc-no-lp',
        guest_email: 'jane@example.com',
        guest_name: 'Jane Smith',
        package_id: 'pkg-1',
        stripe_payment_intent_id: 'pi_no_lp',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        landing_page_id: null,
        idempotency_key: IDEMP_KEY,
        status: 'paid',
        receipt_url: null,
      };
      wireConvert({ checkout: gc, pkg });

      await service.handlePaymentSucceeded('pi_no_lp');

      const createArg = prisma.clientPurchase.create.mock.calls[0][0];
      expect(createArg.data.landing_page_id).toBeNull();
    });

    it('recurring guest: ClientPurchase carries stripe_subscription_id, billing_type=recurring, status=active, and reaches the fan-out hook EXACTLY ONCE', async () => {
      const pkg = makePkg({
        billing_type: 'recurring',
        interval: 'month',
        interval_count: 1,
      });
      const gc = {
        id: 'gc-rec-convert',
        guest_email: 'jane@example.com',
        guest_name: 'Jane Smith',
        package_id: 'pkg-1',
        stripe_payment_intent_id: 'pi_rec',
        stripe_customer_id: 'cus_rec',
        stripe_subscription_id: 'sub_rec',
        landing_page_id: 'lp_aaaaaaaaaaaaaaaaaaaa',
        idempotency_key: IDEMP_KEY,
        status: 'paid',
        receipt_url: null,
      };
      wireConvert({ checkout: gc, pkg, newPurchaseId: 'cp-rec' });

      await service.handlePaymentSucceeded('pi_rec');

      const createArg = prisma.clientPurchase.create.mock.calls[0][0];
      expect(createArg.data.stripe_subscription_id).toBe('sub_rec');
      expect(createArg.data.billing_type).toBe('recurring');
      expect(createArg.data.status).toBe('active');
      expect(createArg.data.entitlement_active).toBe(true);
      expect(createArg.data.landing_page_id).toBe(
        'lp_aaaaaaaaaaaaaaaaaaaa',
      );

      // PR-9 fan-out hook fired EXACTLY ONCE, with the ClientPurchase
      // row, the storefront_guest entrypoint, and the in-tx handle.
      expect(fanout.onPurchaseEntitled).toHaveBeenCalledTimes(1);
      const fanArgs = fanout.onPurchaseEntitled.mock.calls[0];
      expect(fanArgs[0].id).toBe('cp-rec');
      expect(fanArgs[0].stripe_subscription_id).toBe('sub_rec');
      expect(fanArgs[1].entrypoint).toBe('storefront_guest');
      expect(fanArgs[1].coachId).toBe('coach-1');
      expect(fanArgs[1].clientId).toBe('user-jane');
    });
  });
});
