import {
  Body,
  Controller,
  Get,
  Param,
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
import { CommunityDmEnabledGuard } from '../community-write-flag.guard';
import { CommunityDmsService } from './community-dms.service';
import { CreateDmThreadDto, SendDmDto } from '../dto/community-dm.dto';

/**
 * 1:1 direct messages within a workspace.
 *
 * Threads are keyed by participant pair (no separate thread row), so the
 * recipient user id is the thread handle. Writes carry CommunityDmEnabledGuard
 * (FEATURE_COMMUNITY_DM); reads carry only the master flag so an in-flight
 * conversation stays readable if DM writes are paused. Eligibility (membership +
 * dm_enabled tri-state) is enforced in the service, not the guard — the guard is
 * the global on/off, the service is the per-pair policy.
 */
@ApiTags('community')
@Controller('community')
export class CommunityDmsController {
  constructor(private readonly dms: CommunityDmsService) {}

  @Get('workspaces/:workspaceId/dms')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async listThreads(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.dms.listThreads(req.user, workspaceId, { limit });
  }

  @Post('workspaces/:workspaceId/dms')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityDmEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_DM_PER_MIN },
  })
  async openThread(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateDmThreadDto,
  ) {
    return this.dms.openThread(req.user, workspaceId, body.recipient_user_id);
  }

  @Get('workspaces/:workspaceId/dms/:recipientId/messages')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async listThread(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('recipientId') recipientId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dms.listThread(req.user, workspaceId, recipientId, {
      before,
      limit,
    });
  }

  @Post('workspaces/:workspaceId/dms/:recipientId/messages')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityDmEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_DM_PER_MIN },
  })
  async send(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('recipientId') recipientId: string,
    @Body() body: SendDmDto,
  ) {
    return this.dms.send(req.user, workspaceId, recipientId, body.body);
  }
}
