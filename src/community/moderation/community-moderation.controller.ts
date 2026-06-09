import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunityModerationService } from './community-moderation.service';
import {
  ActOnItemDto,
  CreateReportDto,
} from '../dto/community-moderation.dto';

/**
 * Report → review → action moderation.
 *
 * CRITICAL: these routes carry ONLY JwtAuthGuard → RolesGuard →
 * CommunityFeatureFlagGuard. They do NOT carry the message/post/DM write kill
 * switches, so moderation stays available during a content freeze (brief hard
 * requirement). Filing a report is open to any member (@Roles student); queue
 * read and item action are coach/owner — enforced in the service via
 * assertModerator (role + workspace ownership), not by @Roles alone, because a
 * student must reach POST /reports but never the queue.
 */
@ApiTags('community')
@Controller('community')
export class CommunityModerationController {
  constructor(private readonly moderation: CommunityModerationService) {}

  @Post('moderation/reports')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 300_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REPORTS_PER_5MIN },
  })
  async report(
    @Request() req: AuthedRequest,
    @Body() body: CreateReportDto,
  ) {
    return this.moderation.report(
      req.user,
      body.target_type,
      body.target_id,
      body.reason,
      body.notes,
    );
  }

  @Get('workspaces/:workspaceId/moderation/queue')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async queue(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.moderation.listQueue(req.user, workspaceId, { status, limit });
  }

  @Patch('moderation/items/:itemId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async act(
    @Request() req: AuthedRequest,
    @Param('itemId') itemId: string,
    @Body() body: ActOnItemDto,
  ) {
    return this.moderation.act(req.user, itemId, body.action, body.notes);
  }
}
