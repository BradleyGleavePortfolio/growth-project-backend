import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../../common/decorators/skip-client-entitlement.decorator';
import { ClientDunningStatus, DunningV2Service } from './dunning-v2.service';

/**
 * GET /v1/checkout/dunning — the signed-in client's own non-payment status,
 * read by the mobile app to render the Days 0-9 banner and the Day-10
 * lockout screen (amount, lockout date, coach name, card on file).
 *
 * Reachable while locked (it sits under the allow-listed `checkout` head) and
 * while past_due (skips the client entitlement gate). Scoped to req.user.id;
 * read-only. With FEATURE_DUNNING_V2 off it returns `{ enabled: false,
 * state: 'none' }` so the app renders nothing.
 */
@ApiTags('checkout')
@Controller('v1/checkout/dunning')
@UseGuards(JwtAuthGuard)
export class DunningStatusController {
  constructor(private readonly dunningV2: DunningV2Service) {}

  @Get()
  @Roles('student', 'coach', 'owner')
  @SkipClientEntitlement()
  async status(@Req() req: AuthedRequest): Promise<ClientDunningStatus> {
    return this.dunningV2.getClientStatus(req.user.id);
  }
}
