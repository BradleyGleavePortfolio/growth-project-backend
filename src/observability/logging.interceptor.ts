import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { AppLoggerService } from './app-logger.service';
import { MetricsService } from './metrics.service';

/**
 * LoggingInterceptor — emits a structured JSON log line per request.
 *
 * Emitted for EVERY request (auth-guarded and public alike) with:
 *   timestamp, level, request_id, user_id, method, path, status, latency_ms, message
 *
 * This interceptor runs AFTER auth (so user_id is available from req.user)
 * but the request_id was set earlier by RequestIdMiddleware so it is always
 * present even if auth fails.
 *
 * The interceptor also increments Prometheus counters via MetricsService.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: AppLoggerService,
    private readonly metrics: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request & { requestId?: string; user?: { id?: string; sub?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    // Set user_id on the logger thread-local once auth guard has resolved it.
    const userId = req.user?.id ?? req.user?.sub;
    if (userId) AppLoggerService.userId = userId;

    return next.handle().pipe(
      tap({
        next: () => {
          const latency = Date.now() - start;
          const status = res.statusCode;
          const path = req.route?.path ?? req.path;

          this.logger.logStructured(
            status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log',
            `${req.method} ${req.path} ${status}`,
            {
              method: req.method,
              path: req.path,
              status,
              latency_ms: latency,
              request_id: req.requestId,
              user_id: userId,
            },
            'HTTP',
          );

          this.metrics.recordRequest(req.method, path, status, latency);
        },
        error: (err: unknown) => {
          const latency = Date.now() - start;
          const status =
            typeof (err as { status?: number }).status === 'number'
              ? (err as { status: number }).status
              : 500;
          const path = req.route?.path ?? req.path;

          this.logger.logStructured(
            'error',
            `${req.method} ${req.path} ${status} — ${err instanceof Error ? err.message : String(err)}`,
            {
              method: req.method,
              path: req.path,
              status,
              latency_ms: latency,
              request_id: req.requestId,
              user_id: userId,
            },
            'HTTP',
          );

          this.metrics.recordRequest(req.method, path, status, latency);
        },
      }),
    );
  }
}
