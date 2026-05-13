import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { MetricsService } from '../observability/metrics.service';

/**
 * ThrottlerExceptionFilter — formats 429 Too Many Requests responses.
 *
 * Responsibilities:
 * - Always sets a `Retry-After` header (integer seconds). The value is the
 *   largest TTL window across all named throttlers — a conservative upper
 *   bound that tells the client the maximum it would need to wait. We do NOT
 *   expose which specific named throttler fired (that would leak internal
 *   limit details that could help an attacker craft requests that maximize
 *   throughput right up to each bucket's edge).
 * - Returns a generic JSON body. No echo of the user's input. No exposure of
 *   bucket names, actual limits, or current counter values.
 * - The body shape is intentionally identical for every throttler so a
 *   probing attacker cannot distinguish "login rate limited" from "default
 *   rate limited".
 * - Emits a structured log line on every rejection so operators can spot
 *   credential-stuffing patterns, runaway clients, and misconfigured limits.
 *   The log contains internal context (userId, ip, path, method, retryAfter)
 *   that is deliberately NOT echoed in the client response.
 * - Increments a `throttler_rejected_total` Prometheus counter (when the
 *   observability MetricsService is wired in). The counter is labelled by
 *   `method` and `path` for blast-radius analysis; user/IP are intentionally
 *   omitted to keep label cardinality bounded.
 *
 * 429 body shape:
 * {
 *   "statusCode": 429,
 *   "error": "Too Many Requests",
 *   "message": "Too many attempts. Please wait before trying again.",
 *   "retryAfter": <seconds: integer>
 * }
 *
 * The `Retry-After` header value matches `retryAfter` in the body so that
 * both standards-compliant HTTP clients and human-readable responses agree.
 */
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  // Conservative Retry-After: 1 hour (matches the longest TTL window we use —
  // auth-login-per-hour and auth-password-reset). Using the max window means
  // any client that backs off for this long is guaranteed to be clear of every
  // named throttler. Expressed in seconds as required by RFC 7231 §7.1.3.
  private static readonly RETRY_AFTER_SECONDS = 3600;

  private readonly logger = new Logger(ThrottlerExceptionFilter.name);

  // MetricsService is optional so unit tests and standalone uses still work.
  // main.ts resolves it from the Nest DI container and passes it in.
  constructor(private readonly metrics?: MetricsService) {}

  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { user?: { id?: string; sub?: string }; ip?: string }>();

    const method = request.method ?? 'UNKNOWN';
    const path = request.url ?? 'unknown';
    const userId = request.user?.id ?? request.user?.sub ?? null;
    const ip = request.ip ?? request.socket?.remoteAddress ?? null;

    // Structured log — JSON-friendly object so AppLoggerService/json-format
    // flattens it cleanly. Includes the static retry-after window which is
    // the operator-visible signal of the broadest TTL bucket; we do NOT log
    // the specific named throttler that fired (same reason it isn't echoed
    // in the response body).
    this.logger.warn({
      message: 'throttler.rejected',
      userId,
      ip,
      path,
      method,
      limit: 'enforced',
      ttl: ThrottlerExceptionFilter.RETRY_AFTER_SECONDS,
    });

    // Metric hook — only when MetricsService was injected. Labels are
    // intentionally low-cardinality (method + path); user/ip are in the log.
    if (this.metrics) {
      this.metrics.increment('throttler_rejected_total', { method, path });
    }

    response
      .status(HttpStatus.TOO_MANY_REQUESTS)
      .set('Retry-After', String(ThrottlerExceptionFilter.RETRY_AFTER_SECONDS))
      .json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many attempts. Please wait before trying again.',
        retryAfter: ThrottlerExceptionFilter.RETRY_AFTER_SECONDS,
      });
  }
}
