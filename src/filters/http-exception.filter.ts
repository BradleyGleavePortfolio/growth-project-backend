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
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        error = exception.name.replace(/Exception$/, '');
      } else if (res && typeof res === 'object') {
        const body = res as { message?: string | string[]; error?: string };
        message = body.message ?? exception.message;
        error = body.error ?? exception.name.replace(/Exception$/, '');
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
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.path', request.url);
        scope.setExtra('responseStatus', status);
        Sentry.captureException(exception);
      });
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
