import { Prisma } from '@prisma/client';
import { StripeConnectApiError } from '../stripe-connect-api.service';

// S-FEE round 11 (B-681-1 / B-682-2, agent 116) — money-path diagnostics name
// a failure only by this closed vocabulary. An error's message, name and code
// are free text that a database driver, a provider or a caller can fill with
// anything (request input, a notice body, an email address), so none of them
// ever reaches a log line, a persisted last_error or a money exception
// message. Every unknown shape maps to the fixed label `unknown`.

export type DbErrorKind = 'db_request' | 'db_unavailable' | 'db_validation' | 'unknown';

/** The Prisma error class of `err`, or `unknown`. */
export function dbErrorKind(err: unknown): DbErrorKind {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return 'db_request';
  }
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    return 'db_unavailable';
  }
  if (err instanceof Prisma.PrismaClientValidationError) return 'db_validation';
  return 'unknown';
}

// Stripe error types and codes the money path reports by name. Anything else
// Stripe (or a proxy in front of it) sends is reported as `other`.
const STRIPE_TYPES = new Set([
  'api_error',
  'api_connection_error',
  'authentication_error',
  'card_error',
  'idempotency_error',
  'invalid_request_error',
  'permission_error',
  'rate_limit_error',
]);
const STRIPE_CODES = new Set([
  'account_closed',
  'account_country_invalid_address',
  'account_invalid',
  'balance_insufficient',
  'idempotency_key_in_use',
  'insufficient_capabilities_for_transfer',
  'insufficient_funds',
  'lock_timeout',
  'parameter_invalid_integer',
  'parameter_missing',
  'rate_limit',
  'request_timeout',
  'resource_missing',
  'transfers_not_allowed',
]);

function allowListed(value: string | null | undefined, allowed: Set<string>): string {
  if (value === null || value === undefined || value === '') return 'none';
  return allowed.has(value) ? value : 'other';
}

/**
 * `kind=<kind>`, plus `http=<status> type=<type> code=<code>` for a Stripe
 * error, every part from a closed set. Safe for logs and persisted fields.
 */
export function moneyErrorDiagnostic(err: unknown): string {
  if (err instanceof StripeConnectApiError) {
    const status =
      Number.isInteger(err.httpStatus) && err.httpStatus >= 100 && err.httpStatus <= 599
        ? String(err.httpStatus)
        : 'other';
    return (
      `kind=stripe http=${status} type=${allowListed(err.stripeType, STRIPE_TYPES)} ` +
      `code=${allowListed(err.stripeCode, STRIPE_CODES)}`
    );
  }
  const db = dbErrorKind(err);
  if (db !== 'unknown') return `kind=${db}`;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'kind=timeout';
  }
  return 'kind=unknown';
}
