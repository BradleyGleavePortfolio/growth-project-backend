import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityCohortParamsSchema } from '../dto/community-cohort.dto';
import { CommunityCohortMembersService } from './community-cohort-members.service';
import {
  AssignMemberDto,
  ListMembersQueryDto,
} from './community-cohort-members.dto';

/**
 * v1-6 coach cohort membership administration — roster / assign / remove.
 *
 * Guard order: JwtAuthGuard → RolesGuard → CommunityFeatureFlagGuard. The
 * roster GET is reachable by @Roles('student','coach','owner') because a
 * fellow active member may read the (sanitized) roster; the service then
 * decides coach-vs-member view and 404s a non-member. Assign/remove are
 * @Roles('coach','owner') and additionally gated by the service's
 * assertWorkspaceCoach (per-workspace ownership, derived from the JWT user).
 */
@ApiTags('community')
@Controller('community')
export class CommunityCohortMembersController {
  constructor(private readonly members: CommunityCohortMembersService) {}

  @Get('cohorts/:cohortId/members')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.members.list(req.user, id, query);
  }

  @Post('cohorts/:cohortId/members')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async assign(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Body() body: AssignMemberDto,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.members.assign(req.user, id, body);
  }

  @Delete('cohorts/:cohortId/members/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async remove(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Param('userId') userId: string,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.members.remove(req.user, id, userId);
  }
}
