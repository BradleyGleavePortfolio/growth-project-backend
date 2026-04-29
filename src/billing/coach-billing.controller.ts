import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
@ApiTags('billing')
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

  // POST /v1/coach/me/billing/portal-session — issue a Stripe Billing
  // Portal redirect URL.
  //
  // Three modes, in order of preference:
  //   1. STRIPE_SECRET_KEY set → mint a per-coach session via the Stripe
  //      SDK. Returns { url, fallback: false }.
  //   2. STRIPE_SECRET_KEY unset, STRIPE_CUSTOMER_PORTAL_LOGIN_URL set →
  //      return the static hosted Customer Portal login link configured
  //      for the environment. The coach authenticates with the email on
  //      file with Stripe; this is the documented fallback for tenants
  //      without server-side Stripe credentials. Returns { url, fallback: true, coachId }.
  //   3. Neither set → STRIPE_NOT_CONFIGURED so the console renders the
  //      empty state.
  @Post('billing/portal-session')
  async portalSession(@Request() req: AuthedRequest) {
    if (!this.stripeApi.isConfigured()) {
      const fallbackUrl = process.env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL?.trim();
      if (fallbackUrl && /^https:\/\/billing\.stripe\.com\/p\/login\//.test(fallbackUrl)) {
        return { url: fallbackUrl, fallback: true, coachId: req.user.id };
      }
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID_FITNESS to mint per-coach portal sessions, or set STRIPE_CUSTOMER_PORTAL_LOGIN_URL to a hosted Customer Portal login link as a fallback.',
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
