import {
  Controller,
  Get,
  Query,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
} from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { TimelineResponse, TimelineLane } from './timeline.types';
import type { AuthedRequest } from '../auth/auth-request';

/**
 * TimelineController — Phase 7B: Transformation Timeline.
 *
 * GET /me/timeline
 *   Returns the requesting user's 4-lane chronological event feed.
 *   Requires a valid JWT (enforced globally by JwtAuthGuard).
 *
 * Security invariant: `userId` is ALWAYS derived from req.user.id.
 * Query parameters may NEVER override or bypass the authenticated identity.
 * A client requesting another user's timeline receives their OWN data — no
 * path param or query param exists that could supply a different user ID.
 *
 * Query parameters:
 *   since_days  — Number of days back to include. Default 180. Max 730.
 *   lanes       — Comma-separated list of lanes: body,win,coach,friction.
 *                 Default: all four lanes.
 *   cursor      — Opaque pagination cursor from a previous response.
 *   limit       — Events per page. Default 20. Max 50.
 */
@Controller('me/timeline')
export class TimelineController {
  private static readonly ALL_LANES: TimelineLane[] = ['body', 'win', 'coach', 'friction'];
  private static readonly VALID_LANES = new Set<TimelineLane>(['body', 'win', 'coach', 'friction']);
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
      const parts = lanesParam.split(',').map((s) => s.trim()) as TimelineLane[];
      const invalid = parts.filter((l) => !TimelineController.VALID_LANES.has(l));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Unknown lane(s): ${invalid.join(', ')}. Valid values: body, win, coach, friction`,
        );
      }
      lanes = parts;
    }

    return this.timelineService.getTimeline(userId, {
      sinceDays,
      lanes,
      cursor: cursor || undefined,
      limit: limitRaw,
    });
  }
}
