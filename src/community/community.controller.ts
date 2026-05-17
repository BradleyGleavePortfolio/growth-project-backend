import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  GoneException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PostWinDto } from './community.dto';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';

@ApiTags('community')
@Controller('community')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class CommunityController {
  constructor(private communityService: CommunityService) {}

  /**
   * GET /community/leaderboard
   * Returns workout-volume leaderboard for the caller's coach roster.
   */
  @Get('leaderboard')
  async getLeaderboard(
    @Request() req: AuthedRequest,
    @Query('period') period?: 'week' | 'month',
  ) {
    return this.communityService.getLeaderboard(req.user.id, period || 'week');
  }

  /**
   * GET /community/feed
   * Returns the last 30 anonymised community wins.
   * Response: [{ id, displayName, action, createdAt }]
   */
  @Get('feed')
  async getFeed(@Request() req: AuthedRequest) {
    return this.communityService.getFeed(req.user.id);
  }

  /**
   * POST /community/wins
   * Creates a new community win entry for the current user.
   * Body: { title, description, visibility?: "circle" | "public" }
   */
  @Post('wins')
  async postWin(@Request() req: AuthedRequest, @Body() body: PostWinDto) {
    return this.communityService.postWin(req.user.id, body);
  }

  /**
   * POST /community/wins/:id/react — REMOVED (doctrine cleanup).
   * Per-Win reactions are no longer part of the product surface; the route
   * returns 410 Gone for one mobile release window before being deleted.
   */
  // TODO: remove route entirely after one mobile release window.
  @Post('wins/:id/react')
  @HttpCode(410)
  async reactToWin() {
    throw new GoneException(
      'This endpoint has been removed. Reactions on community wins are no longer part of the product surface.',
    );
  }
}
