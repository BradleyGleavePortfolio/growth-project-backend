import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CommunityAlwaysReachable,
  CommunityFeatureFlagGuard,
} from '../community-feature-flag.guard';
import { CommunitySafetyService } from './community-safety.service';

export class BlockUserDto {
  @IsUUID()
  user_id!: string;
}

/**
 * Community safety routes (Apple 1.2): block / unblock / list blocks and the
 * published safety contact. Same guard stack as the rest of the community API
 * (JwtAuthGuard -> RolesGuard -> CommunityFeatureFlagGuard), but every route
 * is @CommunityAlwaysReachable (B-610-1): member wins (More > Community) are
 * live whatever FEATURE_COMMUNITY_API says, so the safety contact, block,
 * unblock, the blocked list and moderation notices must stay reachable
 * wherever wins are. Like moderation, these routes deliberately do NOT carry
 * the write kill switches: a member must be able to block during a content
 * freeze.
 */
@ApiTags('community')
@Controller('community')
export class CommunitySafetyController {
  constructor(private readonly safety: CommunitySafetyService) {}

  @Get('safety')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  info() {
    return this.safety.safetyInfo();
  }

  @Get('blocks')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  list(@Request() req: AuthedRequest) {
    return this.safety.listBlocks(req.user);
  }

  @Post('blocks')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  block(@Request() req: AuthedRequest, @Body() body: BlockUserDto) {
    return this.safety.block(req.user, body.user_id);
  }

  @Delete('blocks/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  unblock(@Request() req: AuthedRequest, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.safety.unblock(req.user, userId);
  }

  /** B-610-4: the caller's own moderation notices (warn / hide / ban). */
  @Get('safety/notices')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  notices(@Request() req: AuthedRequest) {
    return this.safety.listNotices(req.user);
  }

  @Post('safety/notices/:noticeId/read')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  markNoticeRead(
    @Request() req: AuthedRequest,
    @Param('noticeId', new ParseUUIDPipe()) noticeId: string,
  ) {
    return this.safety.markNoticeRead(req.user, noticeId);
  }
}
