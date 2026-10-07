import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/auth.guard';
import { RolesGuard } from '../../../auth/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../../auth/auth-request';
import { WorkoutBuilderAiStatus, WorkoutBuilderStatusService } from './workout-builder-status.service';

/**
 * AIB-4 — coach/owner only. The app keeps "Ask AI" visible in every state and
 * shows the paused / out-of-credits copy; only a 404 (an older backend) hides it.
 */
@ApiTags('ai-gateway')
@Controller('ai/gateway/workout-builder')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
export class WorkoutBuilderStatusController {
  constructor(private readonly status: WorkoutBuilderStatusService) {}

  @Get('status')
  @ApiOperation({ summary: 'AIB-4: AI workout builder state, capabilities and coach AI pool share.' })
  getStatus(@Request() req: AuthedRequest): Promise<WorkoutBuilderAiStatus> {
    return this.status.getStatus(req.user.id);
  }
}
