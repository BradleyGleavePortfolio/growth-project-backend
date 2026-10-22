/**
 * SC-BE2: the space chat's read line. Reads only: the community API switch (CommunityFeatureFlagGuard) and
 * FEATURE_COMMUNITY_SPACE_CHAT (the service; off = 404) gate both routes. Access is the messages routes'
 * check: 404 for an unknown space, 403 for one the caller cannot read now (another coach's, a members-only
 * space they are not in, a ban).
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySpaceReadsService, type SpaceRead } from './community-space-reads.service';

/** POST /community/cohorts/:cohortId/read */
export class MarkSpaceReadDto {
  @IsUUID()
  message_id!: string;
}

@ApiTags('community')
@Controller('community')
@UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
@Roles('student', 'coach', 'owner')
export class CommunitySpaceReadsController {
  constructor(private readonly reads: CommunitySpaceReadsService) {}

  @Get('cohorts/:cohortId/read')
  getRead(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceRead> {
    return this.reads.getRead(req.user, cohortId);
  }

  @Post('cohorts/:cohortId/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() body: MarkSpaceReadDto,
  ): Promise<SpaceRead> {
    return this.reads.markRead(req.user, cohortId, body.message_id);
  }
}
