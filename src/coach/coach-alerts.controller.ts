import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CoachAlertsService } from './coach-alerts.service';

// Coach-facing red-flag alert surface. Mounted under /coach so the
// existing CoachGuard (coach OR owner — owner bypasses) gates access;
// listForCoach uses req.user.id directly, so an owner viewing this
// surface only sees their own coach-owned alerts (which is fine — the
// /admin/coach-alerts endpoint is the cross-coach aggregator).
@ApiTags('coach')
@Controller('coach/alerts')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachAlertsController {
  constructor(private readonly alerts: CoachAlertsService) {}

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query('acknowledged') acknowledged?: string,
    @Query('limit') limitRaw?: string,
    @Query('before') beforeRaw?: string,
  ) {
    const ackParam =
      acknowledged === 'true'
        ? true
        : acknowledged === 'false'
          ? false
          : undefined;
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    const safeBefore =
      before instanceof Date && !Number.isNaN(before.getTime())
        ? before
        : undefined;
    return this.alerts.listForCoach({
      coachId: req.user.id,
      acknowledged: ackParam,
      limit: Number.isFinite(limit) ? limit : undefined,
      before: safeBefore,
    });
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.alerts.acknowledge(id, req.user.id);
  }
}
