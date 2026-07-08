import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { buildErrorEnvelope } from './not-found-envelope';

// Structured error shape: { statusCode, message, error, timestamp, path }.
// Mobile only reads `err.response?.data?.message` (verified in growth-project-mobile
// src/services/api.ts + screen error handlers), so the extra `timestamp`/`path`
// fields are safe additions. Nest's default shape (statusCode/message/error) is
// preserved for backwards compatibility.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    // Optional machine-readable error code that handlers may set on the
    // exception body (e.g. `invite_code_invalid_format`). Keep it strictly
    // additive so existing clients that only read `message` are unaffected.
    let code: string | undefined;

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        error = exception.name.replace(/Exception$/, '');
      } else if (res && typeof res === 'object') {
        const body = res as { message?: string | string[]; error?: string; code?: string };
        message = body.message ?? exception.message;
        error = body.error ?? exception.name.replace(/Exception$/, '');
        if (typeof body.code === 'string') code = body.code;
      }
    } else if (exception instanceof Error) {
      // Log unexpected errors; do NOT leak internal details to clients.
      this.logger.error(
        `Unhandled error at ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    }

    // Forward server errors (5xx) and unknown exceptions to Sentry so we can
    // see them in production. Skip 4xx — they're caller mistakes (validation,
    // auth, not-found) and would just create noise.
    if (status >= 500) {
      const sentryReq = request as Request & { requestId?: string };
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.path', request.url);
        scope.setExtra('responseStatus', status);
        if (sentryReq.requestId) scope.setTag('request_id', sentryReq.requestId);
        Sentry.captureException(exception);
      });
    }

    // Include the request_id so support engineers can correlate this error
    // with the structured log lines and Sentry events for the same request.
    // Cast to any because req.requestId is injected by RequestIdMiddleware
    // which extends the Express Request type at runtime.
    const reqWithId = request as Request & { requestId?: string };

    // Envelope construction is shared with the R-DARK-1 feature-flag 404
    // middleware (see src/filters/not-found-envelope.ts) so a dark-route 404
    // is key-for-key identical to this filter's unmounted-route 404.
    response.status(status).json(
      buildErrorEnvelope(request, {
        statusCode: status,
        code,
        message,
        error,
        requestId: reqWithId.requestId,
      }),
    );
  }
}
