import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
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
import { CommunityReactionsService } from './community-reactions.service';
import { ReactDto } from '../dto/community-reaction.dto';

/**
 * Emoji reactions on messages, posts, and comments.
 *
 * Reactions are a lightweight engagement surface: they carry only the master
 * CommunityFeatureFlagGuard, NOT the per-write kill switches. Reacting stays
 * available even when message/post writes are paused — a deliberate choice so a
 * write freeze doesn't also freeze acknowledgement. Comment reactions use the
 * `/responses/:responseId/reactions` path from the brief; `responseId` is the
 * CommunityMessage id of the comment (comments are stored as messages).
 */
@ApiTags('community')
@Controller('community')
export class CommunityReactionsController {
  constructor(private readonly reactions: CommunityReactionsService) {}

  @Post('messages/:messageId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async reactMessage(
    @Request() req: AuthedRequest,
    @Param('messageId') messageId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.react(req.user, 'message', messageId, body.emoji);
  }

  @Delete('messages/:messageId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async unreactMessage(
    @Request() req: AuthedRequest,
    @Param('messageId') messageId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.unreact(req.user, 'message', messageId, body.emoji);
  }

  @Post('posts/:postId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async reactPost(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.react(req.user, 'post', postId, body.emoji);
  }

  @Delete('posts/:postId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async unreactPost(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.unreact(req.user, 'post', postId, body.emoji);
  }

  @Post('responses/:responseId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async reactComment(
    @Request() req: AuthedRequest,
    @Param('responseId') responseId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.react(req.user, 'comment', responseId, body.emoji);
  }

  @Delete('responses/:responseId/reactions')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REACTIONS_PER_MIN },
  })
  async unreactComment(
    @Request() req: AuthedRequest,
    @Param('responseId') responseId: string,
    @Body() body: ReactDto,
  ) {
    return this.reactions.unreact(req.user, 'comment', responseId, body.emoji);
  }
}
