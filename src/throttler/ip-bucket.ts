import { isIPv4, isIPv6 } from 'net';

/**
 * Normalize a source IP into a stable rate-limit bucket key. Shared by the
 * storefront checkout limiter and the A7 wrong invite-code limit (AUTHA-07).
 *
 * IPv4: returned as-is (a single host is a single bucket).
 *
 * IPv6: masked to the /64 prefix (first four hextets) before keying.
 * Rationale (A276-F4-P1-A): every commodity cloud/VPS provider hands
 * a single VM a /64 (Hetzner, OVH, Vultr, Linode, AWS EC2 IPv6,
 * GCP). Keying on the full /128 means an attacker rotates through
 * 2^64 unique buckets from one VM and any per-address ceiling becomes
 * decoration. /64 is the smallest IPv6 unit a single tenant can
 * realistically be expected to control, matching how Cloudflare,
 * AWS WAF, and Stripe key their IPv6 rate-limit buckets.
 *
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped to the IPv4
 * address first, then treated as IPv4 (same bucket as the bare
 * IPv4 form — important so an attacker cannot bypass by toggling
 * the mapped prefix).
 *
 * Malformed / empty inputs fall back to the literal sentinel
 * `'unknown'` so the limiter still buckets them (rather than
 * crashing or letting them through).
 */
export function ipRateLimitBucket(ip: string): string {
  const raw = (ip ?? '').trim();
  if (!raw) return 'unknown';

  // Unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4`) so it shares a bucket
  // with the bare IPv4 address — toggling the prefix MUST NOT mint
  // a fresh bucket.
  const unwrapped = raw.replace(/^::ffff:/i, '');

  if (isIPv4(unwrapped)) {
    // IPv4: one host = one bucket. Defensive 64-char truncation in
    // case something upstream injected garbage; isIPv4 has already
    // validated so the truncation is a no-op on the happy path.
    return unwrapped.slice(0, 64);
  }

  // After unwrapping, if it's still IPv6, mask to /64.
  if (isIPv6(unwrapped)) {
    const prefix = ipv6Slash64Prefix(unwrapped);
    if (prefix) return prefix;
  }

  // Some upstreams attach a zone-id (`fe80::1%eth0`) — strip it and
  // retry once. We never key on the zone.
  const stripZone = unwrapped.split('%')[0];
  if (stripZone !== unwrapped && isIPv6(stripZone)) {
    const prefix = ipv6Slash64Prefix(stripZone);
    if (prefix) return prefix;
  }

  // Malformed input: bucket under a single 'unknown' key rather
  // than let it through.
  return 'unknown';
}

/**
 * Expand an IPv6 address (validated by `net.isIPv6`) to its first
 * four hextets, then emit a stable `<h1>:<h2>:<h3>:<h4>::/64`
 * bucket key. Returns `null` if the input cannot be expanded.
 *
 * Handles `::` compression (RFC 5952 §4.2) and the trailing
 * IPv4-in-IPv6 form (`2001:db8::192.0.2.1`).
 */
function ipv6Slash64Prefix(ip: string): string | null {
  let s = ip.toLowerCase();

  // Trailing IPv4 form: `2001:db8::192.0.2.1` → convert the dotted
  // tail to two hextets so we can split on `:`. Only relevant if
  // the IPv4 piece is inside the first 64 bits, which only happens
  // when the address has ≤2 leading hextets — extremely rare for a
  // /64 mask, but handle it for correctness.
  const dotIdx = s.indexOf('.');
  if (dotIdx !== -1) {
    const lastColon = s.lastIndexOf(':', dotIdx);
    if (lastColon === -1) return null;
    const head = s.slice(0, lastColon + 1);
    const v4 = s.slice(lastColon + 1);
    const octets = v4.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o) => Number(o));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((nums[0] << 8) | nums[1]).toString(16);
    const lo = ((nums[2] << 8) | nums[3]).toString(16);
    s = `${head}${hi}:${lo}`;
  }

  // Expand `::` to the right number of zero hextets.
  let parts: string[];
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const leftParts = left === '' ? [] : left.split(':');
    const rightParts = right === '' ? [] : right.split(':');
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    parts = s.split(':');
  }

  if (parts.length !== 8) return null;
  // First four hextets, with leading zeros stripped per RFC 5952 §4.1.
  const head = parts.slice(0, 4).map((h) => {
    // Validate each hextet is 1-4 hex digits.
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    return h.replace(/^0+(?=[0-9a-f])/, '');
  });
  if (head.some((h) => h === null)) return null;
  return `${(head as string[]).join(':')}::/64`;
}
