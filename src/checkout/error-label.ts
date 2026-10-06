import { HttpException } from '@nestjs/common';
import { StripeConnectApiError } from '../connect/stripe-connect-api.service';

// B-654-9 / C-654-10 (agent 116) — the only form in which a caught error
// reaches a log line of the native checkout. Closed allow-lists: a value
// outside them is never logged; it becomes a fixed word. A message, or a name
// or code set from data (an address, a token, a message body), never reaches
// logs, Sentry or analytics.
const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

/** Stripe error types (docs.stripe.com/api/errors) plus the client's timeout type. */
const STRIPE_TYPES = words(`api_connection_error api_error card_error idempotency_error
  invalid_request_error rate_limit_error`);

/** Stripe error codes the checkout meets (docs.stripe.com/error-codes) plus the client's own. */
const STRIPE_CODES = words(`authentication_required card_declined configuration_invalid
  configuration_missing expired_card idempotency_key_in_use lock_timeout parameter_invalid_empty
  parameter_missing parameter_unknown payment_intent_unexpected_state processing_error rate_limit
  request_timeout resource_already_exists resource_missing setup_intent_unexpected_state`);

/** Node and undici network failure codes. */
const NETWORK_CODES = words(`ECONNABORTED ECONNREFUSED ECONNRESET EAI_AGAIN ENOTFOUND EPIPE
  ETIMEDOUT UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_SOCKET`);

/** Built-in and client-library error class names. */
const ERROR_NAMES = words(`AbortError Error RangeError ReferenceError SyntaxError TimeoutError
  TypeError PrismaClientInitializationError PrismaClientKnownRequestError
  PrismaClientRustPanicError PrismaClientUnknownRequestError PrismaClientValidationError`);

function statusLabel(status: unknown): string {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : 'other';
}

/**
 * A log-safe label for a caught error: `stripe:<type>:<status>:<code>`,
 * `http:<status>`, a Prisma code (`P` and four digits), a network code, or
 * an error class name, each from the closed lists above; else `error`.
 */
export function errorLabel(err: unknown): string {
  if (err instanceof StripeConnectApiError) {
    const type = err.stripeType && STRIPE_TYPES.has(err.stripeType) ? err.stripeType : 'other';
    const code = err.stripeCode && STRIPE_CODES.has(err.stripeCode) ? err.stripeCode : 'other';
    return `stripe:${type}:${statusLabel(err.httpStatus)}:${code}`;
  }
  if (err instanceof HttpException) return `http:${statusLabel(err.getStatus())}`;
  if (!err || typeof err !== 'object') return 'unknown';
  const code: unknown = Reflect.get(err, 'code');
  if (typeof code === 'string' && (/^P[0-9]{4}$/.test(code) || NETWORK_CODES.has(code))) {
    return code;
  }
  const name: unknown = Reflect.get(err, 'name');
  return typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'error';
}
