/**
 * Log lines carry ids and codes, never personal data (C-611-17, agent 117,
 * B-PRIV-FU-117; AGENT_RULES G12: no PII in errors or logs).
 *
 * Code in this service never interpolates an email address, a person's name
 * or free text (message bodies, notes, request payloads) into a log line; it
 * logs the row id, user id or template key instead. test/privacy/
 * no-pii-in-logs.spec.ts enforces that over every log call under src/.
 *
 * Text this service does not write itself (an email provider's error body,
 * an exception message) can still echo an address back, for example
 * "Illegal email address 'pat@example.com'". `redactEmailAddresses` is for
 * that text: every run of characters joined by an '@' becomes "[email]", so
 * no address survives, and the result is bounded to LOG_TEXT_MAX characters.
 */

/** Longest provider or exception text that goes into a log line or error column. */
export const LOG_TEXT_MAX = 500;

/** Replacement for anything that looks like an address. */
export const REDACTED_EMAIL = '[email]';

// Any run of characters around an '@' that is not whitespace, a quote,
// a bracket or a list separator: covers "a@b.c", "<a@b.c>", "a+tag@b",
// "%61@b" and a lone "@". Deliberately broad: a false positive costs a few
// characters of diagnostics, a false negative leaks an address.
const ADDRESS_LIKE = /[^\s@<>()[\]{}"'`,;]*@[^\s@<>()[\]{}"'`,;]*/g;

/**
 * Returns `text` with every address-like run replaced by "[email]", cut to
 * `max` characters. Never throws; a non-string becomes "unknown".
 */
export function redactEmailAddresses(text: unknown, max: number = LOG_TEXT_MAX): string {
  if (typeof text !== 'string') return 'unknown';
  return text.replace(ADDRESS_LIKE, REDACTED_EMAIL).slice(0, max);
}
