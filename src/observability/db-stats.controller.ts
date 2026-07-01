import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { DbStatsService } from './db-stats.service';

/**
 * GET /admin/db-stats — top-N slowest pg_stat_statements rows, each redacted to
 * a preview + sha256. Bearer-gated by {@link MetricsAuthGuard}; {@link Public}
 * only bypasses the global JWT guard (the guard supplies its own default-deny).
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
