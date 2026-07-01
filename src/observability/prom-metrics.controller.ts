import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { renderPromMetrics } from './prom-metrics';

/**
 * GET /metrics/prom — the prom-client registry (Node.js runtime defaults + HTTP
 * duration histogram) in Prometheus text format. Carries runtime internals, so
 * it is bearer-gated by {@link MetricsAuthGuard}; {@link Public} only bypasses
 * the global JWT guard (the guard supplies its own default-deny).
 */
@ApiExcludeController()
@Public()
@UseGuards(MetricsAuthGuard)
@Controller('metrics')
export class PromMetricsController {
  @Get('prom')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prom(): Promise<string> {
    return renderPromMetrics();
  }
}
