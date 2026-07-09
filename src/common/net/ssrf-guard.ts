/**
 * SSRF guard for outbound HTTP destinations controlled (in whole or part)
 * by an authenticated coach (CRM webhook URLs, ActiveCampaign account
 * subdomain, etc.).
 *
 * `assertPublicHttpsUrl` enforces:
 *   - https-only (no http://)
 *   - no userinfo (`https://user:pass@...`) — common URL parser hijack
 *   - non-443 ports are rejected — defeats the "smuggle a private port"
 *     class of bypasses
 *   - resolves the hostname via DNS (all addresses) and rejects any
 *     private/loopback/link-local/IMDS range on either IPv4 or IPv6.
 *
 * The returned `URL` should be used by callers along with `lookupForUrl`
 * to pin axios to the resolved IP — otherwise a DNS rebinding attacker
 * could swap the resolution between the guard and the actual request.
 */
import * as dns from 'dns';
import { promisify } from 'util';

// NOTE: use a namespace import (`import * as dns`) rather than a default
// import. With `esModuleInterop` off, `import dns from 'dns'` emits
// `dns_1.default.lookup`, and `.default` is undefined on the CJS `dns`
// module — this throws at module load, and the failure is triggered when
// require-in-the-middle (Sentry instrumentation) wraps the module. The
// namespace form emits `dns_1.lookup`, reading the property off the real
// module object under any wrapping.
const dnsLookup = promisify(dns.lookup);

// IPv4 ranges that must never be reached from a server-side HTTP request
// originating from the coach surface. The list mirrors the standard
// RFC1918 / loopback / link-local / CGNAT set used by every reasonable
// SSRF guard.
const PRIVATE_V4: RegExp[] = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((r) => r.test(ip));
}

export function isPrivateV6(ip: string): boolean {
  const lo = ip.toLowerCase();
  if (lo === '::1' || lo === '::') return true;
  if (lo.startsWith('fe80:')) return true; // link-local
  // ULA (fc00::/7) — match either fc.. or fd.. prefix.
  if (/^f[cd][0-9a-f]{2}:/.test(lo)) return true;
  if (lo.startsWith('fc') || lo.startsWith('fd')) return true;
  if (lo.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — extract and recurse through v4 check.
    const v4 = lo.slice('::ffff:'.length);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) {
      return isPrivateV4(v4);
    }
    return true;
  }
  return false;
}

export interface ResolvedAddr {
  address: string;
  family: 4 | 6;
}

export interface AssertedUrl {
  url: URL;
  resolved: ResolvedAddr[];
}

/**
 * Validate that `raw` is a public https URL with no userinfo, no non-443
 * port, and that DNS resolution of the host produces only public
 * addresses. Returns the parsed URL + resolved addresses.
 *
 * Throws Error with a short tag — callers map to CrmAuthError as needed.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<AssertedUrl> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('ssrf_guard: invalid url');
  }
  if (u.protocol !== 'https:') {
    throw new Error('ssrf_guard: https required');
  }
  if (u.username || u.password) {
    throw new Error('ssrf_guard: userinfo not allowed');
  }
  if (u.port && u.port !== '443') {
    throw new Error('ssrf_guard: non-443 port');
  }
  const host = u.hostname;
  if (!host) {
    throw new Error('ssrf_guard: missing host');
  }
  // Literal IP shortcut — dns.lookup on `127.0.0.1` returns it verbatim,
  // but we want to catch IPv6 brackets / mixed-case literals before any
  // DNS round-trip.
  // Strip IPv6 brackets if present.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) && isPrivateV4(bare)) {
    throw new Error(`ssrf_guard: private v4 literal ${bare}`);
  }
  if (bare.includes(':') && isPrivateV6(bare)) {
    throw new Error(`ssrf_guard: private v6 literal ${bare}`);
  }

  let addrs: ResolvedAddr[];
  try {
    const result = (await dnsLookup(host, { all: true, verbatim: true })) as Array<{
      address: string;
      family: number;
    }>;
    addrs = result.map((a) => ({
      address: a.address,
      family: a.family === 6 ? 6 : 4,
    }));
  } catch (err) {
    throw new Error(
      `ssrf_guard: dns lookup failed for ${host}: ${(err as Error).message || 'unknown'}`,
    );
  }
  if (addrs.length === 0) {
    throw new Error(`ssrf_guard: dns lookup returned no addresses for ${host}`);
  }
  for (const { address, family } of addrs) {
    if (family === 4 && isPrivateV4(address)) {
      throw new Error(`ssrf_guard: private v4 ${address}`);
    }
    if (family === 6 && isPrivateV6(address)) {
      throw new Error(`ssrf_guard: private v6 ${address}`);
    }
  }
  return { url: u, resolved: addrs };
}

/**
 * Build a custom `lookup` callback compatible with axios/http.Agent that
 * always returns the first address from `resolved`. Pinning the request
 * to the address we already validated defeats DNS rebinding (where the
 * second resolution between guard and request hits a private IP).
 */
export function lookupForResolved(
  resolved: ResolvedAddr[],
): (
  hostname: string,
  options: dns.LookupOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void {
  const first = resolved[0];
  return (_hostname, _options, callback) => {
    // Defensive: re-check the pinned address. If it has somehow become
    // private (it should not — we resolved it in assertPublicHttpsUrl) we
    // refuse the request.
    if (first.family === 4 && isPrivateV4(first.address)) {
      callback(new Error('ssrf_guard: pinned v4 became private') as NodeJS.ErrnoException, '', 0);
      return;
    }
    if (first.family === 6 && isPrivateV6(first.address)) {
      callback(new Error('ssrf_guard: pinned v6 became private') as NodeJS.ErrnoException, '', 0);
      return;
    }
    callback(null, first.address, first.family);
  };
}
