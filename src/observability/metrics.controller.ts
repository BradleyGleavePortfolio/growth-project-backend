import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * MetricsController — serves GET /metrics in Prometheus text format.
 *
 * This endpoint is intentionally PUBLIC (no auth gate) so Prometheus / Grafana
 * Agent can scrape it from inside the Fly private network without needing a
 * service account.  In production the endpoint is typically not exposed on the
 * public internet — access is controlled at the Fly.io network layer via
 * private IPv6 (`.internal` addresses).
 *
 * When METRICS_ENABLED=off the endpoint returns a comment-only document so
 * Prometheus can still scrape without error.
 */
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get(): string {
    return this.metrics.render();
  }
}
