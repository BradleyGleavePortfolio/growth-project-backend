/**
 * community-event-link.ts — validation for EXTERNAL event video links.
 *
 * CONTEXT (Step 0 integrations audit): TGP has NO native live-room / live-video
 * provider. Zoom/Meet adapters are stubs; Daily.co/LiveKit are unintegrated. So
 * a Community event NEVER hosts a call — it carries an EXTERNAL link the coach
 * already created on a third-party platform (the live URL while live, and the
 * replay URL once recorded). This module is the single gate those links pass.
 *
 * This is NOT an SSRF guard: the server never FETCHES these URLs (they are
 * handed to the mobile client, which opens them in the system browser). The
 * threat model is therefore (a) link-injection into the mobile webview/browser
 * (javascript:, data:, file: schemes) and (b) coaches pasting a non-meeting
 * link. We enforce a strict allowlist of well-known meeting/streaming hosts
 * plus the universal hard rules (https-only, no credentials, no non-standard
 * port). A synchronous, DNS-free check — link validation must not depend on
 * network reachability at write time.
 *
 * The allowlist is env-extensible (COMMUNITY_EVENT_LINK_HOSTS, comma-separated)
 * so an operator can add a coach's platform without a deploy, but the baseline
 * covers the platforms a fitness coach actually uses today.
 */

/** Built-in allowlisted host suffixes (matched case-insensitively). */
const DEFAULT_ALLOWED_HOST_SUFFIXES: readonly string[] = [
  'zoom.us',
  'zoom.com',
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'loom.com',
  'whereby.com',
  'riverside.fm',
  'streamyard.com',
  'restream.io',
  'twitch.tv',
  'daily.co',
];

/** Typed reasons a link is rejected — mapped to stable error codes upstream. */
export type EventLinkRejection =
  | 'not_a_url'
  | 'not_https'
  | 'has_credentials'
  | 'non_standard_port'
  | 'host_not_allowed';

export interface EventLinkResult {
  ok: boolean;
  /** Normalized URL string (origin + path + query), present only when ok. */
  normalized?: string;
  reason?: EventLinkRejection;
}

/** Resolve the active allowlist: built-ins plus any env-provided suffixes. */
function allowedHostSuffixes(): readonly string[] {
  const extra = (process.env.COMMUNITY_EVENT_LINK_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...DEFAULT_ALLOWED_HOST_SUFFIXES, ...extra];
}

/** True when `host` equals or is a subdomain of any allowlisted suffix. */
function hostIsAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return allowedHostSuffixes().some(
    (suffix) => h === suffix || h.endsWith(`.${suffix}`),
  );
}

/**
 * Validate an external event link. Returns a typed result; the caller throws a
 * `community.event.invalid_link` BadRequest carrying `reason` on failure.
 */
export function validateEventLink(raw: string): EventLinkResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  // https only — blocks http://, and every dangerous scheme (javascript:,
  // data:, file:, blob:, etc.) in one rule.
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }
  // No embedded credentials (https://user:pass@host) — a classic parser
  // hijack and a phishing vector in a tappable link.
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'has_credentials' };
  }
  // Only the implicit 443. A non-standard port on a "meeting link" is a smell
  // and a smuggling vector; meeting platforms never need one.
  if (url.port.length > 0 && url.port !== '443') {
    return { ok: false, reason: 'non_standard_port' };
  }
  if (!hostIsAllowed(url.hostname)) {
    return { ok: false, reason: 'host_not_allowed' };
  }

  // Normalize: drop any fragment, keep origin + path + query. The hash is
  // never needed for a meeting link and could carry an injection payload for
  // a naive client.
  url.hash = '';
  return { ok: true, normalized: url.toString() };
}
