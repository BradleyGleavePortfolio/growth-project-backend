import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { BillingService } from './billing.service';

// Coach-facing billing endpoints. Reads from the local Stripe-mirror tables;
// writes (subscription start, plan changes) go through the OWNER endpoints
// or the Stripe Customer Portal — coaches do not self-serve subscription
// state changes.
@Controller('v1/coach/me')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class CoachBillingController {
  constructor(private billing: BillingService) {}

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
  // The actual Stripe SDK call lives behind a feature flag. When
  // STRIPE_SECRET_KEY is present we will call Stripe.billingPortal.sessions
  // .create; for now we return a 501-shaped error if no Stripe customer is
  // configured. This keeps the contract live for the console without
  // forcing the deployment to have a real Stripe key.
  @Post('billing/portal-session')
  async portalSession(@Request() req: AuthedRequest) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new BadRequestException({
        error: 'STRIPE_NOT_CONFIGURED',
        message:
          'Stripe is not configured for this environment. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID_FITNESS to enable the billing portal.',
      });
    }
    // Real implementation lands in the Phase 2A follow-up PR. The contract
    // returns { url } on success; surfacing the error here ahead of time
    // means the console can render the right empty state today.
    throw new BadRequestException({
      error: 'STRIPE_PORTAL_NOT_IMPLEMENTED',
      message: 'Stripe Customer Portal session minting lands in the next PR',
      coachId: req.user.id,
    });
  }
}
