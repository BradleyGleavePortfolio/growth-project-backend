import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { MetricsService } from './metrics.service';

/**
 * MetricsController — serves GET /metrics in Prometheus text format.
 *
 * The route is reachable on the public internet, so it is bearer-gated by
 * {@link MetricsAuthGuard} exactly like `/metrics/prom`; {@link Public} only
 * bypasses the global JWT guard (the guard supplies its own default-deny).
 *
 * When METRICS_ENABLED=off the endpoint returns a comment-only document so
 * Prometheus can still scrape without error.
 */
@ApiExcludeController()
@Public()
@UseGuards(MetricsAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get(): string {
    return this.metrics.render();
  }
}
