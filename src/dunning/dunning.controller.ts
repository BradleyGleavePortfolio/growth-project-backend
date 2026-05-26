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
import { StripeApiError, StripeApiService } from '../billing/stripe-api.service';
import { DunningService } from './dunning.service';

// r50 Dunning v1 — coach-facing endpoints.
//
// One read (active case for in-app banner) and one mutation (mint a
// Stripe billing portal URL so the coach can update their card). The
// portal-mint helper deliberately duplicates the existing
// /v1/coach/me/billing/portal-session route rather than redirecting to
// it — the spec asks for /v1/billing/dunning/update-payment-method,
// the wiring is small, and a redirect would force the mobile app to
// follow a 302 across auth boundaries.
//
// Both routes are guarded by JwtAuthGuard + CoachOrOwnerGuard, identical
// to CoachBillingController.
@ApiTags('billing')
@Controller('v1/billing/dunning')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class DunningController {
  constructor(
    private readonly dunning: DunningService,
    private readonly prisma: PrismaService,
    private readonly stripeApi: StripeApiService,
  ) {}

  // GET /v1/billing/dunning/me
  //
  // Drives the coach app's "your card failed — we'll retry" banner.
  // Returns `null` (not 404) when no case is open so the client can
  // poll without branching on status codes.
  @Get('me')
  async myCase(@Request() req: AuthedRequest) {
    const c = await this.dunning.getActiveCaseForCoach(req.user.id);
    if (!c) return { case: null };
    return {
      case: {
        id: c.id,
        state: c.state,
        amount_cents: c.amount_cents,
        currency: c.currency,
        failure_reason: c.failure_reason,
        failure_code: c.failure_code,
        retry_1_at: c.retry_1_at,
        retry_2_at: c.retry_2_at,
        retry_3_at: c.retry_3_at,
        created_at: c.created_at,
        updated_at: c.updated_at,
      },
    };
  }

  // POST /v1/billing/dunning/update-payment-method
  //
  // Mints a Stripe Billing Portal session so the coach can update
  // their card. The portal is the canonical Stripe-hosted UI for
  // PCI-compliant payment-method updates; once they save the new card
  // Stripe will automatically retry the open invoice on the next
  // collection cycle.
  @Post('update-payment-method')
  async updatePaymentMethod(@Request() req: AuthedRequest) {
    if (!this.stripeApi.isConfigured()) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured for this environment.',
      });
    }
    const coachId = req.user.id;
    // CoachSubscription is the mirror updated by the customer.subscription.*
    // webhook handlers — the most-recent + canonical customer id. Falls
    // back to CoachProfile (where OWNER provisioning writes it before
    // the first webhook).
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
        message: 'No Stripe customer is provisioned for this coach yet.',
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
