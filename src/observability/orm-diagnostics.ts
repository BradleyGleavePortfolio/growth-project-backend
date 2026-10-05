import { Prisma } from '@prisma/client';

export const ORM_ERROR_NAME =
  /^(?:PrismaClient(?:KnownRequest|UnknownRequest|Validation|Initialization|RustPanic)Error|DatabaseRequestError)$/;

/** ORM messages, stacks, metadata and causes can embed entire query arguments. */
export function safeDiagnostic(error: unknown): unknown {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (ORM_ERROR_NAME.test(current.name)) {
      const code =
        current instanceof Prisma.PrismaClientKnownRequestError && /^P\d{4}$/.test(current.code)
          ? ` (${current.code})`
          : '';
      const safe = new Error(`Database request failed${code}`);
      safe.name = 'DatabaseRequestError';
      return safe;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return error;
}

/**
 * B-634-10. The reviewed, finite set of error class names a log line may
 * carry. Membership is exact: an identifier-shaped but unknown name (for
 * example `SYNTHETIC_PRIVATE_CANARY_123`) is still arbitrary data and logs as
 * `OtherError`. Add a class here only after reviewing that its NAME is a
 * fixed constructor name, never data.
 */
export const LOG_ERROR_CLASSES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'HttpException',
  'BadRequestException',
  'UnauthorizedException',
  'ForbiddenException',
  'NotFoundException',
  'ConflictException',
  'GoneException',
  'PayloadTooLargeException',
  'UnprocessableEntityException',
  'InternalServerErrorException',
  'NotImplementedException',
  'BadGatewayException',
  'ServiceUnavailableException',
  'GatewayTimeoutException',
  'PushAbortedError',
] as const;

/**
 * The reviewed, finite catalog of non-ORM machine codes a log line may carry
 * (Node/undici transport codes, the push abort code and the scheduling
 * provider and Google OAuth codes this codebase throws). Any other `.code`,
 * or a code read from an HttpException response body, is dropped. Prisma
 * P-codes are not listed: they pass only through the validated ORM branch.
 */
export const LOG_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'PUSH_ABORTED',
  'CALENDAR_PROVIDER_NOT_IMPLEMENTED',
  'VIDEO_PROVIDER_NOT_IMPLEMENTED',
  'GOOGLE_OAUTH_DISABLED',
  'GOOGLE_OAUTH_EXCHANGE_FAILED',
  'GOOGLE_OAUTH_REFRESH_MISSING',
  'GOOGLE_OAUTH_REFRESH_FAILED',
] as const;

export type LogErrorClass =
  (typeof LOG_ERROR_CLASSES)[number] | 'DatabaseRequestError' | 'OtherError';
export type LogErrorCode = (typeof LOG_ERROR_CODES)[number];

const ERROR_CLASS_SET: ReadonlySet<string> = new Set(LOG_ERROR_CLASSES);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(LOG_ERROR_CODES);

/** Reads one property without letting a hostile getter or Proxy throw. */
function readProp(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Maps any value to a member of the closed class enum. */
export function logErrorClass(error: unknown): LogErrorClass {
  if (!(error instanceof Error)) return 'OtherError';
  const name = readProp(error, 'name');
  return typeof name === 'string' && ERROR_CLASS_SET.has(name)
    ? (name as LogErrorClass)
    : 'OtherError';
}

/**
 * The first catalogued `.code` on the error or its cause chain (undici wraps
 * transport codes as `TypeError: fetch failed` with a coded cause). Bounded
 * and cycle-safe; any code outside the catalog is ignored.
 */
export function logErrorCode(error: unknown): LogErrorCode | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const code = readProp(current, 'code');
    if (typeof code === 'string' && ERROR_CODE_SET.has(code)) return code as LogErrorCode;
    current = readProp(current, 'cause');
  }
  return null;
}

/** An HttpException's numeric status, only when it is a real HTTP status. */
function logHttpStatus(error: Error): number | null {
  const getStatus = readProp(error, 'getStatus');
  if (typeof getStatus !== 'function') return null;
  try {
    const status: unknown = getStatus.call(error);
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  } catch {
    return null;
  }
}

/**
 * The only text a log line may carry for an error, built from closed parts:
 * ORM errors (also when wrapped as a cause) collapse to `DatabaseRequestError:
 * Database request failed (P####)` with a validated Prisma code; any other
 * Error logs one member of LOG_ERROR_CLASSES (unknown names -> `OtherError`),
 * an optional catalogued machine code and, for HttpException, its numeric
 * status. A non-Error throw logs `OtherError`. Messages, stacks, metadata,
 * response bodies and unknown names or codes never pass.
 */
export function safeLogDiagnostic(error: unknown): string {
  let safe: unknown;
  try {
    safe = safeDiagnostic(error);
  } catch {
    return 'OtherError';
  }
  if (safe !== error && safe instanceof Error) return `${safe.name}: ${safe.message}`;
  if (!(safe instanceof Error)) return 'OtherError';
  const cls = logErrorClass(safe);
  const parts: string[] = [];
  const code = logErrorCode(safe);
  if (code) parts.push(code);
  const status = cls.endsWith('Exception') ? logHttpStatus(safe) : null;
  if (status !== null) parts.push(String(status));
  return parts.length ? `${cls} (${parts.join(' ')})` : cls;
}
