import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { PrepGuideService, PrepGuideResult } from './prep-guide.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('prep-guide')
@Controller('prep-guide')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class PrepGuideController {
  constructor(private prepGuideService: PrepGuideService) {}

  /**
   * GET /prep-guide?week=YYYY-MM-DD
   *
   * Returns visible recipes referenced by the user's unarchived meal plans,
   * or the latest visible library recipes, identified by `source`.
   * Pure computation — no DB writes.
   *
   * `week` is a compatibility echo only, not a filter (`week_filter_applied: false`).
   * If omitted, its echo defaults to the current week's Monday (ISO).
   */
  @Get()
  async getWeeklyGuide(
    @Request() req: AuthedRequest,
    @Query('week') week?: string,
  ): Promise<PrepGuideResult> {
    const weekStart = week || getMondayOfCurrentWeek();
    return this.prepGuideService.getWeeklyPrepGuide(
      { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id },
      weekStart,
    );
  }
}

// Returns the ISO date string for the Monday of the current week.
function getMondayOfCurrentWeek(): string {
  const today = new Date();
  const day = today.getDay(); // 0 = Sun, 1 = Mon...
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today.setDate(diff));
  return monday.toISOString().split('T')[0];
}
