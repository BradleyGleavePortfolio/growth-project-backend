import {
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { BillingService } from './billing.service';

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
@ApiTags('billing')
@Controller('coach/billing')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, NoActiveSubCoachGuard)
export class MobileCoachBillingController {
  constructor(private billing: BillingService) {}

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
  //
  // Three modes, in order of preference (mirrors the BFF route):
  //   1. STRIPE_SECRET_KEY set → mint a per-coach session via the Stripe
  //      SDK. Returns { url }.
  //   2. STRIPE_SECRET_KEY unset, STRIPE_CUSTOMER_PORTAL_LOGIN_URL set
  //      to a hosted Stripe portal login link → return that link.
  //      Returns { url, fallback: true, coachId }.
  //   3. Neither set → STRIPE_NOT_CONFIGURED so the mobile client renders
  //      the empty state.
  //
  // B2 — same Stripe-write throttle as the v1 portal-session route.
  @Post('portal-session')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async portalSession(@Request() req: AuthedRequest) {
    // B1 — delegate to the shared BillingService method (same code path as
    // POST /v1/coach/me/billing/portal-session) so the contract cannot drift.
    return this.billing.createCoachPortalSession(req.user.id);
  }
}
