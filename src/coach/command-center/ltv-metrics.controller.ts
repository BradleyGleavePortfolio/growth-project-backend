// src/coach/command-center/ltv-metrics.controller.ts
//
// GET /coach/command-center/ltv-metrics
//
// Returns the full LTV metrics suite for the authenticated coach.
// Guarded by JwtAuthGuard + CoachGuard + NoActiveSubCoachGuard — only
// coaches (or owners acting as coaches) can reach this endpoint, and an
// ACTIVE sub-coach is fenced off.
//
// P0 (CC+SC re-audit): the financial LTV surface (MRR / RPCM / revenue /
// projected ARR) is owner/head-coach money data. SC-1 removed the
// NoActiveSubCoachGuard from the OPERATIONAL CommandCenterController
// precisely because it belongs on THIS financial controller. Without it an
// active sub-coach (a coach with an open TeamSubCoachAssignment) could read
// the head coach's revenue. NoActiveSubCoachGuard throws ForbiddenException
// for any caller who is an active sub-coach; owners and non-sub head
// coaches pass through unaffected.

import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { NoActiveSubCoachGuard } from '../../common/guards/no-active-sub-coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { LtvMetricsService } from './ltv-metrics.service';
import { LtvMetricsResponseDto } from './ltv-metrics.dto';

@ApiTags('coach')
@Controller('coach/command-center')
@UseGuards(JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard)
export class LtvMetricsController {
  constructor(private readonly ltvMetrics: LtvMetricsService) {}

  // Coach reads their own LTV metrics suite (MRR / RPCM / churn / NRR /
  // projected ARR). LtvMetricsService.getMetrics scopes every Prisma
  // query by `coach_user_id = req.user.id` (verified at
  // ltv-metrics.service.ts:81 — `where: { coach_user_id: coachUserId }`),
  // so a coach cannot read another coach's revenue. Students must never
  // reach this surface (revenue PII). CoachGuard already restricts to
  // coach|owner at class level; the explicit @Roles closes the Phase-10
  // contract-test gap. OWNER is listed explicitly per C1 pattern for
  // on-call/audit clarity even though RolesGuard's owner-bypass would
  // admit it implicitly.
  @Roles('coach', 'owner')
  @Get('ltv-metrics')
  @ApiOperation({
    summary: 'LTV metrics suite for the Coach Command Center.',
    description:
      'Returns MRR, RPCM, average LTV, churn rate, NRR, projected annual revenue, ' +
      'MRR trend, zero-churn streak, all-time peak RPCM, and the next MRR milestone nudge. ' +
      'Monetary values are returned both as raw cents (integer) and as formatted currency ' +
      'strings. Always scoped to the calling coach — a coach cannot read another coach\'s data.',
  })
  @ApiResponse({
    status: 200,
    description: 'LTV metrics computed successfully.',
    type: LtvMetricsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated.',
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not hold the coach or owner role.',
  })
  async getLtvMetrics(
    @Request() req: AuthedRequest,
  ): Promise<LtvMetricsResponseDto> {
    return this.ltvMetrics.getMetrics(req.user.id);
  }
}
