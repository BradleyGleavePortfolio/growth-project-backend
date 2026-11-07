import { Controller, Get, Header, HttpStatus, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { MoneyCheckStatus, MoneyCheckStatusService } from './money-check-status.service';

/**
 * MONEY-ALARM-BE: GET /api/money-check/status, the daily money check's own
 * status for its own alarm (scripts/ci/money-check-alarm.sh). Public like the
 * health probes (the alarm runs with no secret), but it is not a health probe:
 * Fly never reads it and it never answers for traffic readiness.
 * 200 { status: 'on_time' | 'late' | 'off', lastDay: 'YYYY-MM-DD' | null };
 * 503 {} when the rows cannot be read (no reason, no raw error).
 */
@ApiTags('money-check')
@Public()
@Controller('money-check')
export class MoneyCheckStatusController {
  private readonly logger = new Logger(MoneyCheckStatusController.name);

  constructor(private readonly moneyCheck: MoneyCheckStatusService) {}

  @ApiOperation({
    summary: 'Daily money check status',
    description:
      'Unauthenticated. on_time, late (no finished run with a sent owner notice in 26 hours) or off, plus the last finished UTC day. Not a readiness probe.',
  })
  @ApiResponse({
    status: 200,
    description: '`{ status: "on_time" | "late" | "off", lastDay: "YYYY-MM-DD" | null }`',
  })
  @ApiResponse({ status: 503, description: 'The status could not be read: `{}`' })
  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(
    @Res({ passthrough: true }) res: Response,
  ): Promise<MoneyCheckStatus | Record<string, never>> {
    try {
      const { status, lastDay } = await this.moneyCheck.status();
      return { status, lastDay };
    } catch {
      // A driver error may hold query text: log a stable event only.
      this.logger.error({
        event: 'money_check_status_unavailable',
        operation: 'money-check.status',
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {};
    }
  }
}
