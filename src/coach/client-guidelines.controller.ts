import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { CoachService } from './coach.service';

/**
 * GUIDE-READ-128: the client's read of the guidelines their coach wrote for
 * them (the Coach guidelines screen on the Train tab).
 *
 * The route used to live in CoachController, whose class-level CoachGuard
 * answered every client with 403, so the screen could never load. The path
 * stays GET /coach/my-guidelines so every installed build of the app works as
 * soon as this deploys, with no app change.
 *
 * Privacy: req.user.id is the only input (no params, no query). The service
 * reads the one row written for this client by their current coach and
 * returns only its text and dates. Guards match the other client reads
 * (check-ins, meal plans): student role, plus the client package check.
 */
@ApiTags('coach')
@Controller('coach')
@UseGuards(JwtAuthGuard, RolesGuard, ClientEntitlementGuard)
@Roles('student')
export class ClientGuidelinesController {
  constructor(private readonly coachService: CoachService) {}

  @Get('my-guidelines')
  @ApiOperation({
    summary: "The signed-in client's guidelines from their current coach (empty body when there are none)",
  })
  async getMyGuidelines(@Request() req: AuthedRequest) {
    return this.coachService.getClientGuidelines(req.user.id);
  }
}
