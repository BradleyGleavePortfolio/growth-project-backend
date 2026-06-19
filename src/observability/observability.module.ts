import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdMiddleware } from './request-id.middleware';
import { LoggingInterceptor } from './logging.interceptor';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { HealthDeepController } from './health-deep.controller';
import { ProfilingController } from './profiling.controller';
import { AppLoggerService } from './app-logger.service';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { PromMetricsController } from './prom-metrics.controller';
import { DbStatsController } from './db-stats.controller';
import { DbStatsService } from './db-stats.service';
import { registerDefaultMetrics } from './prom-metrics';

/**
 * ObservabilityModule — structured logging, request tracing, Prometheus
 * metrics, deep health check, and CPU profiling.
 *
 * ORDERING RULE: this module MUST be the FIRST import in AppModule so that:
 *   1. RequestIdMiddleware runs before JwtAuthGuard and AuditModule interceptors.
 *   2. LoggingInterceptor is registered as APP_INTERCEPTOR first, meaning it
 *      wraps the entire handler including auth and audit.
 *
 * The middleware applies to all routes ('*') so every request — including
 * public ones like /health and /metrics — receives a request_id.
 */
@Module({
  providers: [
    AppLoggerService,
    MetricsService,
    MetricsAuthGuard,
    DbStatsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
  controllers: [
    MetricsController,
    HealthDeepController,
    ProfilingController,
    // H3: prom-client runtime metrics + pg_stat_statements db-stats, both
    // bearer-gated by MetricsAuthGuard (default-deny).
    PromMetricsController,
    DbStatsController,
  ],
  exports: [AppLoggerService, MetricsService, DbStatsService],
})
export class ObservabilityModule implements NestModule, OnModuleInit {
  // H3: register the prom-client default collectors (process CPU/memory,
  // event-loop lag, GC) once the module boots. Idempotent — safe under the
  // repeated AppModule bootstraps that some test suites perform.
  onModuleInit(): void {
    registerDefaultMetrics();
  }

  configure(consumer: MiddlewareConsumer): void {
    // Apply request-id middleware to EVERY route — wildcards must use the
    // Nest forRoutes pattern, not Express glob syntax.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
