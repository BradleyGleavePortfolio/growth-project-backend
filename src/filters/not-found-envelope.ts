import type { Request } from 'express';

/**
 * Single source of truth for the JSON error envelope emitted by
 * HttpExceptionFilter — extracted (R-DARK-1 round-2) so the feature-flag
 * not-found middleware can emit a 404 body that is key-for-key identical to
 * the filter's normalization of a genuinely unmounted route. Divergent key
 * sets (the middleware used to omit timestamp/path/request_id) let a caller
 * distinguish "flag off" from "route does not exist" by response shape,
 * which is exactly the disclosure R-DARK-1 forbids.
 */
export interface ErrorEnvelopeFields {
  statusCode: number;
  /** Optional machine-readable code (e.g. `invite_code_invalid_format`). */
  code?: string;
  message: string | string[];
  error: string;
  /** Correlation id from RequestIdMiddleware; omitted when absent. */
  requestId?: string;
}

export function buildErrorEnvelope(
  request: Request,
  fields: ErrorEnvelopeFields,
): Record<string, unknown> {
  return {
    statusCode: fields.statusCode,
    ...(fields.code ? { code: fields.code } : {}),
    message: fields.message,
    error: fields.error,
    timestamp: new Date().toISOString(),
    path: request.url,
    ...(fields.requestId ? { request_id: fields.requestId } : {}),
  };
}

/**
 * The exact envelope HttpExceptionFilter produces for a route Nest never
 * mounted: the router throws NotFoundException("Cannot <METHOD> <url>") and
 * the filter normalizes it through buildErrorEnvelope above.
 */
export function buildNotFoundEnvelope(
  request: Request,
  requestId?: string,
): Record<string, unknown> {
  return buildErrorEnvelope(request, {
    statusCode: 404,
    message: `Cannot ${request.method} ${request.url}`,
    error: 'Not Found',
    requestId,
  });
}
