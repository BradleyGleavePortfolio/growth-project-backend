import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { PrismaService } from '../prisma.service';
import { BillingService } from './billing.service';
import { StripeApiError, StripeApiService } from './stripe-api.service';

// Mobile-app coach billing surface. Mobile PR #66 calls these short
// paths instead of the v1 BFF the admin console uses; they return the
// minimum viable payload a phone needs (status pill + portal redirect).
//
// Canonical routes for the same data are `/v1/coach/me/billing` and
// `/v1/coach/me/billing/portal-session`. Both surfaces talk to the same
// services so the mobile contract cannot drift from the BFF contract.
//
// Why a separate controller, not aliases on the v1 controller?
//   - The v1 controller mounts at `/v1/coach/me/*`. Mobile expects
//     `/coach/billing/*` (no `me`, no `v1`). Adding the same routes to
//     the v1 controller would conflict on the `@Controller` prefix.
//   - Mobile asks specifically for "status" rather than the entire
//     billing payload (which the v1 endpoint returns: subscription +
//     last 24 invoices). This controller returns the trimmed shape so
//     the phone doesn't pay 24 invoice rows on every app open.
@Controller('coach/billing')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class MobileCoachBillingController {
  constructor(
    private billing: BillingService,
    private prisma: PrismaService,
    private stripeApi: StripeApiService,
  ) {}

  // GET /coach/billing/status — returns a compact billing summary for
  // the authenticated coach. The shape is intentionally the smallest set
  // of fields the mobile app needs to render the billing pill (status
  // string + period end + cancel-at-period-end), so the phone can render
  // without the invoice list.
  @Get('status')
  async getStatus(@Request() req: AuthedRequest) {
    const { subscription } = await this.billing.getCoachBilling(req.user.id);
    if (!subscription) {
      // Honest "no subscription" answer (e.g. coach was just promoted but
      // start-subscription has not run yet). Mobile renders a neutral
      // pill rather than synthesizing a fake "active" response.
      return {
        status: 'unprovisioned',
        plan_tier: null,
        current_period_end: null,
        cancel_at_period_end: false,
        trial_end: null,
      };
    }
    return {
      status: subscription.status,
      plan_tier: subscription.stripe_price_id ?? null,
      current_period_end: subscription.current_period_end,
      cancel_at_period_end: subscription.cancel_at_period_end,
      trial_end: subscription.trial_end,
    };
  }

  // POST /coach/billing/portal-session — same code path as
  // POST /v1/coach/me/billing/portal-session. We resolve the customer id
  // from CoachSubscription first (post-onboarding mirror) and fall back
  // to CoachProfile (where OWNER provisioning writes the customer id
  // before the customer.subscription.created webhook lands).
  @Post('portal-session')
  async portalSession(@Request() req: AuthedRequest) {
    if (!this.stripeApi.isConfigured()) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY to enable the billing portal.',
      });
    }
    const coachId = req.user.id;
    const subscription = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
    });
    let customerId = subscription?.stripe_customer_id ?? null;
    if (!customerId) {
      const profile = await this.prisma.coachProfile.findUnique({
        where: { user_id: coachId },
      });
      customerId = profile?.stripe_customer_id ?? null;
    }
    if (!customerId) {
      throw new BadRequestException({
        error: 'BILLING_NOT_PROVISIONED',
        message:
          'No Stripe customer is provisioned for this coach yet. An OWNER must call start-subscription first.',
      });
    }
    const returnUrl =
      process.env.STRIPE_BILLING_PORTAL_RETURN_URL ??
      'https://console.thegrowthproject.app/billing';
    try {
      const session = await this.stripeApi.createBillingPortalSession({
        customer: customerId,
        returnUrl,
      });
      return { url: session.url };
    } catch (err) {
      if (err instanceof StripeApiError) {
        throw new HttpException(
          {
            error: 'STRIPE_PORTAL_ERROR',
            message: err.message,
            stripeCode: err.stripeCode,
          },
          err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502,
        );
      }
      throw err;
    }
  }
}
