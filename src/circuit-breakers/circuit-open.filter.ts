import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CircuitOpenError } from './circuit-breaker.factory';

// H6 — maps CircuitOpenError -> 503 Service Unavailable (D-H6-2).
//
// When a per-client breaker is open, the wrapped client call rejects with
// CircuitOpenError. This filter catches that specific error and returns a
// clean 503 with a Retry-After hint, rather than letting it fall through to
// HttpExceptionFilter as a generic 500. Registration is order-insensitive
// because @Catch(CircuitOpenError) is more specific than the catch-all
// HttpExceptionFilter (@Catch()), so Nest dispatches to this one first.
//
// NO FAKE SUCCESS: we surface the outage as 503 so callers (and the mobile
// client) can back off and retry, not a fabricated 200.
@Catch(CircuitOpenError)
export class CircuitOpenFilter implements ExceptionFilter {
  private readonly logger = new Logger(CircuitOpenFilter.name);

  catch(exception: CircuitOpenError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // resetTimeout is 30s for every client (D-H6-2), so Retry-After: 30 is
    // an honest hint at when the breaker next probes half-open.
    const retryAfterSeconds = 30;

    this.logger.warn(
      `Circuit open for ${exception.clientName} on ${request?.method ?? '?'} ${
        request?.url ?? '?'
      } -> 503`,
    );

    response
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .setHeader('Retry-After', String(retryAfterSeconds))
      .json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: `Upstream service temporarily unavailable (${exception.clientName}). Please retry shortly.`,
        code: 'circuit_open',
        client: exception.clientName,
        timestamp: new Date().toISOString(),
        path: request?.url,
      });
  }
}
