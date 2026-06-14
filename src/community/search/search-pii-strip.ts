/**
 * search-pii-strip.ts — bounded-allowlist PII stripper for search-index text.
 *
 * The search indexer (PREFLIGHT §8) must NEVER write user-authored bodies,
 * emails, phone numbers, or token-shaped strings into the `excerpt` column.
 * Mirrors the BOUNDED-ALLOWLIST philosophy of classifyTelemetryError() in
 * community-events.ts: rather than try to scrub an arbitrary free-text body
 * (a denylist is unbounded and always leaks), the indexer composes the excerpt
 * from explicitly-allowlisted, public metadata fields (title, tags, kind label)
 * and this function is the FINAL defence that redacts the few PII shapes that
 * could still slip through a title (e.g. a coach who types an email into a
 * lesson title).
 *
 * Order matters: redact the most specific shapes first. The redaction token is
 * a fixed sentinel so the tsvector basis stays deterministic.
 */

const REDACTED = '[redacted]';

// Email addresses (RFC-ish; conservative).
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// E.164-ish + common separators. Requires >= 7 digits to avoid eating prices.
const PHONE_RE =
  /(?:(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4})/g;
// JWT-shaped tokens (three base64url segments).
const JWT_RE = /\beyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}\b/g;
// UUID-shaped tokens.
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Long hex/base64 secret-shaped runs (>= 24 chars).
const SECRET_RE = /\b[a-zA-Z0-9+/_-]{24,}\b/g;

/**
 * Redact PII shapes from a single allowlisted text field, then collapse
 * whitespace. Returns a string safe to store in the search excerpt.
 */
export function stripPiiForSearch(input: string): string {
  if (!input) return '';
  let s = input;
  s = s.replace(EMAIL_RE, REDACTED);
  s = s.replace(JWT_RE, REDACTED);
  s = s.replace(UUID_RE, REDACTED);
  s = s.replace(PHONE_RE, (m) => {
    const digits = (m.match(/\d/g) ?? []).length;
    return digits >= 7 ? REDACTED : m;
  });
  s = s.replace(SECRET_RE, REDACTED);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Compose a search excerpt from explicitly-allowlisted public metadata fields
 * (NEVER a body / transcript / DM text). Each field is PII-stripped, joined,
 * and truncated to the first `maxLen` chars (the tsvector basis).
 */
export function composeSearchExcerpt(
  fields: Array<string | null | undefined>,
  maxLen = 500,
): string {
  const joined = fields
    .map((f) => (f == null ? '' : stripPiiForSearch(String(f))))
    .filter((f) => f.length > 0)
    .join(' \u2014 ');
  return joined.slice(0, maxLen);
}
