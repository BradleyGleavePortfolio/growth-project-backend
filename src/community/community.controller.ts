import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PostWinDto, ReactToWinDto } from './community.dto';

@Controller('community')
@UseGuards(JwtAuthGuard)
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
   * Returns the last 30 anonymised community wins with reaction counts.
   * Response: [{ id, displayName, action, createdAt, reactions: { fire, clap } }]
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
   * POST /community/wins/:id/react
   * Adds (or toggles off) a fire/clap reaction on a community win.
   * Body: { kind: "fire" | "clap" }
   * Returns: { fire: number, clap: number }
   */
  @Post('wins/:id/react')
  async reactToWin(
    @Request() req: AuthedRequest,
    @Param('id') winId: string,
    @Body() body: ReactToWinDto,
  ) {
    return this.communityService.reactToWin(req.user.id, winId, body.kind);
  }
}
