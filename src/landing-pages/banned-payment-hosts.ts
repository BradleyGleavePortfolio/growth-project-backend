/**
 * Canonical list of banned external payment hosts.
 *
 * Spec §3.2 — Checkout routing — ZERO EXCEPTIONS.
 * Every checkout on a landing page MUST route through TGP (GuestCheckout /
 * Stripe Connect). Any CTA URL whose host matches an entry below is rejected
 * at the service layer with 400 { error: 'external_payment_host_forbidden', host }.
 *
 * Keep this file as the SINGLE source of truth — do NOT copy-paste into
 * controller validators or tests; import from here instead.
 *
 * Hosts are matched after URL parsing; www-prefix variants are not needed
 * because we normalise with new URL(...).hostname which strips leading `www.`
 * and we do a suffix-match (e.g. "checkout.stripe.com" also matches "stripe.com"
 * when the normalised host IS "checkout.stripe.com").
 *
 * PR #3 note: if coaches can paste CRM webhook URLs in future,
 * add a separate allowlist check rather than relaxing this blocklist.
 */

export const BANNED_PAYMENT_HOSTS: readonly string[] = [
  // Stripe direct-checkout surfaces
  'stripe.com',
  'checkout.stripe.com',
  'buy.stripe.com',
  // PayPal
  'paypal.com',
  'paypal.me',
  // Mobile P2P / cash apps
  'venmo.com',
  'cash.app',
  'cashapp.com',
  // Creator-monetisation / tip platforms
  'ko-fi.com',
  'buymeacoffee.com',
  'patreon.com',
  // Digital-product marketplaces
  'gumroad.com',
  'lemonsqueezy.com',
  'whop.com',
] as const;

/**
 * Validate a user-supplied URL against the banned payment host list.
 *
 * Returns `{ ok: true }` when the URL is safe, or
 * `{ ok: false, host: string }` identifying the offending host.
 *
 * Null / undefined / empty string are considered safe (callers treat blank
 * URLs as "no CTA URL" and handle that separately).
 */
export function checkBannedHost(
  url: string | null | undefined,
): { ok: true } | { ok: false; host: string } {
  if (!url || url.trim() === '') return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    // Malformed URL — not a banned payment host; callers may separately
    // reject non-http(s) URLs via their own validation.
    return { ok: true };
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const banned of BANNED_PAYMENT_HOSTS) {
    // Exact match (e.g. hostname === 'stripe.com')
    // Subdomain match (e.g. hostname === 'checkout.stripe.com' → matches 'stripe.com'
    // AND the subdomain 'checkout.stripe.com' itself is listed explicitly).
    if (hostname === banned || hostname.endsWith(`.${banned}`)) {
      return { ok: false, host: hostname };
    }
  }

  return { ok: true };
}

/**
 * Scan an arbitrary plain object for URL-shaped strings and check each
 * against the banned-host list. Used to validate section payloads (FAQ
 * links, offer-stack links, etc.) in a single pass.
 *
 * Returns the first banned host found, or null if all URLs are safe.
 */
export function findBannedHostInPayload(
  payload: unknown,
  visited = new WeakSet<object>(),
): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') {
    // Extract all http(s) URLs from the string (handles inline URLs in text)
    const urlPattern = /https?:\/\/[^\s,"'<>)\]]+/g;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(payload)) !== null) {
      const result = checkBannedHost(match[0]);
      if (!result.ok) return result.host;
    }
    return null;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findBannedHostInPayload(item, visited);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload === 'object' && payload !== null) {
    if (visited.has(payload as object)) return null; // cycle guard
    visited.add(payload as object);
    for (const value of Object.values(payload as Record<string, unknown>)) {
      const found = findBannedHostInPayload(value, visited);
      if (found) return found;
    }
  }
  return null;
}
