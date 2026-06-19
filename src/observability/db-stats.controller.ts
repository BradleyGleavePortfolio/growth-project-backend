import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { DbStatsService } from './db-stats.service';

/**
 * DbStatsController — serves GET /admin/db-stats.
 *
 * Returns the top-N slowest Postgres statements (by total_exec_time) from the
 * pg_stat_statements extension, with each statement redacted to a 200-char
 * preview plus a sha256 hash of the full text.
 *
 * Protected by {@link MetricsAuthGuard} (same bearer-token gate as
 * /metrics/prom). Marked {@link Public} only to bypass the global JWT guard —
 * the MetricsAuthGuard supplies its own default-deny authentication.
 */
@ApiExcludeController()
@Public()
@UseGuards(MetricsAuthGuard)
@Controller('admin')
export class DbStatsController {
  constructor(private readonly dbStats: DbStatsService) {}

  @Get('db-stats')
  async dbStatsTop() {
    const result = await this.dbStats.topStatements();
    return {
      generatedAt: new Date().toISOString(),
      ...result,
    };
  }
}
