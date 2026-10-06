import { StripeConnectApiError } from '../../connect/stripe-connect-api.service';

/**
 * B-688-4 (Sol): the only error detail dunning v2 writes to logs, Sentry or
 * the notice outbox (`DunningNoticeDelivery.last_error`). Provider, transport
 * and database messages can carry an email address, a token or a message
 * body, so the message never leaves the catch: only a code from a closed
 * vocabulary does.
 *
 *   stripe_<http status>[_<stripe code>]   a Stripe API answer
 *   db_<P code>                            a Prisma known request error
 *   error | error_<name>                   an allow-listed error class
 *   error_unknown                          anything else
 */
const SAFE_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientValidationError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);

/** Stripe error codes are lowercase snake case ("card_declined"). */
const STRIPE_CODE = /^[a-z][a-z_]{0,63}$/;

export function dunningErrorCode(err: unknown): string {
  if (err instanceof StripeConnectApiError) {
    const status = Number.isInteger(err.httpStatus) ? err.httpStatus : 0;
    const code = err.stripeCode && STRIPE_CODE.test(err.stripeCode) ? `_${err.stripeCode}` : '';
    return `stripe_${status}${code}`;
  }
  const prismaCode = (err as { code?: unknown } | null)?.code;
  if (typeof prismaCode === 'string' && /^P\d{4}$/.test(prismaCode)) return `db_${prismaCode}`;
  const name = err instanceof Error ? err.name : '';
  if (name === 'Error') return 'error';
  return SAFE_NAMES.has(name) ? `error_${name.toLowerCase()}` : 'error_unknown';
}
