import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { HolisticInsightsService } from './holistic-insights.service';

@ApiTags('insights')
@Controller('insights')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class HolisticInsightsController {
  constructor(private readonly insights: HolisticInsightsService) {}

  // GET /insights/holistic?window_days=90&force=0
  // window_days clamps to [30, 180]; force=1 bypasses the 24h cache.
  @Get('holistic')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  generate(
    @Req() req: AuthedRequest,
    @Query('window_days', new DefaultValuePipe(90), ParseIntPipe) windowDays: number,
    @Query('force') force?: string,
  ) {
    const clamped = Math.min(180, Math.max(30, windowDays));
    return this.insights.generateForUser(req.user.id, {
      windowDays: clamped,
      force: force === '1' || force === 'true',
    });
  }
}
