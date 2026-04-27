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

// Coach-facing billing endpoints. Reads from the local Stripe-mirror tables;
// writes (subscription start, plan changes) go through the OWNER endpoints
// or the Stripe Customer Portal — coaches do not self-serve subscription
// state changes.
@Controller('v1/coach/me')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class CoachBillingController {
  constructor(
    private billing: BillingService,
    private prisma: PrismaService,
    private stripeApi: StripeApiService,
  ) {}

  @Get('billing')
  async getBilling(@Request() req: AuthedRequest) {
    // OWNER acting as themselves still sees their own (likely empty) billing
    // row. To inspect a specific coach's billing, OWNERs use the
    // /v1/admin/coaches/:id endpoint (out of scope for this PR).
    return this.billing.getCoachBilling(req.user.id);
  }

  // POST /v1/coach/me/billing/portal-session — mints a Stripe Billing Portal
  // session URL for the authenticated coach. The Customer Portal is the
  // canonical surface for coach self-service: update payment method, view
  // invoices, update billing details. Plan changes and cancellation are
  // disabled in the Portal config (see docs/stripe-setup.md §2.3) so OWNERs
  // can reconcile state.
  @Post('billing/portal-session')
  async portalSession(@Request() req: AuthedRequest) {
    if (!this.stripeApi.isConfigured()) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY to enable the billing portal.',
      });
    }

    const coachId = req.user.id;

    // Resolve stripe_customer_id from CoachSubscription first (mirror is the
    // primary source of truth post-onboarding) and fall back to CoachProfile
    // (where OWNER provisioning writes the customer id immediately, before
    // the customer.subscription.created webhook lands).
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
        // Surface Stripe's own status (4xx for client errors, 5xx for
        // upstream issues) rather than wrapping every error as 400.
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
