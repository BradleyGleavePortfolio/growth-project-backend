import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { CommunityClassroomEnabledGuard } from './community-classroom-flag.guard';
import { CommunityClassroomService } from './community-classroom.service';
import {
  AttachClassroomMediaDto,
  CreateClassroomPostDto,
  ListClassroomQueryDto,
  PublishClassroomPostDto,
  UpdateClassroomPostDto,
} from './community-classroom.dto';

/**
 * Community classroom posts (v3-2) — media-backed lessons.
 *
 * Write handlers (coach create / edit / publish / archive / media attach) carry
 * the master CommunityFeatureFlagGuard PLUS the CommunityClassroomEnabledGuard
 * (FEATURE_COMMUNITY_CLASSROOM_POSTS, default off). The feed + detail GET
 * handlers carry ONLY the master guard, so a student's already-released lessons
 * stay readable if the authoring surface is killed mid-rollout. Coach-only
 * operations are enforced in the SERVICE (workspace ownership), not by @Roles
 * alone, because students must reach the read routes. Write limits reuse the
 * existing community throttle buckets (no new config).
 */
@ApiTags('community')
@Controller('community')
export class CommunityClassroomController {
  constructor(private readonly classroom: CommunityClassroomService) {}

  // ── Coach CRUD ──────────────────────────────────────────────────────────────

  @Post('workspaces/:workspaceId/classroom')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityClassroomEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: CreateClassroomPostDto,
  ) {
    return this.classroom.create(req.user, workspaceId, body);
  }

  @Patch('classroom/:postId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityClassroomEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async update(
    @Request() req: AuthedRequest,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() body: UpdateClassroomPostDto,
  ) {
    return this.classroom.update(req.user, postId, body);
  }

  @Post('classroom/:postId/publish')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityClassroomEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async publish(
    @Request() req: AuthedRequest,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() body: PublishClassroomPostDto,
  ) {
    return this.classroom.publish(req.user, postId, body);
  }

  @Post('classroom/:postId/media')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityClassroomEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async attachMedia(
    @Request() req: AuthedRequest,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() body: AttachClassroomMediaDto,
  ) {
    return this.classroom.attachMedia(req.user, postId, body.media);
  }

  @Post('classroom/:postId/archive')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityClassroomEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async archive(
    @Request() req: AuthedRequest,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
  ) {
    return this.classroom.archive(req.user, postId);
  }

  // ── Reads (master guard only) ───────────────────────────────────────────────

  @Get('workspaces/:workspaceId/classroom')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async listFeed(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Query() query: ListClassroomQueryDto,
  ) {
    return this.classroom.listFeed(req.user, workspaceId, query);
  }

  @Get('classroom/:postId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
  ) {
    return this.classroom.getOne(req.user, postId);
  }
}
