import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityCoachInboxService } from './community-coach-inbox.service';
import { CoachInboxQueryDto } from './community-coach-inbox.dto';

/**
 * v1-6 coach inbox — GET /community/me/coach-inbox.
 *
 * Guard order: JwtAuthGuard → RolesGuard → CommunityFeatureFlagGuard (503 when
 * the master flag is off). @Roles('coach','owner') is the coarse gate; the
 * service additionally requires the caller to coach at least one cohort
 * (coachedCohortIds non-empty → otherwise 403 not_coach). Every returned item
 * is bounded to cohorts the caller coaches.
 */
@ApiTags('community')
@Controller('community')
export class CommunityCoachInboxController {
  constructor(private readonly inbox: CommunityCoachInboxService) {}

  @Get('me/coach-inbox')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Query() query: CoachInboxQueryDto,
  ) {
    return this.inbox.list(req.user, query);
  }
}
