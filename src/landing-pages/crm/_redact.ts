/**
 * Credential redaction for CRM adapter error paths.
 *
 * Axios error messages can include the full request config — including
 * Authorization headers and URL query strings — which would leak the
 * coach's access_token / api_key into Sentry, logs, and (worst) error
 * responses bubbling to the client. Every adapter's catch block runs
 * raw error messages through this before logging or re-throwing.
 */

/** Substrings we never want to surface in any log line. */
const SENSITIVE_KEYS = [
  'access_token',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'bearer',
  'secret',
  'password',
  'api-token',
];

/**
 * Replace any value of a sensitive config key with '[REDACTED]'.
 * Operates on both a freshly-thrown axios Error and on a JSON-string
 * representation of a config blob.  Cheap heuristic — we don't try to
 * parse and reconstruct the original error, just remove obvious leaks.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const k of SENSITIVE_KEYS) {
    // Match "<key>": "<value>" or <key>=<value> or Bearer <token>
    const reJson = new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, 'gi');
    out = out.replace(reJson, '$1"[REDACTED]"');
    const reEq = new RegExp(`(${k}\\s*[:=]\\s*)[^\\s,&]+`, 'gi');
    out = out.replace(reEq, '$1[REDACTED]');
  }
  // Bearer <token>
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');
  // Mailchimp-style anystring:<api_key> basic-auth
  out = out.replace(/anystring:[A-Za-z0-9\-]+/g, 'anystring:[REDACTED]');
  return out;
}

/**
 * Turn an unknown thrown value into a redacted, single-line string.
 * Use in adapter catch blocks before re-throwing or logging.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw).slice(0, 500);
}
