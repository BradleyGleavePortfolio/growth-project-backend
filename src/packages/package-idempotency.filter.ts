import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { buildErrorEnvelope } from '../filters/not-found-envelope';
import { safeDiagnostic } from '../observability/orm-diagnostics';

// B-675-1 — the 422 IDEMPOTENCY_KEY_REUSED answer to POST /v1/coach/packages
// names the package that key already made (`package_id`), so the app adopts
// it and saves the coach's current details onto it, instead of asking for a
// retry that can only get the same 422 again. The global HttpExceptionFilter
// sends only the fixed envelope keys, so on the coach package routes this
// filter builds the same envelope (the shared buildErrorEnvelope) and adds
// that one field: only for this code, only `package_id`, only when it is a
// UUID. PackagesService names a package only when it is live in the caller's
// own catalog (anything else is 410). Every other 422 goes to
// HttpExceptionFilter unchanged.
export const IDEMPOTENCY_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The package a reused key made, from a 422 body; null for anything else. */
export function reusedKeyPackageId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const body = response as { code?: unknown; package_id?: unknown };
  if (body.code !== IDEMPOTENCY_KEY_REUSED_CODE) return null;
  return typeof body.package_id === 'string' && UUID_RE.test(body.package_id)
    ? body.package_id
    : null;
}

@Catch(UnprocessableEntityException)
export class PackageIdempotencyFilter implements ExceptionFilter {
  private readonly envelope = new HttpExceptionFilter();

  catch(exception: UnprocessableEntityException, host: ArgumentsHost): void {
    const res = exception.getResponse();
    // An exception caused by an ORM failure gets the generic envelope from
    // HttpExceptionFilter, exactly as everywhere else.
    const packageId = safeDiagnostic(exception) === exception ? reusedKeyPackageId(res) : null;
    if (!packageId) {
      this.envelope.catch(exception, host);
      return;
    }
    const body = res as { message?: string | string[]; error?: string };
    const status = exception.getStatus();
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    ctx
      .getResponse<Response>()
      .status(status)
      .json({
        ...buildErrorEnvelope(request, {
          statusCode: status,
          code: IDEMPOTENCY_KEY_REUSED_CODE,
          message: body.message ?? exception.message,
          error: body.error ?? exception.name.replace(/Exception$/, ''),
          requestId: request.requestId,
        }),
        package_id: packageId,
      });
  }
}
