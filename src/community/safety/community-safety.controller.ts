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
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { CommunitySafetyService } from './community-safety.service';

export class BlockUserDto {
  @IsUUID()
  user_id!: string;
}

/**
 * Community safety routes (Apple 1.2): block / unblock / list blocks and the
 * published safety contact. Same guard stack as the rest of the community API
 * (JwtAuthGuard -> RolesGuard -> CommunityFeatureFlagGuard), so the whole
 * surface stays behind FEATURE_COMMUNITY_API. Like moderation, these routes
 * deliberately do NOT carry the write kill switches: a member must be able to
 * block during a content freeze.
 */
@ApiTags('community')
@Controller('community')
export class CommunitySafetyController {
  constructor(private readonly safety: CommunitySafetyService) {}

  @Get('safety')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  info() {
    return this.safety.safetyInfo();
  }

  @Get('blocks')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  list(@Request() req: AuthedRequest) {
    return this.safety.listBlocks(req.user);
  }

  @Post('blocks')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  block(@Request() req: AuthedRequest, @Body() body: BlockUserDto) {
    return this.safety.block(req.user, body.user_id);
  }

  @Delete('blocks/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  unblock(@Request() req: AuthedRequest, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.safety.unblock(req.user, userId);
  }
}
