// B-TRIALS-3 (B-656-7) — closed diagnostics for the trial workers. Logs, row
// last_error values and Sentry tags carry only a value from these lists; an
// arbitrary Error.name, Stripe code or transport code maps to a fixed
// fallback, so free text can never reach a log line through them.

const ERROR_CLASSES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'StripeConnectApiError',
  'TrialConflictTimeoutError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
  'PrismaClientRustPanicError',
]);

const PUSH_CODES = new Set([
  'no-token',
  'invalid-token',
  'aborted',
  'transport-error',
  'ticket-error',
]);

/** The error's class from a closed list, else 'unclassified'. */
export function trialErrorClass(err: unknown): string {
  const name = err instanceof Error ? err.name : null;
  return name && ERROR_CLASSES.has(name) ? name : 'unclassified';
}

/** A push transport code from a closed list, else 'unclassified'. */
export function trialPushCode(code: unknown): string {
  return typeof code === 'string' && PUSH_CODES.has(code) ? code : 'unclassified';
}

/** `http_<status>` for a real HTTP status, else 'http_unknown'. */
export function trialHttpCode(status: unknown): string {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? `http_${status}`
    : 'http_unknown';
}
