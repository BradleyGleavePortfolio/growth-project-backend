import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/auth.guard';
import { RolesGuard } from '../../../auth/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../../auth/auth-request';
import {
  WorkoutBuilderAiStatus,
  WorkoutBuilderStatusService,
} from './workout-builder-status.service';

/**
 * AIB-4 — GET /ai/gateway/workout-builder/status. Coach/owner only. The mobile
 * builder keeps "Ask AI" visible for every state and shows the paused / out of
 * credits copy from `state`; only a 404 (a backend without this route) hides it.
 */
@ApiTags('ai-gateway')
@Controller('ai/gateway/workout-builder')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
export class WorkoutBuilderStatusController {
  constructor(private readonly status: WorkoutBuilderStatusService) {}

  @Get('status')
  @ApiOperation({
    summary:
      'AIB-4: AI workout builder state (on | paused | no_credits | not_configured), ' +
      'per-capability availability and the coach AI pool remaining share.',
  })
  @ApiResponse({ status: 200, description: 'Current state, read per call.' })
  @ApiResponse({ status: 403, description: 'Not a coach or owner.' })
  getStatus(@Request() req: AuthedRequest): Promise<WorkoutBuilderAiStatus> {
    return this.status.getStatus(req.user.id);
  }
}
