/**
 * Log redaction — strips sensitive values before any line is written to
 * stdout/stderr.
 *
 * WHY: structured JSON logs ship to log-aggregation backends (Better Stack,
 * Datadog, etc.) where they are stored, indexed, and potentially accessible
 * to third parties.  Passwords, bearer tokens, full bloodwork / body-fat
 * values, and other PII must never appear in log output regardless of log
 * level.
 *
 * HOW: a recursive `redactObject` walk replaces matching leaf values with
 * the sentinel string "[REDACTED]".  Key matching is case-insensitive and
 * tests against the REDACT_KEYS set.  The walk stops at non-plain-object
 * leaves (strings, numbers, booleans, null, arrays of primitives are walked
 * one level; circular references are handled via a WeakSet depth guard).
 *
 * ALLOWLIST: keys deliberately excluded from redaction are listed in
 * ALLOWED_KEYS.  If a key is in both sets the allowlist wins (to prevent
 * a future REDACT_KEYS addition from silently breaking structured log
 * fields that are safe).
 */

/** Keys whose values are always replaced with "[REDACTED]". */
export const REDACT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'authorization',
  'x-api-key',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'private_key',
  'privatekey',
  'ssn',
  'social_security',
  // Bloodwork / body-composition — must never appear in logs
  'bloodwork',
  'blood_glucose',
  'hba1c',
  'cholesterol',
  'triglycerides',
  'body_fat',
  'bodyfat',
  'fat_percentage',
  'raw_bloodwork',
  // Stripe / billing
  'stripe_secret_key',
  'stripe_webhook_secret',
  'card_number',
  'cvv',
  'cvc',
  'card_cvc',
  'card_cvv',
]);

/** Keys that are explicitly safe even if they happen to match a redact pattern. */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'request_id',
  'user_id',
  'method',
  'path',
  'status',
  'latency_ms',
  'timestamp',
  'level',
  'message',
  'msg',
]);

/**
 * Recursively redact sensitive keys from a plain-object tree.
 *
 * @param value  The value to sanitise.  Primitives are returned as-is unless
 *               they are the direct value of a redacted key (handled by the
 *               parent call).
 * @param seen   WeakSet used to detect circular references.
 */
export function redactObject(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keyLower = k.toLowerCase();
    if (!ALLOWED_KEYS.has(keyLower) && REDACT_KEYS.has(keyLower)) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = redactObject(v, seen);
    }
  }
  return result;
}

/**
 * Redact a flat JSON log string by scanning for known-sensitive key patterns.
 * This is a belt-and-suspenders check applied AFTER `redactObject` in case a
 * string was serialised directly without passing through the object walk.
 */
export function redactLogLine(line: string): string {
  // Replace `"password":"<anything>"` (and similar) in serialised JSON.
  // The replace is best-effort; the primary guard is `redactObject`.
  return line.replace(
    /"(?:password|passwd|token|authorization|secret|api_key|access_token|refresh_token|id_token|client_secret|private_key|blood[^"]*|body_fat[^"]*|fat_percentage[^"]*|card_number|cvv|cvc)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const colonIdx = match.indexOf(':');
      return match.slice(0, colonIdx + 1) + '"[REDACTED]"';
    },
  );
}
