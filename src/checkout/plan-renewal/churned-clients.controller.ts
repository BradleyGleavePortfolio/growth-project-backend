import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ChurnedClientsService } from './churned-clients.service';
import { assertOn } from './plan-renewal.controller';

/**
 * CHURN-BE: the coach's churned clients and Roman's win-back draft. Coach
 * only, scoped to the caller's own clients (another coach's client is a 404
 * like any client not on the list); 404 PLAN_RENEWAL_OFF, before any read,
 * while FEATURE_PLAN_RENEWAL is off.
 */
@ApiTags('coach')
@Controller('v1/coach/churned-clients')
@UseGuards(JwtAuthGuard)
export class ChurnedClientsController {
  constructor(private readonly churned: ChurnedClientsService) {}

  @Get()
  @Roles('coach')
  list(@Request() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('take') take?: string) {
    assertOn();
    return this.churned.list(req.user.id, cursor, take);
  }

  // Same hourly cap as a coach's POST /ai/gateway/invoke.
  @Post(':clientId/draft')
  @Roles('coach')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  draft(@Request() req: AuthedRequest, @Param('clientId', ParseUUIDPipe) clientId: string) {
    assertOn();
    const forwarded = req.headers?.['x-forwarded-for'];
    const ua = req.headers?.['user-agent'];
    return this.churned.draft(req.user, clientId, {
      ip: (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || req.ip || null,
      userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null,
    });
  }
}
