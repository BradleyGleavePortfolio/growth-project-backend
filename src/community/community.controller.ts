import { Controller, Get, Post, Body, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PostWinDto } from './community.dto';

@Controller('community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(private communityService: CommunityService) {}

  @Get('leaderboard')
  async getLeaderboard(@Request() req: AuthedRequest, @Query('period') period?: 'week' | 'month') {
    return this.communityService.getLeaderboard(req.user.id, period || 'week');
  }

  @Get('feed')
  async getFeed(@Request() req: AuthedRequest) {
    return this.communityService.getFeed(req.user.id);
  }

  @Post('wins')
  async postWin(@Request() req: AuthedRequest, @Body() body: PostWinDto) {
    return this.communityService.postWin(req.user.id, body);
  }
}
