import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { AdminConsoleService } from './console/admin-console.service';
import { MetricsService } from './metrics.service';

/**
 * OwnerConsoleController — server-to-server surface for the tgp-platform-site
 * owner console. Protected by ServiceTokenGuard (shared secret in
 * ADMIN_SERVICE_TOKEN) rather than a Supabase JWT, since the owner console
 * runs server-side in Next.js RSC/route handlers without a user session.
 *
 * All routes are read-only. Mutation (promote, scrub, etc.) requires a real
 * owner JWT via AdminController.
 */
@ApiTags('owner-console')
@Controller('admin')
@UseGuards(ServiceTokenGuard)
export class OwnerConsoleController {
  constructor(
    private console: AdminConsoleService,
    private metrics: MetricsService,
  ) {}

  @Get('enterprise/rollup')
  async enterpriseRollup(@Query('since_days') sinceDaysRaw?: string) {
    const parsed = sinceDaysRaw ? parseInt(sinceDaysRaw, 10) : NaN;
    const sinceDays =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30;
    return this.metrics.getOverview({ sinceDays });
  }

  @Get('metrics/mrr-arr')
  async mrrArr() {
    // Delegate to metrics service — same data the owner JWT path exposes
    return this.metrics.getMrrArr();
  }

  @Get('metrics/churn')
  async churn(@Query('since_days') sinceDaysRaw?: string) {
    const parsed = sinceDaysRaw ? parseInt(sinceDaysRaw, 10) : NaN;
    const sinceDays =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30;
    return this.metrics.getChurn({ sinceDays });
  }

  @Get('payments')
  async payments(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.console.listPayments({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('payouts')
  async payouts(@Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.console.listPayouts({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
