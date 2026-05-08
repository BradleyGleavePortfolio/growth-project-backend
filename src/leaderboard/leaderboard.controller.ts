// Phase 7C — Leaderboard Controller.
//
// Routes:
//   GET  /me/leaderboard        — returns the requesting user's coach-roster
//                                  leaderboard. Only opted-in users appear.
//                                  The requester always sees their own rank.
//   POST /me/leaderboard/opt-in — body: { enabled: boolean, displayName?: string }
//
// Auth: JwtAuthGuard is registered globally in AppModule; no explicit
// @UseGuards decorator is needed here. The requester's identity is read
// from req.user.id (injected by the guard from the verified JWT payload).

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';
import { OptInDto } from './leaderboard.dto';
import type { AuthedRequest } from '../auth/auth-request';

@ApiTags('leaderboard')
@Controller('me/leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  /**
   * GET /me/leaderboard
   *
   * Returns the ranked leaderboard scoped to the requesting user's coach
   * roster. Only clients who have opted in appear in the list.
   *
   * The requester's row is always returned (with their rank) even if they
   * have not yet opted in — the UI uses this to render the opt-in card
   * inline within the leaderboard view.
   *
   * Response shape:
   * {
   *   entries: Array<{
   *     rank: number,
   *     userId: string,
   *     displayName: string,
   *     combinedScore: number,   // 0–100
   *     weekDelta: number | null,
   *     isRequester: boolean,
   *   }>,
   *   selfRank: number | null,
   * }
   */
  @Get()
  async getLeaderboard(@Request() req: AuthedRequest) {
    return this.leaderboard.getLeaderboard(req.user.id);
  }

  /**
   * POST /me/leaderboard/opt-in
   *
   * Opts the requesting user in or out.
   *
   * Body: { enabled: boolean, displayName?: string }
   *
   * When enabled=false: removes the user from the leaderboard immediately
   * and clears their cached score. Their display name is also cleared.
   *
   * When enabled=true and displayName is omitted: the service derives
   * "{firstName} {lastInitial}." from the user's profile.
   */
  @Post('opt-in')
  @HttpCode(HttpStatus.OK)
  async optIn(
    @Request() req: AuthedRequest,
    @Body() dto: OptInDto,
  ) {
    await this.leaderboard.setOptIn(req.user.id, dto.enabled, dto.displayName);
    return { success: true, enabled: dto.enabled };
  }
}
