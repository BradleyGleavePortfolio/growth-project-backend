/**
 * SC-PUSH: before a coach sends a High alert, the phone shows how many people it will reach and how many of
 * today's 3 are used. Same access as the messages routes (404 unknown space, 403 no access); then the coach of
 * the space only (403 `community.high_alert.coach_only`). Opus C-6: 404 while FEATURE_COMMUNITY_SPACE_PUSH is off.
 */
import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySpacePushService, type HighAlertAllowance } from './community-space-push.service';
import { spacePushOn } from './space-push-policy';

@ApiTags('community')
@Controller('community/cohorts/:cohortId/high-alert')
@UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
@Roles('coach', 'owner')
export class CommunitySpacePushController {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly push: CommunitySpacePushService,
  ) {}

  @Get('preview')
  async preview(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<HighAlertAllowance> {
    if (!spacePushOn()) throw new NotFoundException({ code: 'community.cohort.not_found' });
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort) throw new NotFoundException({ code: 'community.cohort.not_found' });
    if (!(await this.access.canAccessCohort(cohort, req.user))) throw new ForbiddenException({ code: 'community.cohort.no_access' });
    return this.push.highAlertAllowance(req.user.id, cohort);
  }
}
