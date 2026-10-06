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
import { safeDiagnostic } from '../observability/orm-diagnostics';
import { buildErrorEnvelope } from './not-found-envelope';
import { pickErrorDetails } from './error-details';

/**
 * W3-08 (agent 123): kill-switch codes that answer 503 while a feature is
 * switched off. These are expected answers (the mobile app probes broadcasts
 * on every coach Messages visit), not server faults, so they never go to
 * Sentry. Closed set: only these exact codes, only at 503, only from an
 * HttpException whose cause is not an ORM failure. Every other 5xx is still
 * reported. The 404 kill switches (coachless_disabled,
 * coach_code_tools_disabled) are 4xx and already skipped.
 */
export const FEATURE_OFF_503_CODES: ReadonlySet<string> = new Set([
  'broadcasts.disabled', // FEATURE_COACH_BROADCASTS (broadcasts.feature.ts)
  'messaging.feature_disabled', // FEATURE_MESSAGING_CORE_V2 (messaging-core.feature.ts)
  'community.disabled', // community kill switches (dto/disabled-response.dto.ts)
]);

/** True when a 503 body is one of the kill-switch answers above. */
export function isFeatureOffResponse(status: number, body: unknown): boolean {
  if (status !== HttpStatus.SERVICE_UNAVAILABLE || !body || typeof body !== 'object') return false;
  const { code, error } = body as { code?: unknown; error?: unknown };
  const key = typeof code === 'string' ? code : error;
  return typeof key === 'string' && FEATURE_OFF_503_CODES.has(key);
}

// Structured error shape: { statusCode, message, error, timestamp, path }.
// Mobile only reads `err.response?.data?.message` (verified in growth-project-mobile
// src/services/api.ts + screen error handlers), so the extra `timestamp`/`path`
// fields are safe additions. Nest's default shape (statusCode/message/error) is
// preserved for backwards compatibility.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const diagnostic = safeDiagnostic(exception);
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    // `safeDiagnostic` returns a NEW sanitized error only when it classifies an
    // ORM failure anywhere in the cause chain, so this is that classification.
    const ormBoundary = diagnostic !== exception;
    // Diagnostic sinks must never retain caller URLs: path segments can contain
    // invitation credentials just as query strings can. Keep the existing client
    // envelope contract separate from logger/telemetry metadata.
    const diagnosticPath = request.route?.path ?? '[unmatched]';

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    // Optional machine-readable error code that handlers may set on the
    // exception body (e.g. `invite_code_invalid_format`). Keep it strictly
    // additive so existing clients that only read `message` are unaffected.
    let code: string | undefined;
    // B-RECUR-BE — allowlisted, shape-checked facts of a coded 4xx (see
    // error-details.ts). Empty for every code not on the allowlist.
    let details: Record<string, unknown> = {};
    // W3-08: an expected "feature off" 503 (see FEATURE_OFF_503_CODES).
    let featureOff = false;

    // An HttpException whose cause is an ORM failure normally carries a body
    // derived from that failure, so its original response must not reach the
    // client once the ORM boundary is classified: fall through to the generic
    // envelope instead. Status, correlation, the sanitized log/Sentry capture
    // and every non-ORM HttpException body are unchanged.
    if (exception instanceof HttpException && !ormBoundary) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        error = exception.name.replace(/Exception$/, '');
      } else if (res && typeof res === 'object') {
        const body = res as { message?: string | string[]; error?: string; code?: string };
        message = body.message ?? exception.message;
        error = body.error ?? exception.name.replace(/Exception$/, '');
        if (typeof body.code === 'string') code = body.code;
        details = pickErrorDetails(status, code, res as Record<string, unknown>);
        featureOff = isFeatureOffResponse(status, res);
      }
    } else if (diagnostic instanceof Error) {
      // Log unexpected errors; do NOT leak internal details to clients.
      this.logger.error(
        `Unhandled error at ${request.method} ${diagnosticPath}: ${diagnostic.message}`,
        diagnostic.stack,
      );
    }

    // Forward server errors (5xx) and unknown exceptions to Sentry so we can
    // see them in production. Skip 4xx — they're caller mistakes (validation,
    // auth, not-found) and would just create noise. A kill-switch 503 is an
    // expected answer while a feature is off, not a fault (W3-08).
    if (status >= 500 && !featureOff) {
      const sentryReq = request as Request & { requestId?: string };
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.path', diagnosticPath);
        scope.setExtra('responseStatus', status);
        if (sentryReq.requestId) scope.setTag('request_id', sentryReq.requestId);
        Sentry.captureException(diagnostic);
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
    // Details never carry an envelope key (error-details.ts skips them).
    response.status(status).json({
      ...buildErrorEnvelope(request, {
        statusCode: status,
        code,
        message,
        error,
        requestId: reqWithId.requestId,
      }),
      ...details,
    });
  }
}
