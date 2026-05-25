import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';
import { CoachConnectService } from './coach-connect.service';

// Phase 8 — Mobile-facing Coach Connect surface.
//
// All endpoints mount at /coach/connect/* (not /v1/coach/connect) to
// match the mobile axios client. The lower-level /v1/connect/accounts/*
// surface is the on-prem admin surface used by the web console and
// still exposed (unchanged) — this controller is a friendlier wrapper
// that gives the mobile app the typed shape it expects.
@ApiTags('coach-connect')
@Controller('coach/connect')
@UseGuards(JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard)
export class CoachConnectController {
  constructor(private readonly svc: CoachConnectService) {}

  // GET /coach/connect/status — the requesting coach's Stripe Connect
  // status (charges_enabled, payouts_enabled, requirements). Scoped by
  // req.user.id; no coach_id query. NoActiveSubCoachGuard blocks active
  // sub-coaches from inspecting any coach's Connect status (financial
  // surface). Students have no Connect account.
  @Roles('coach', 'owner')
  @Get('status')
  async status(@Req() req: AuthedRequest) {
    return this.svc.getStatus(req.user.id);
  }

  // GET /coach/connect/metrics — the requesting coach's MRR / payout
  // metrics. Scoped by req.user.id. Sub-coaches blocked by class-level
  // NoActiveSubCoachGuard (financial surface).
  @Roles('coach', 'owner')
  @Get('metrics')
  async metrics(@Req() req: AuthedRequest) {
    return this.svc.getMetrics(req.user.id);
  }

  // GET /coach/connect/payouts — the requesting coach's recent Stripe
  // payouts list. Scoped by req.user.id; never accepts a coach_id query.
  // NoActiveSubCoachGuard blocks active sub-coaches (payouts are a
  // strictly head-coach surface).
  @Roles('coach', 'owner')
  @Get('payouts')
  async payouts(
    @Req() req: AuthedRequest,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 10)) : 10;
    try {
      return await this.svc.listPayouts(req.user.id, limit);
    } catch (err) {
      throw this.mapStripeError(err);
    }
  }

  // GET /coach/connect/packages — the requesting coach's published
  // packages (used by the mobile dashboard's storefront tile). Scoped
  // by req.user.id.
  @Roles('coach', 'owner')
  @Get('packages')
  async packages(@Req() req: AuthedRequest) {
    return this.svc.listPackages(req.user.id);
  }

  // POST /coach/connect/onboarding-link — mints a Stripe-hosted Connect
  // onboarding URL for the requesting coach. Scoped by req.user.id; the
  // service refuses to mint a link for a non-coach. NoActiveSubCoachGuard
  // blocks sub-coaches; students cannot own a Connect account.
  @Roles('coach', 'owner')
  @Post('onboarding-link')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async onboardingLink(
    @Req() req: AuthedRequest,
    // The mobile contract accepts a no-op body or { return_path }.
    @Body() _body: { return_path?: string } = {},
  ) {
    try {
      return await this.svc.createOnboardingLink(req.user.id);
    } catch (err) {
      throw this.mapStripeError(err);
    }
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
