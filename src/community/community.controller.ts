import { Controller, Get, Post, Body, Query, UseGuards, Request } from '@nestjs/common';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('community')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(private communityService: CommunityService) {}

  @Get('leaderboard')
  async getLeaderboard(@Request() req, @Query('period') period?: 'week' | 'month') {
    return this.communityService.getLeaderboard(req.user.id, period || 'week');
  }

  @Get('feed')
  async getFeed(@Request() req) {
    return this.communityService.getFeed(req.user.id);
  }

  @Post('wins')
  async postWin(@Request() req, @Body() body: any) {
    return this.communityService.postWin(req.user.id, body);
  }
}
