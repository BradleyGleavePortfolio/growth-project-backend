import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { FirstWinService } from './first-win.service';
import { CompleteFirstWinDto } from './first-win.dto';

/**
 * Day 1 Win Sequence — Phase 7A
 *
 * Two endpoints that power the first-open retention screen shown to every
 * new client. The mobile app checks GET status on cold start; if not
 * completed it shows the Day1WinScreen. POST complete is called once the
 * client finishes any of the four quick-win actions. The response includes
 * an AI-generated 2-sentence coaching message explaining what the first
 * data point means for the client's progress.
 *
 * Both endpoints are behind JwtAuthGuard (student-scoped in practice, but
 * the guard does not restrict by role — any authenticated user can call them).
 */
@ApiTags('users')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@Controller('me/first-win')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class FirstWinController {
  constructor(private readonly firstWinService: FirstWinService) {}

  /**
   * POST /me/first-win/complete
   *
   * Sets `firstWinCompletedAt = now()` if currently null. Idempotent:
   * calling this more than once returns the original timestamp. Also
   * returns an AI-generated 2-sentence coaching message.
   *
   * Body: { winType: 'logged_first_weight' | 'set_first_goal' | 'first_checkin' | 'first_meal' }
   */
  @ApiOperation({
    summary: 'Mark the Day 1 Win as completed',
    description:
      'Sets first_win_completed_at on first call. Subsequent calls are no-ops and return the original timestamp. ' +
      'winType is informational — it does not change behaviour. ' +
      'Returns a 2-sentence AI coaching message contextualised to the win type.',
  })
  @ApiResponse({
    status: 200,
    description: 'Win recorded (or already recorded). Returns completedAt and aiMessage.',
  })
  @ApiResponse({ status: 400, description: 'Invalid winType.' })
  @Post('complete')
  @HttpCode(200)
  async complete(
    @Request() req: AuthedRequest,
    @Body() body: CompleteFirstWinDto,
  ): Promise<{ completedAt: string; aiMessage: string }> {
    const { completedAt, aiMessage } = await this.firstWinService.complete(
      req.user.id,
      body.winType,
    );
    return { completedAt: completedAt.toISOString(), aiMessage };
  }

  /**
   * GET /me/first-win/status
   *
   * Returns whether the Day 1 Win has been completed and when.
   * The mobile app calls this on every student cold start to decide
   * whether to show the Day1WinScreen.
   */
  @ApiOperation({
    summary: 'Get Day 1 Win completion status',
    description:
      'Returns { completed: boolean, completedAt: ISO string | null }. ' +
      'The mobile app uses this to gate the Day1WinScreen on cold start.',
  })
  @ApiResponse({
    status: 200,
    description: 'Completion status.',
  })
  @Get('status')
  async getStatus(
    @Request() req: AuthedRequest,
  ): Promise<{ completed: boolean; completedAt: string | null }> {
    return this.firstWinService.getStatus(req.user.id);
  }
}
