import {
  MiddlewareConsumer,
  Module,
  NestModule,
  APP_INTERCEPTOR,
} from '@nestjs/common';
import { RequestIdMiddleware } from './request-id.middleware';
import { LoggingInterceptor } from './logging.interceptor';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { HealthDeepController } from './health-deep.controller';
import { ProfilingController } from './profiling.controller';
import { AppLoggerService } from './app-logger.service';

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
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
  controllers: [MetricsController, HealthDeepController, ProfilingController],
  exports: [AppLoggerService, MetricsService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Apply request-id middleware to EVERY route — wildcards must use the
    // Nest forRoutes pattern, not Express glob syntax.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
