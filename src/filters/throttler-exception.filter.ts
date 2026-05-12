import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

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

  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

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
