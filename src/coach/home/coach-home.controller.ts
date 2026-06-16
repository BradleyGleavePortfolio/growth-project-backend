// src/coach/home/coach-home.controller.ts
//
// ED.2 (Roman three-arc router) — coach-facing daily-rings counts surface.
//
//   GET /coach/home/daily-rings
//     → { checkIns: { reviewed, submitted },
//         brief:    { opened },
//         review:   { reviewed, totalConversations } }
//
// Scoping / no-leak guarantees:
//   * Class-level @Roles('coach') (coach OR owner) + CoachGuard. JwtAuthGuard
//     and RolesGuard are global APP_GUARDs, so @Roles('coach') is the role
//     gate and CoachGuard narrows identically to the other /coach surfaces.
//     Carrying @Roles at the class level keeps this controller OUT of the
//     roles-enforced.spec.ts LEGACY_GUARD_ALLOWLIST (R80 / L10 lesson — a new
//     coach handler missing @Roles trips the pin).
//   * The handler always resolves counts for `req.user.id` — there is NO path
//     parameter or query that lets a caller name another coach, so a coach can
//     never read a peer's counts (no cross-coach leak).
//   * Flag-gated behind FEATURE_ROMAN_THREE_ARC_COUNTS inside the service:
//     while OFF the route returns a zeroed shape and does no Prisma reads.

import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CoachHomeService, DailyRingsResponse } from './coach-home.service';

@ApiTags('coach')
@Controller('coach/home')
@UseGuards(CoachGuard)
@Roles('coach')
export class CoachHomeController {
  constructor(private readonly coachHome: CoachHomeService) {}

  // GET /coach/home/daily-rings — the calling coach's three completion arcs
  // for today (check-ins reviewed/submitted, brief opened, threads reviewed/
  // total). Always scoped to req.user.id.
  // Explicit per-route throttle (R79 pin). Read-only aggregation polled on
  // Coach Home focus; the 30s service cache already absorbs bursts, but an
  // explicit 60/min bucket caps abuse and is pinned in the controller spec so
  // it cannot regress silently.
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get('daily-rings')
  @ApiOperation({ summary: "Today's three-arc completion counts for this coach" })
  async dailyRings(@Request() req: AuthedRequest): Promise<DailyRingsResponse> {
    return this.coachHome.getDailyRings(req.user.id);
  }
}
