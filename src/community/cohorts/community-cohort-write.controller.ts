import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityWorkspaceParamsSchema } from '../dto/community-workspace.dto';
import { CommunityCohortParamsSchema } from '../dto/community-cohort.dto';
import { CommunityCohortWriteService } from './community-cohort-write.service';
import { CreateCohortDto, UpdateCohortDto } from './community-cohort.dto';

/**
 * v1-6 coach cohort administration — create / update / archive.
 *
 * Guard order matches the v1-2/v1-3 community surfaces: JwtAuthGuard →
 * RolesGuard → CommunityFeatureFlagGuard (master switch; 503 when off). These
 * are write routes, but cohort administration is NOT behind the per-feature
 * message/post/DM kill switches — those gate member content, not coach setup.
 *
 * @Roles('coach', 'owner') is the coarse gate; the fine-grained "owns THIS
 * workspace" check lives in the service (assertWorkspaceCoach), exactly like
 * moderation's assertModerator, because @Roles cannot express per-workspace
 * ownership. A student never reaches these handlers.
 */
@ApiTags('community')
@Controller('community')
export class CommunityCohortWriteController {
  constructor(private readonly cohorts: CommunityCohortWriteService) {}

  @Post('workspaces/:workspaceId/cohorts')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateCohortDto,
  ) {
    const { workspaceId: id } = CommunityWorkspaceParamsSchema.parse({
      workspaceId,
    });
    return this.cohorts.create(req.user, id, body);
  }

  @Patch('cohorts/:cohortId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async update(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Body() body: UpdateCohortDto,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.cohorts.update(req.user, id, body);
  }

  @Delete('cohorts/:cohortId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async archive(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.cohorts.archive(req.user, id);
  }
}
