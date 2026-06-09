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
import {
  CommunityMessagesEnabledGuard,
  CommunityPostsEnabledGuard,
} from '../community-write-flag.guard';
import { CommunityPostsService } from './community-posts.service';
import {
  CreateCommentDto,
  CreatePostDto,
  EditPostDto,
  ListPostsQueryDto,
} from '../dto/community-post.dto';

/**
 * Lab posts + comments.
 *
 * Post writes are gated by CommunityPostsEnabledGuard (FEATURE_COMMUNITY_POSTS);
 * comment writes are gated by CommunityMessagesEnabledGuard
 * (FEATURE_COMMUNITY_MESSAGES) per the brief — comments are a messaging surface.
 * GETs carry only the master CommunityFeatureFlagGuard so reads survive a write
 * kill switch.
 */
@ApiTags('community')
@Controller('community')
export class CommunityPostsController {
  constructor(private readonly posts: CommunityPostsService) {}

  @Post('workspaces/:workspaceId/posts')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityPostsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreatePostDto,
  ) {
    return this.posts.create(req.user, workspaceId, body);
  }

  @Get('workspaces/:workspaceId/posts')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListPostsQueryDto,
  ) {
    return this.posts.list(req.user, workspaceId, query);
  }

  @Get('posts/:postId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
  ) {
    return this.posts.getOne(req.user, postId);
  }

  @Patch('posts/:postId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityPostsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async edit(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() body: EditPostDto,
  ) {
    return this.posts.edit(req.user, postId, body);
  }

  @Delete('posts/:postId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityPostsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async remove(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
  ) {
    return this.posts.remove(req.user, postId);
  }

  @Post('posts/:postId/comments')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityMessagesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_COMMENTS_PER_MIN },
  })
  async addComment(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
    @Body() body: CreateCommentDto,
  ) {
    return this.posts.addComment(req.user, postId, body.body);
  }

  @Get('posts/:postId/comments')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async listComments(
    @Request() req: AuthedRequest,
    @Param('postId') postId: string,
  ) {
    return this.posts.listComments(req.user, postId);
  }
}
