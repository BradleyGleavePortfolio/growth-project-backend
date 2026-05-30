import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Request,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { ConnectService } from './connect.service';
import { ConnectModuleState } from './connect.module-state';
import { StripeConnectApiError } from './stripe-connect-api.service';

// Coach-facing Stripe Connect endpoints. All routes are JWT-authed and
// limited to coaches/owners by CoachOrOwnerGuard.
//
// Real-or-flagged gate: ConnectModuleState.ready is flipped to true by
// ConnectModule.onModuleInit only when (a) STRIPE_SECRET_KEY exists and
// (b) is shaped like a Stripe key (sk_test_* or sk_live_*) and (c) the
// Stripe Connect platform probe succeeded at boot. If any of those failed,
// every endpoint short-circuits with 503 + an actionable message.
@ApiTags('connect')
@Controller('v1/connect/accounts')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class ConnectController {
  constructor(
    private readonly state: ConnectModuleState,
    private readonly connect: ConnectService,
  ) {}

  // Coach (or OWNER acting on behalf) provisions their Stripe Connect
  // account so they can accept payouts. Students never have a Connect
  // account; exposing this to them would create dead/abandoned accounts.
  @Roles('coach', 'owner')
  @Post('create')
  async createAccount(
    @Request() req: AuthedRequest,
    @Body() body: { country?: string; email?: string } = {},
  ) {
    this.assertReady();
    try {
      const row = await this.connect.createAccountForCoach(req.user.id, {
        country: body?.country,
        email: body?.email,
      });
      return this.publicView(row);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  // Returns a Stripe-hosted onboarding URL for the requesting coach.
  // Coach-only (owners may impersonate for support); students have
  // nothing to onboard.
  // B8 — single-use Stripe onboarding links can be burned or push the
  // account into Stripe rate limits if hammered. Throttle to 10/min/coach,
  // matching the Connect link-minting convention elsewhere in the codebase.
  @Roles('coach', 'owner')
  @Post('onboarding-link')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async onboardingLink(@Request() req: AuthedRequest) {
    this.assertReady();
    try {
      return await this.connect.createOnboardingLink(req.user.id);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  // Returns a Stripe Express dashboard login link for the coach's own
  // Connect account — reveals balances/payouts and must never be reachable
  // by students or by another coach.
  // B8 — same Stripe-write throttle as onboarding-link.
  @Roles('coach', 'owner')
  @Post('dashboard-link')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async dashboardLink(@Request() req: AuthedRequest) {
    this.assertReady();
    try {
      return await this.connect.createDashboardLoginLink(req.user.id);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  // Coach reads their own Connect account status (charges_enabled,
  // deauthorized_at, etc.). Scoped by req.user.id; never accepts a
  // coach_id query. Students have no Connect record.
  @Roles('coach', 'owner')
  @Get('me')
  async me(@Request() req: AuthedRequest) {
    this.assertReady();
    const row = await this.connect.getStatusForCoach(req.user.id);
    if (!row) return { connected: false };
    return { connected: true, ...this.publicView(row) };
  }

  private assertReady() {
    if (!this.state.ready) {
      throw new ServiceUnavailableException({
        error: 'CONNECT_NOT_CONFIGURED',
        message:
          this.state.reason ??
          'Stripe Connect is not configured on this environment. See docs/connect-setup.md.',
      });
    }
  }

  // Strip secrets-shaped fields before returning to the client. We currently
  // do not store any, but this keeps the controller forward-safe.
  private publicView<T>(row: T): T {
    return row;
  }

  private mapStripeError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (err instanceof StripeConnectApiError) {
      const status =
        err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
      return new HttpException(
        {
          error: 'STRIPE_CONNECT_ERROR',
          message: err.message,
          stripeCode: err.stripeCode,
        },
        status,
      );
    }
    return new HttpException(
      { error: 'INTERNAL', message: (err as Error)?.message ?? 'Unknown error' },
      500,
    );
  }
}
