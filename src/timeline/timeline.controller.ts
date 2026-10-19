import {
  Controller,
  Get,
  Query,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/auth.guard';
import { TimelineResponse, TimelineLane } from './timeline.types';
import type { AuthedRequest } from '../auth/auth-request';

/**
 * TimelineController — Phase 7B: Transformation Timeline.
 *
 * GET /me/timeline
 *   Returns the requesting user's 3-lane chronological event feed (weigh-ins,
 *   wins, missed check-ins). No coach message ever appears (#TIMELINE-COACH op 1).
 *   Requires a valid JWT (enforced globally by JwtAuthGuard).
 *
 * Security invariant: `userId` is ALWAYS derived from req.user.id.
 * Query parameters may NEVER override or bypass the authenticated identity.
 * A client requesting another user's timeline receives their OWN data — no
 * path param or query param exists that could supply a different user ID.
 *
 * Query parameters:
 *   since_days  — Number of days back to include. Default 180. Max 730.
 *   lanes       — Comma-separated list of lanes: body,win,friction.
 *                 Default: all three. The retired `coach` lane is still
 *                 accepted so a build that sends it gets nothing, never a 400.
 *   cursor      — Opaque pagination cursor from a previous response.
 *   limit       — Events per page. Default 20. Max 50.
 */
@Controller('me/timeline')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class TimelineController {
  private static readonly ALL_LANES: TimelineLane[] = ['body', 'win', 'friction'];
  private static readonly VALID_LANES = new Set<string>(['body', 'win', 'friction', 'coach']);
  private static readonly MAX_SINCE_DAYS = 730;

  constructor(private readonly timelineService: TimelineService) {}

  @Get()
  async getTimeline(
    @Req() req: AuthedRequest,
    @Query('since_days', new DefaultValuePipe(180), ParseIntPipe)
    sinceDaysRaw: number,
    @Query('lanes') lanesParam: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe)
    limitRaw: number,
  ): Promise<TimelineResponse> {
    const userId = req.user.id;

    // Clamp since_days.
    const sinceDays = Math.min(Math.max(sinceDaysRaw, 1), TimelineController.MAX_SINCE_DAYS);

    // Parse and validate lanes.
    let lanes: TimelineLane[];
    if (!lanesParam || lanesParam.trim() === '' || lanesParam === 'all') {
      lanes = TimelineController.ALL_LANES;
    } else {
      const parts = lanesParam.split(',').map((s) => s.trim());
      const invalid = parts.filter((l) => !TimelineController.VALID_LANES.has(l));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Unknown lane(s): ${invalid.join(', ')}. Valid values: body, win, friction`,
        );
      }
      lanes = TimelineController.ALL_LANES.filter((l) => parts.includes(l));
    }

    return this.timelineService.getTimeline(userId, {
      sinceDays,
      lanes,
      cursor: cursor || undefined,
      limit: limitRaw,
    });
  }
}
