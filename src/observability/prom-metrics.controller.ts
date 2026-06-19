import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { renderPromMetrics } from './prom-metrics';

/**
 * PromMetricsController — serves GET /metrics/prom in Prometheus text format,
 * exposing the prom-client registry (Node.js runtime defaults + the HTTP
 * request-duration histogram).
 *
 * Unlike the existing public `/metrics` endpoint (hand-rolled application
 * counters scraped over the Fly private network), this endpoint carries
 * runtime internals and is therefore bearer-gated by {@link MetricsAuthGuard}.
 * It is marked {@link Public} only to bypass the global JWT guard — the
 * MetricsAuthGuard provides its own default-deny authentication.
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
