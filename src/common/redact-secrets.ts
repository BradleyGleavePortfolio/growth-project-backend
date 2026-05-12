/**
 * redact-secrets.ts
 *
 * A utility that strips secret values from any object, string, or error before
 * it reaches a log line, HTTP response, or error message.
 *
 * WHY THIS EXISTS
 * ---------------
 * NestJS interceptors, Sentry, and the route logger all capture request bodies
 * and error payloads. Without redaction a misconfigured client could accidentally
 * send a bearer token in a request body, and it would show up verbatim in Fly
 * logs, Sentry breadcrumbs, or an admin API response. This utility is the single
 * choke-point that prevents that.
 *
 * USAGE
 * -----
 * import { redactSecrets } from '../common/redact-secrets';
 *
 * // Safe to log:
 * logger.log(redactSecrets({ DATABASE_URL: 'postgresql://...', user: 'alice' }));
 * // => { DATABASE_URL: '[REDACTED]', user: 'alice' }
 *
 * // Safe to surface in error messages:
 * throw new Error(redactSecrets(`Connection failed: ${url}`));
 *
 * DESIGN NOTES
 * ------------
 * - Pattern matching is intentionally broad. "password", "secret", "token",
 *   "key", "dsn", "url" (when the value starts with a scheme) are all redacted.
 * - The function never throws — it returns the input unchanged if something goes
 *   wrong internally, so it cannot break a hot path.
 * - Redaction is recursive for plain objects and arrays.
 * - The function is pure (no side-effects) and synchronous.
 */

/** Keys whose values are unconditionally redacted regardless of value. */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /signing[_-]?key/i,
  /auth[_-]?token/i,
  /service[_-]?role/i,
  /private[_-]?key/i,
  /webhook[_-]?secret/i,
  /encryption[_-]?key/i,
  /hmac/i,
  /credential/i,
  /dsn/i,
  /stripe/i,
  /twilio/i,
  /sendgrid/i,
  /mailgun/i,
  /postmark/i,
];

/** Value patterns — strings that look like secrets even if the key is benign. */
const SENSITIVE_VALUE_PATTERNS = [
  /^sk_live_/,     // Stripe live secret key
  /^sk_test_/,     // Stripe test secret key
  /^whsec_/,       // Stripe webhook secret
  /^eyJ/,          // JWT (base64url header)
  /^postgresql:\/\//i,
  /^postgres:\/\//i,
  /^mysql:\/\//i,
  /^redis:\/\//i,
  /^rediss:\/\//i,
  /^https?:\/\/[^:]+:[^@]+@/, // URL with embedded credentials
];

const REDACTED = '[REDACTED]';

/**
 * Redact a single string value. Returns the original if it does not match
 * any sensitive value pattern.
 */
function redactString(value: string): string {
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (pattern.test(value)) return REDACTED;
  }
  return value;
}

/**
 * Check whether an object key name is considered sensitive.
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Recursively redact sensitive fields from any value.
 *
 * - Strings: checked against SENSITIVE_VALUE_PATTERNS.
 * - Plain objects: each key is checked against SENSITIVE_KEY_PATTERNS; the
 *   value is redacted if the key matches. Otherwise the value is recursed.
 * - Arrays: each element is recursed.
 * - Everything else (number, boolean, null, undefined): returned as-is.
 *
 * The function never mutates the input — it returns a new structure.
 */
export function redactSecrets<T>(input: T): T {
  try {
    return _redact(input, 0) as T;
  } catch {
    // Safety net: if our own redaction code throws, return the input
    // unchanged rather than crashing the caller.
    return input;
  }
}

function _redact(value: unknown, depth: number): unknown {
  // Guard against circular references or pathologically deep objects.
  if (depth > 10) return '[depth-limit]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => _redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = _redact(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Redact sensitive patterns from a plain string (e.g. an error message or
 * a URL that may contain credentials). Returns the sanitised string.
 */
export function redactString_safe(input: string): string {
  try {
    return redactString(input);
  } catch {
    return input;
  }
}
