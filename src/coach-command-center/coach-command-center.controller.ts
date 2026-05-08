import {
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CoachCommandCenterService } from './coach-command-center.service';
import { ActionQueueQueryDto, CcPageQueryDto } from './coach-command-center.dto';
import { RiskBoardQueryDto } from '../admin/ptm/admin-ptm.dto';

/**
 * Coach Command Center — Phase 8.
 *
 * Unified read-aggregation surface for coaches. Every endpoint:
 *   * Requires a valid JWT (JwtAuthGuard) AND coach/owner role (CoachGuard).
 *   * Scopes exclusively to req.user.id — the caller CANNOT influence which
 *     roster is queried. This is the primary cross-coach isolation guarantee.
 *   * Delegates all risk math to AdminPtmService; no duplicate bucket logic.
 */
@ApiTags('coach-command-center')
@Controller('coach/command-center')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachCommandCenterController {
  constructor(private readonly svc: CoachCommandCenterService) {}

  // -----------------------------------------------------------------------
  // GET /coach/command-center/overview
  // -----------------------------------------------------------------------
  @Get('overview')
  @ApiOperation({
    summary:
      'Aggregated overview for the Coach Command Center home tab. ' +
      'Returns counts, top alerts, and top win streaks in a single payload.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Overview payload for this coach. Scoped to req.user.id — no cross-coach leakage.',
  })
  @ApiResponse({ status: 403, description: 'Caller does not hold coach or owner role.' })
  async getOverview(@Request() req: AuthedRequest) {
    // Privacy: req.user.id is the ONLY scope source.
    return this.svc.getOverview(req.user.id);
  }

  // -----------------------------------------------------------------------
  // GET /coach/command-center/at-risk
  // -----------------------------------------------------------------------
  @Get('at-risk')
  @ApiOperation({
    summary:
      'Paginated at-risk client list for this coach. Delegates to ' +
      'AdminPtmService.getRiskBoardForCoach — no duplicate risk math.',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated at-risk rows.' })
  @ApiResponse({ status: 403, description: 'Caller does not hold coach or owner role.' })
  async getAtRisk(@Request() req: AuthedRequest, @Query() query: RiskBoardQueryDto) {
    return this.svc.getAtRisk(req.user.id, {
      bucket: query.bucket,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  // -----------------------------------------------------------------------
  // GET /coach/command-center/win-streaks
  // -----------------------------------------------------------------------
  @Get('win-streaks')
  @ApiOperation({
    summary:
      'Paginated win-streak leaderboard for this coach\'s active clients. ' +
      'Sorted by 30-day check-in count descending. No weight or income data exposed.',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated win-streak rows.' })
  @ApiResponse({ status: 403, description: 'Caller does not hold coach or owner role.' })
  async getWinStreaks(@Request() req: AuthedRequest, @Query() query: CcPageQueryDto) {
    return this.svc.getWinStreaks(req.user.id, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  // -----------------------------------------------------------------------
  // GET /coach/command-center/inbox
  // -----------------------------------------------------------------------
  @Get('inbox')
  @ApiOperation({
    summary:
      'Paginated message inbox for this coach. Returns one thread per client, ' +
      'newest first, with unread counts.',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated thread list.' })
  @ApiResponse({ status: 403, description: 'Caller does not hold coach or owner role.' })
  async getInbox(@Request() req: AuthedRequest, @Query() query: CcPageQueryDto) {
    return this.svc.getInbox(req.user.id, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  // -----------------------------------------------------------------------
  // GET /coach/command-center/action-queue
  // -----------------------------------------------------------------------
  @Get('action-queue')
  @ApiOperation({
    summary:
      'Paginated action queue — clients needing this coach\'s attention. ' +
      'Reason codes: unread_message, at_risk, missed_checkin, no_first_win. ' +
      'Each client appears at most once (highest-priority reason wins).',
  })
  @ApiResponse({ status: 200, description: 'Cursor-paginated action queue.' })
  @ApiResponse({ status: 403, description: 'Caller does not hold coach or owner role.' })
  async getActionQueue(
    @Request() req: AuthedRequest,
    @Query() query: ActionQueueQueryDto,
  ) {
    return this.svc.getActionQueue(req.user.id, {
      reason_code: query.reason_code,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
