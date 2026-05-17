// src/coach/command-center/ltv-metrics.controller.ts
//
// GET /coach/command-center/ltv-metrics
//
// Returns the full LTV metrics suite for the authenticated coach.
// Guarded by JwtAuthGuard + CoachGuard — only coaches (or owners acting as
// coaches) can reach this endpoint.

import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import { LtvMetricsService } from './ltv-metrics.service';
import { LtvMetricsResponseDto } from './ltv-metrics.dto';

@ApiTags('coach')
@Controller('coach/command-center')
@UseGuards(JwtAuthGuard, CoachGuard)
export class LtvMetricsController {
  constructor(private readonly ltvMetrics: LtvMetricsService) {}

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
