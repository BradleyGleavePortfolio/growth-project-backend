/**
 * r50 — DunningController unit tests.
 *
 * Endpoint contract:
 *   GET  /v1/billing/dunning/me                  → { case: <row> | null }
 *   POST /v1/billing/dunning/update-payment-method → { url: <portal> }
 *
 * Auth gating is via JwtAuthGuard + CoachOrOwnerGuard — covered globally
 * by roles-enforced tests; not duplicated here.
 */

import { BadRequestException } from '@nestjs/common';
import { DunningController } from '../../src/dunning/dunning.controller';
import { StripeApiError } from '../../src/billing/stripe-api.service';

function makeReq(role: 'coach' | 'owner' = 'coach') {
  return { user: { id: 'coach-1', role } } as any;
}

function makeCtrl(opts: {
  activeCase?: any;
  subscriptionRow?: any;
  profileRow?: any;
  portalResult?: { url: string } | Error;
  stripeConfigured?: boolean;
}) {
  const dunning: any = {
    getActiveCaseForCoach: jest.fn().mockResolvedValue(opts.activeCase ?? null),
  };
  const prisma: any = {
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.subscriptionRow ?? null),
    },
    coachProfile: {
      findUnique: jest.fn().mockResolvedValue(opts.profileRow ?? null),
    },
  };
  const stripeApi: any = {
    isConfigured: jest.fn().mockReturnValue(opts.stripeConfigured !== false),
    createBillingPortalSession: jest.fn(async () => {
      if (opts.portalResult instanceof Error) throw opts.portalResult;
      return opts.portalResult ?? { url: 'https://billing.stripe.com/test' };
    }),
  };
  return {
    ctrl: new DunningController(dunning, prisma, stripeApi),
    dunning,
    prisma,
    stripeApi,
  };
}

describe('DunningController.myCase', () => {
  it('returns { case: null } when no open case', async () => {
    const { ctrl } = makeCtrl({});
    const out = await ctrl.myCase(makeReq());
    expect(out).toEqual({ case: null });
  });

  it('returns the open case shape suitable for the in-app banner', async () => {
    const open = {
      id: 'case-1',
      state: 'retry_2_scheduled',
      amount_cents: 4900,
      currency: 'usd',
      failure_reason: 'card_declined',
      failure_code: 'card_declined',
      retry_1_at: new Date('2026-05-26T00:00:00Z'),
      retry_2_at: new Date('2026-05-29T00:00:00Z'),
      retry_3_at: null,
      created_at: new Date('2026-05-25T00:00:00Z'),
      updated_at: new Date('2026-05-26T00:00:00Z'),
    };
    const { ctrl } = makeCtrl({ activeCase: open });
    const out = await ctrl.myCase(makeReq());
    expect(out.case).toMatchObject({
      id: 'case-1',
      state: 'retry_2_scheduled',
      amount_cents: 4900,
    });
    // Internal-only fields must NOT be returned.
    expect(out.case).not.toHaveProperty('coach_id');
    expect(out.case).not.toHaveProperty('stripe_customer_id');
    expect(out.case).not.toHaveProperty('opened_by_event_id');
  });
});

describe('DunningController.updatePaymentMethod', () => {
  it('throws STRIPE_NOT_CONFIGURED when Stripe is unset', async () => {
    const { ctrl } = makeCtrl({ stripeConfigured: false });
    await expect(ctrl.updatePaymentMethod(makeReq())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws BILLING_NOT_PROVISIONED when no customer id can be resolved', async () => {
    const { ctrl } = makeCtrl({});
    await expect(ctrl.updatePaymentMethod(makeReq())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('mints a portal URL when CoachSubscription has the customer id', async () => {
    const { ctrl, stripeApi } = makeCtrl({
      subscriptionRow: { stripe_customer_id: 'cus_1' },
    });
    const out = await ctrl.updatePaymentMethod(makeReq());
    expect(out.url).toMatch(/^https:\/\/billing\.stripe\.com/);
    expect(stripeApi.createBillingPortalSession).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1' }),
    );
  });

  it('falls back to CoachProfile.stripe_customer_id when CoachSubscription is missing', async () => {
    const { ctrl, stripeApi } = makeCtrl({
      subscriptionRow: null,
      profileRow: { stripe_customer_id: 'cus_fallback' },
    });
    await ctrl.updatePaymentMethod(makeReq());
    const arg = stripeApi.createBillingPortalSession.mock.calls[0][0];
    expect(arg.customer).toBe('cus_fallback');
  });

  it('surfaces StripeApiError with the upstream status code', async () => {
    const { ctrl } = makeCtrl({
      subscriptionRow: { stripe_customer_id: 'cus_1' },
      portalResult: new StripeApiError('portal config missing', 400, 'portal_not_configured', 'invalid_request_error'),
    });
    let err: any;
    try {
      await ctrl.updatePaymentMethod(makeReq());
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      error: 'STRIPE_PORTAL_ERROR',
      stripeCode: 'portal_not_configured',
    });
  });
});
