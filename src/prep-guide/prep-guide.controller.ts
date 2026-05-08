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
 PrepGuideController {
  constructor(private prepGuideService: PrepGuideService) {}

  /**
   * GET /prep-guide?week=YYYY-MM-DD
   *
   * Returns a weekly meal-prep summary computed from the user's meal plans
   * and associated recipes. Pure computation — no DB writes.
   *
   * If `week` is omitted, defaults to the current week's Monday (ISO).
   */
  @Get()
  async getWeeklyGuide(
    @Request() req: AuthedRequest,
    @Query('week') week?: string,
  ): Promise<PrepGuideResult> {
    const weekStart = week || getMondayOfCurrentWeek();
    return this.prepGuideService.getWeeklyPrepGuide(req.user.id, weekStart);
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
