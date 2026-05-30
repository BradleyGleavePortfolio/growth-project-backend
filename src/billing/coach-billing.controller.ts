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

// Coach-facing billing endpoints. Reads from the local Stripe-mirror tables;
// writes (subscription start, plan changes) go through the OWNER endpoints
// or the Stripe Customer Portal — coaches do not self-serve subscription
// state changes.
@ApiTags('billing')
@Controller('v1/coach/me')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, NoActiveSubCoachGuard)
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
  //
  // B2 — single-use Stripe portal sessions are a Stripe-write; throttle to
  // 10/min/coach (mirrors the Connect link-minting routes) so the endpoint
  // can't be hammered into Stripe rate limits.
  @Post('billing/portal-session')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async portalSession(@Request() req: AuthedRequest) {
    // B1 — delegate to the shared BillingService method so the v1 and
    // mobile surfaces cannot drift.
    return this.billing.createCoachPortalSession(req.user.id);
  }
}
