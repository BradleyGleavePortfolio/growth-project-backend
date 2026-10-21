import { Body, Controller, HttpCode, NotFoundException, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt } from 'class-validator';
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

/**
 * RENEWAL-BE route (CONTRACT comment on b#1127): 404 PLAN_RENEWAL_OFF while
 * FEATURE_PLAN_RENEWAL is off; the client acknowledges only their own pop-up.
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
    if (!isPlanRenewalEnabled()) {
      throw new NotFoundException({ code: 'PLAN_RENEWAL_OFF', error: 'PLAN_RENEWAL_OFF', message: 'Plan renewal is not available.' });
    }
    return this.renewal.ackPopup(req.user.id, body.step);
  }
}
