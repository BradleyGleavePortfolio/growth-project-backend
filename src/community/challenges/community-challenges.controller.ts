import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { CommunityChallengesEnabledGuard } from './community-challenges-flag.guard';
import { CommunityChallengesService } from './community-challenges.service';
import { CreateReportDto } from '../dto/community-moderation.dto';
import {
  CreateChallengeCommentDto,
  CreateChallengeDto,
  EditChallengeDto,
  LeaderboardOptInDto,
  ListChallengesQueryDto,
  UpdateProgressDto,
} from './community-challenges.dto';

/**
 * Community challenges (v3-1).
 *
 * Write handlers carry the master CommunityFeatureFlagGuard PLUS the
 * CommunityChallengesEnabledGuard (FEATURE_COMMUNITY_CHALLENGES, default off).
 * GET handlers carry ONLY the master guard, so active progress stays readable
 * when the challenge surface is killed. Coach-only operations (create / edit /
 * archive) are additionally enforced in the service (workspace ownership), not
 * by @Roles alone, because clients must reach join/progress/comment routes.
 * Write limits reuse the existing community throttle buckets (no new config).
 */
@ApiTags('community')
@Controller('community')
export class CommunityChallengesController {
  constructor(private readonly challenges: CommunityChallengesService) {}

  // ── Coach CRUD ──────────────────────────────────────────────────────────────

  @Post('workspaces/:workspaceId/challenges')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: CreateChallengeDto,
  ) {
    return this.challenges.create(req.user, workspaceId, body);
  }

  @Patch('challenges/:challengeId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async edit(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
    @Body() body: EditChallengeDto,
  ) {
    return this.challenges.edit(req.user, challengeId, body);
  }

  @Post('challenges/:challengeId/archive')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async archive(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
  ) {
    return this.challenges.archive(req.user, challengeId);
  }

  // ── Reads (master guard only) ───────────────────────────────────────────────

  @Get('workspaces/:workspaceId/challenges')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Query() query: ListChallengesQueryDto,
  ) {
    return this.challenges.list(req.user, workspaceId, query);
  }

  @Get('challenges/:challengeId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
  ) {
    return this.challenges.getOne(req.user, challengeId);
  }

  @Get('challenges/:challengeId/leaderboard')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async leaderboard(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
  ) {
    return this.challenges.getLeaderboard(req.user, challengeId);
  }

  @Get('challenges/:challengeId/comments')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async listComments(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
  ) {
    return this.challenges.listComments(req.user, challengeId);
  }

  // ── Participation writes ──────────────────────────────────────────────────

  @Post('challenges/:challengeId/join')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async join(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
  ) {
    return this.challenges.join(req.user, challengeId);
  }

  @Put('challenges/:challengeId/progress')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MESSAGES_PER_MIN },
  })
  async updateProgress(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
    @Body() body: UpdateProgressDto,
  ) {
    return this.challenges.updateProgress(
      req.user,
      challengeId,
      body.progress_value,
    );
  }

  @Put('challenges/:challengeId/leaderboard-opt-in')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN },
  })
  async leaderboardOptIn(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
    @Body() body: LeaderboardOptInDto,
  ) {
    return this.challenges.setLeaderboardOptIn(
      req.user,
      challengeId,
      body.opted_in,
    );
  }

  @Post('challenges/:challengeId/comments')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_COMMENTS_PER_MIN },
  })
  async addComment(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
    @Body() body: CreateChallengeCommentDto,
  ) {
    return this.challenges.addComment(req.user, challengeId, body.body);
  }

  @Post('challenges/:challengeId/comments/:commentId/report')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityChallengesEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: { ttl: 300_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_REPORTS_PER_5MIN },
  })
  async reportComment(
    @Request() req: AuthedRequest,
    @Param('challengeId', new ParseUUIDPipe({ version: '4' }))
    challengeId: string,
    @Param('commentId', new ParseUUIDPipe({ version: '4' }))
    commentId: string,
    @Body() body: CreateReportDto,
  ) {
    return this.challenges.reportComment(
      req.user,
      challengeId,
      commentId,
      body.reason,
      body.notes,
    );
  }
}
