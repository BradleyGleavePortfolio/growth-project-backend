/**
 * Content-free error tags for Roman's logs and Sentry events, shared by the
 * live-turn service and the context disclosure route: the error class (closed
 * allowlist) plus, when present, a Prisma code or an HTTP status. Never
 * `err.message`: a context read, a provider error or a ledger write can carry
 * query arguments, client facts or transcript text, and `safeDiagnostic` only
 * redacts ORM errors.
 */
import { safeDiagnostic } from '../observability/orm-diagnostics';

/** Error class names that may appear in Roman logs and Sentry; anything else is `OtherError`. */
export const ROMAN_LOGGABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  'DatabaseRequestError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
  'PrismaClientRustPanicError',
  'APIError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'BadRequestError',
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'ConflictError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
  'OverloadedError',
  'HttpException',
  'ServiceUnavailableException',
  'NotFoundException',
  'ForbiddenException',
  'RomanContextBudgetError',
]);

export function romanErrorTag(err: unknown): string {
  const d = safeDiagnostic(err);
  if (!(d instanceof Error)) return 'NonError';
  // Closed allowlist (pre-push checklist (a)): an error's `name` is set by
  // code, but a thrown object can carry any string there.
  const name = ROMAN_LOGGABLE_ERROR_NAMES.has(d.name) ? d.name : 'OtherError';
  const prismaCode =
    name === 'DatabaseRequestError' ? /\((P\d{4})\)/.exec(d.message)?.[1] : undefined;
  const status = (err as { status?: unknown } | null)?.status;
  return [
    name,
    ...(prismaCode ? [`code=${prismaCode}`] : []),
    ...(typeof status === 'number' && Number.isInteger(status) ? [`status=${status}`] : []),
  ].join(' ');
}

/** A new Error carrying only the operation name and the content-free tag. */
export function romanSanitizedError(op: string, err: unknown): Error {
  const e = new Error(`${op}: ${romanErrorTag(err)}`);
  e.name = 'RomanSanitizedError';
  return e;
}
