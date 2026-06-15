/**
 * RefundDecisionsController — F2 partial-refund coach-decision REST surface.
 *
 * Mounted at /coach/refunds. CLASS-LEVEL @Roles('coach') gates every handler
 * (R80 lesson) and NamedRegimesFeatureGuard at the class level 404s every
 * route while FEATURE_NAMED_REGIMES is OFF.
 *
 * Routes:
 *   GET  /coach/refunds/pending-decisions   list pending partial-refund decisions
 *   POST /coach/refunds/:refundId/decide    apply keep_drops | unassign_drops
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NamedRegimesFeatureGuard } from './named-regimes-feature.guard';
import { DecideRefundDto } from './regimes.dto';
import { PartialRefundDecisionService } from './partial-refund-decision.service';

@ApiTags('regimes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, NamedRegimesFeatureGuard)
@Roles('coach')
@Controller('coach/refunds')
export class RefundDecisionsController {
  constructor(private readonly decisions: PartialRefundDecisionService) {}

  @Get('pending-decisions')
  async pending(@Req() req: AuthedRequest) {
    return this.decisions.listPendingForCoach(req.user.id);
  }

  // Most critical write route on this surface — applies a financial decision
  // that calls cancelPendingForPurchase (cancels ScheduledDrop rows), an
  // irreversible effect. Tightest cap of the F4 set (per-user 10/min) since
  // 300/min global default is insufficient for a route with write
  // amplification + financial impact (R81 F4).
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':refundId/decide')
  async decide(
    @Req() req: AuthedRequest,
    @Param('refundId') refundId: string,
    @Body() body: DecideRefundDto,
  ) {
    return this.decisions.decide(req.user.id, refundId, body.decision);
  }
}
