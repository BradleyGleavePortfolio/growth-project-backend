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

  @Get('status')
  async status(@Req() req: AuthedRequest) {
    return this.svc.getStatus(req.user.id);
  }

  @Get('metrics')
  async metrics(@Req() req: AuthedRequest) {
    return this.svc.getMetrics(req.user.id);
  }

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

  @Get('packages')
  async packages(@Req() req: AuthedRequest) {
    return this.svc.listPackages(req.user.id);
  }

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
