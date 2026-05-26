/**
 * Hostname validation for coach-supplied custom domains — R49.
 *
 * Coaches paste a string in their dashboard; we accept ONLY a clean
 * RFC 1123 hostname.  Rejected:
 *
 *   - Anything with a scheme        (`https://example.com`)
 *   - Anything with a path          (`example.com/foo`)
 *   - Anything with a port          (`example.com:8443`)
 *   - Anything with userinfo        (`user@example.com`)
 *   - Anything with query/fragment
 *   - Bare IP addresses             (Fly cert mgmt requires a hostname)
 *   - localhost / .local / TLDs we reserve for the platform itself
 *
 * Accepted: lowercase a-z, 0-9, hyphen labels separated by dots, each
 * label 1-63 chars, total length ≤ 253.  Punycode (xn--) is accepted
 * because Fly's Let's Encrypt managed flow handles IDN via xn-- prefix.
 *
 * Returns `{ ok: true, domain }` with the normalized lowercase form on
 * success, or `{ ok: false, reason }` with a short tag identifying
 * which rule rejected it (used by the controller to render a
 * meaningful 400 to the coach).
 */

export type DomainValidationResult =
  | { ok: true; domain: string }
  | { ok: false; reason: string };

// Reserved suffixes the platform owns.  Coaches cannot point one of
// these at TGP — they could collide with our own infrastructure (the
// SSL cert worker would refuse to provision a cert for a hostname we
// already own).
const RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'tgp.app',           // legacy platform domain — R45 forbids new use
  'thegrowthproject.app', // legacy platform domain
  'trygrowthproject.com', // platform primary
  'joingrowthproject.com', // platform CNAME apex
  'fly.dev',            // Fly's default app domain — coach must not claim it
];

// RFC 1123 label: 1-63 chars; LDH (letter / digit / hyphen); cannot
// start or end with hyphen.  The total domain is up to 253 octets
// including the dots.
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// Simple IPv4 detector — bare IPs are NOT a hostname.
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export function validateCustomDomain(raw: unknown): DomainValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not_string' };
  }
  // Trim + lowercase.  We do NOT silently strip a scheme: pasting
  // `https://example.com` is operator error and rejecting it teaches
  // the coach the expected shape.
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (trimmed.length > 253) {
    return { ok: false, reason: 'too_long' };
  }
  if (trimmed.includes('://')) {
    return { ok: false, reason: 'has_scheme' };
  }
  if (trimmed.includes('/')) {
    return { ok: false, reason: 'has_path' };
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, reason: 'has_query_or_fragment' };
  }
  if (trimmed.includes('@')) {
    return { ok: false, reason: 'has_userinfo' };
  }
  if (trimmed.includes(':')) {
    // Could be a port or an IPv6 literal — both rejected.
    return { ok: false, reason: 'has_port_or_ipv6' };
  }
  if (IPV4_RE.test(trimmed)) {
    return { ok: false, reason: 'is_ipv4' };
  }
  // Must have at least one dot — single-label hostnames like
  // `localhost` are not routable on the public internet.
  const labels = trimmed.split('.');
  if (labels.length < 2) {
    return { ok: false, reason: 'no_tld' };
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      return { ok: false, reason: 'invalid_label' };
    }
  }
  // Block reserved suffixes (exact match OR suffix match `.suffix`).
  for (const suffix of RESERVED_SUFFIXES) {
    if (trimmed === suffix || trimmed.endsWith('.' + suffix)) {
      return { ok: false, reason: 'reserved_suffix' };
    }
  }
  return { ok: true, domain: trimmed };
}
