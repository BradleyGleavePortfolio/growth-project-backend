import {
  Body,
  Controller,
  Delete,
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
import { CommunityMessagesEnabledGuard } from '../community-write-flag.guard';
import { CommunityMessagesService } from './community-messages.service';
import {
  CreateMessageDto,
  EditMessageDto,
  ListMessagesQueryDto,
} from '../dto/community-message.dto';

/**
 * Cohort-channel messages.
 *
 * Guard order matches v1-2: JwtAuthGuard → RolesGuard → CommunityFeatureFlagGuard
 * (master switch) → CommunityMessagesEnabledGuard (write kill switch). The
 * write guard is mounted ONLY on POST/PATCH/DELETE so GETs stay reachable when
 * FEATURE_COMMUNITY_MESSAGES is off (kill-switch semantics: reads survive, writes
 * return the typed disabled body). @Roles('student') is reachable by coach/owner
 * via the role hierarchy, so cohort chat is bidirectional.
 */
@ApiTags('community')
@Controller('community')
export class CommunityMessagesController {
  constructor(private readonly messages: CommunityMessagesService) {}

  @Post('cohorts/:cohortId/messages')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityMessagesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MESSAGES_PER_MIN },
  })
  async send(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Body() body: CreateMessageDto,
  ) {
    return this.messages.send(req.user, cohortId, body.body, body.plan_context);
  }

  @Get('cohorts/:cohortId/messages')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messages.list(req.user, cohortId, query);
  }

  @Get('messages/:messageId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.getOne(req.user, messageId);
  }

  @Patch('messages/:messageId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityMessagesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MSG_EDIT_PER_MIN },
  })
  async edit(
    @Request() req: AuthedRequest,
    @Param('messageId') messageId: string,
    @Body() body: EditMessageDto,
  ) {
    return this.messages.edit(req.user, messageId, body.body);
  }

  @Delete('messages/:messageId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityMessagesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MSG_EDIT_PER_MIN },
  })
  async remove(
    @Request() req: AuthedRequest,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.remove(req.user, messageId);
  }
}
