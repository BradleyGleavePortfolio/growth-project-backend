/**
 * Credential redaction for CRM adapter error paths.
 *
 * Axios error messages can include the full request config — including
 * Authorization headers and URL query strings — which would leak the
 * coach's access_token / api_key into Sentry, logs, and (worst) error
 * responses bubbling to the client. Every adapter's catch block runs
 * raw error messages through this before logging or re-throwing.
 *
 * Audit #6 P1-1 — tightened to also catch:
 *   • HTTP Basic auth: `Basic <base64>` (Mailchimp uses this).
 *   • Header-style key:value pairs that the original regex missed
 *     (e.g. `'Api-Token': 'tok'` and `X-Auth-Token=abc`). The earlier
 *     pattern only matched bare `apikey=value` etc.; an axios error
 *     that serialises headers as `{"Api-Token":"<tok>"}` was leaking
 *     the token through because the key wasn't in the seed list.
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
  'api_token',
  // Audit #6 P1-1 — header names that adapters actually send.
  'x-api-key',
  'x-auth-token',
  'x-tgp-signature',
  'client_secret',
  'refresh_token',
];

/** Header names we want to redact case-insensitively as a single regex pass. */
const HEADER_NAME_PATTERN =
  '(?:Authorization|Api-Token|X-Api-Key|X-Auth-Token|X-TGP-Signature|Bearer)';

/**
 * Replace any value of a sensitive config key with '[REDACTED]'.
 * Operates on both a freshly-thrown axios Error and on a JSON-string
 * representation of a config blob.  Cheap heuristic — we don't try to
 * parse and reconstruct the original error, just remove obvious leaks.
 */
export function redactSecrets(input: string): string {
  let out = input;
  // Audit #6 P1-1 — redact "Bearer <token>" and "Basic <base64>"
  // FIRST so the more aggressive header-value sweep below can't
  // truncate the match at the space between scheme and credential.
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]');
  out = out.replace(/Basic\s+[A-Za-z0-9+/]+=*/g, 'Basic [REDACTED]');
  for (const k of SENSITIVE_KEYS) {
    // Match "<key>": "<value>" or <key>=<value>. Allow optional quoting
    // on the key so both JSON ("key": "v") and JS-object ('key': 'v')
    // serialisations collapse to the same pattern.
    const reJsonD = new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, 'gi');
    out = out.replace(reJsonD, '$1"[REDACTED]"');
    const reJsonS = new RegExp(`('${k}'\\s*:\\s*)'[^']*'`, 'gi');
    out = out.replace(reJsonS, "$1'[REDACTED]'");
    const reEq = new RegExp(`(${k}\\s*[:=]\\s*)[^\\s,&}]+`, 'gi');
    out = out.replace(reEq, '$1[REDACTED]');
  }
  // Audit #6 P1-1 — generic header-style redaction so any new header
  // we introduce in the future is covered without a code change.
  // Matches: `Api-Token: tok`, "X-Api-Key"="abc", 'X-Auth-Token':'def'.
  const headerRe = new RegExp(
    `(['"]?${HEADER_NAME_PATTERN}['"]?\\s*[:=]\\s*['"]?)[^'"\\s,&}]+`,
    'gi',
  );
  out = out.replace(headerRe, '$1[REDACTED]');
  // Mailchimp-style anystring:<api_key> basic-auth (pre-encode form).
  out = out.replace(/anystring:[A-Za-z0-9-]+/g, 'anystring:[REDACTED]');
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
