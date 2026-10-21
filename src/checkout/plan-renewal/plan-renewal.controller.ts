import { Body, Controller, Get, HttpCode, NotFoundException, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt } from 'class-validator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../../common/decorators/skip-client-entitlement.decorator';
import { isPlanRenewalEnabled } from './plan-renewal.cadence';
import { PlanRenewalService } from './plan-renewal.service';

export class PlanRenewalAckDto {
  @IsInt()
  step!: number;
}

export class PlanRenewalSettingsDto {
  @IsBoolean()
  messages_enabled!: boolean;
}

/** Every FEATURE_PLAN_RENEWAL route answers this while the flag is off (CHURN-BE's routes too). */
export function assertOn(): void {
  if (!isPlanRenewalEnabled()) {
    throw new NotFoundException({ code: 'PLAN_RENEWAL_OFF', error: 'PLAN_RENEWAL_OFF', message: 'Plan renewal is not available.' });
  }
}

/**
 * RENEWAL-BE routes (contract: ops164/work/RENEWAL-BE-contract.md). Every route
 * is 404 PLAN_RENEWAL_OFF while FEATURE_PLAN_RENEWAL is off, and scoped to the
 * caller's own id: the client acknowledges only their own pop-up, the coach
 * reads and writes only their own switch.
 */
@ApiTags('checkout')
@Controller()
@UseGuards(JwtAuthGuard)
export class PlanRenewalController {
  constructor(private readonly renewal: PlanRenewalService) {}

  @Post('v1/checkout/renewal/popup-ack')
  @HttpCode(200)
  @Roles('student')
  @SkipClientEntitlement()
  ack(@Request() req: AuthedRequest, @Body() body: PlanRenewalAckDto) {
    assertOn();
    return this.renewal.ackPopup(req.user.id, body.step);
  }

  @Get('v1/coach/plan-renewal/settings')
  @Roles('coach')
  settings(@Request() req: AuthedRequest) {
    assertOn();
    return this.renewal.coachSettings(req.user.id);
  }

  @Put('v1/coach/plan-renewal/settings')
  @Roles('coach')
  setSettings(@Request() req: AuthedRequest, @Body() body: PlanRenewalSettingsDto) {
    assertOn();
    return this.renewal.setCoachSettings(req.user.id, body.messages_enabled);
  }
}
