/**
 * SSRF guard tests — coverage for the assertPublicHttpsUrl helper used
 * by the webhook CRM adapter (and others). Mocks dns.lookup so we can
 * deterministically force a hostname to resolve to a given address.
 *
 * Audit #6 P0-1 — required coverage for every blocked CIDR + IMDS
 * endpoint + a valid public URL happy path.
 */
import {
  assertPublicHttpsUrl,
  isPrivateV4,
  isPrivateV6,
} from '../src/common/net/ssrf-guard';

// jest.mock'ing dns/promises is brittle (resolves before our mock is
// installed). Instead we stub dns.lookup which is what the module uses
// via util.promisify.
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return {
    ...actual,
    lookup: (
      hostname: string,
      opts: { all?: boolean } | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
      cb?: (err: NodeJS.ErrnoException | null, result: Array<{ address: string; family: number }>) => void,
    ) => {
      // Both signatures supported. Our helper uses (host, { all: true, verbatim: true }, cb).
      const callback = typeof opts === 'function' ? opts : cb!;
      const mapping = (globalThis as unknown as { __ssrfDnsMap?: Record<string, Array<{ address: string; family: number }>> })
        .__ssrfDnsMap;
      const entry = mapping?.[hostname];
      if (entry) {
        // Always called with all:true in our module.
        (callback as unknown as (
          err: NodeJS.ErrnoException | null,
          result: Array<{ address: string; family: number }>,
        ) => void)(null, entry);
        return;
      }
      // Default to the literal hostname when it is an IP.
      if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        (callback as unknown as (
          err: NodeJS.ErrnoException | null,
          result: Array<{ address: string; family: number }>,
        ) => void)(null, [{ address: hostname, family: 4 }]);
        return;
      }
      (callback as unknown as (
        err: NodeJS.ErrnoException | null,
        result: Array<{ address: string; family: number }>,
      ) => void)(
        Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException,
        [],
      );
    },
  };
});

function setDns(host: string, addrs: Array<{ address: string; family: number }>): void {
  (globalThis as unknown as { __ssrfDnsMap: Record<string, Array<{ address: string; family: number }>> }).__ssrfDnsMap =
    {
      ...(((globalThis as unknown as { __ssrfDnsMap?: Record<string, unknown> }).__ssrfDnsMap as Record<
        string,
        Array<{ address: string; family: number }>
      >) ?? {}),
      [host]: addrs,
    };
}

beforeEach(() => {
  (globalThis as unknown as { __ssrfDnsMap: Record<string, unknown> }).__ssrfDnsMap = {};
});

describe('SSRF guard — pure helpers', () => {
  it('flags every documented private v4 range', () => {
    expect(isPrivateV4('10.0.0.1')).toBe(true);
    expect(isPrivateV4('127.0.0.1')).toBe(true);
    expect(isPrivateV4('169.254.169.254')).toBe(true); // AWS/GCP IMDS
    expect(isPrivateV4('192.168.1.1')).toBe(true);
    expect(isPrivateV4('172.16.0.1')).toBe(true);
    expect(isPrivateV4('172.31.255.254')).toBe(true);
    expect(isPrivateV4('0.0.0.0')).toBe(true);
    expect(isPrivateV4('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateV4('100.127.255.254')).toBe(true);
  });
  it('does not flag public v4', () => {
    expect(isPrivateV4('8.8.8.8')).toBe(false);
    expect(isPrivateV4('172.15.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateV4('172.32.0.1')).toBe(false);
    expect(isPrivateV4('100.63.0.1')).toBe(false);
    expect(isPrivateV4('100.128.0.1')).toBe(false);
  });
  it('flags v6 loopback / ULA / link-local / v4-mapped', () => {
    expect(isPrivateV6('::1')).toBe(true);
    expect(isPrivateV6('::')).toBe(true);
    expect(isPrivateV6('fe80::1')).toBe(true);
    expect(isPrivateV6('fc00::1')).toBe(true);
    expect(isPrivateV6('fd12:3456::1')).toBe(true);
    expect(isPrivateV6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateV6('::ffff:169.254.169.254')).toBe(true);
  });
  it('does not flag public v6', () => {
    expect(isPrivateV6('2606:4700:4700::1111')).toBe(false); // cloudflare
    expect(isPrivateV6('2001:4860:4860::8888')).toBe(false); // google dns
  });
});

describe('assertPublicHttpsUrl — scheme + form rejections', () => {
  it('rejects non-https', async () => {
    await expect(assertPublicHttpsUrl('http://example.com')).rejects.toThrow(/https/);
  });
  it('rejects userinfo', async () => {
    setDns('example.com', [{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHttpsUrl('https://user:pass@example.com')).rejects.toThrow(/userinfo/);
  });
  it('rejects userinfo-style host-hijack attempt', async () => {
    setDns('evil.com', [{ address: '93.184.216.34', family: 4 }]);
    // `x@evil.com` makes evil.com the host and `x` the userinfo
    await expect(assertPublicHttpsUrl('https://x@evil.com')).rejects.toThrow(/userinfo/);
  });
  it('rejects non-443 ports', async () => {
    setDns('example.com', [{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHttpsUrl('https://example.com:8080/')).rejects.toThrow(/port/);
  });
  it('rejects malformed urls', async () => {
    await expect(assertPublicHttpsUrl('not a url')).rejects.toThrow(/invalid/);
  });
});

describe('assertPublicHttpsUrl — DNS-resolved blocked ranges', () => {
  const cases: Array<{ host: string; addr: string; family: 4 | 6; label: string }> = [
    { host: 'aws-imds.evil.test', addr: '169.254.169.254', family: 4, label: 'AWS IMDS' },
    { host: 'private10.evil.test', addr: '10.1.2.3', family: 4, label: '10/8' },
    { host: 'loopback.evil.test', addr: '127.0.0.1', family: 4, label: '127/8' },
    { host: 'lan.evil.test', addr: '192.168.0.1', family: 4, label: '192.168/16' },
    { host: 'enterprise.evil.test', addr: '172.16.0.1', family: 4, label: '172.16/12' },
    { host: 'cgnat.evil.test', addr: '100.64.0.1', family: 4, label: '100.64/10 CGNAT' },
    { host: 'v6loop.evil.test', addr: '::1', family: 6, label: 'v6 loopback' },
    { host: 'v6ula.evil.test', addr: 'fc00::1', family: 6, label: 'v6 ULA' },
    { host: 'v6link.evil.test', addr: 'fe80::1', family: 6, label: 'v6 link-local' },
    { host: 'v6mapped.evil.test', addr: '::ffff:127.0.0.1', family: 6, label: 'v4-mapped' },
  ];
  for (const c of cases) {
    it(`rejects DNS-resolved ${c.label}`, async () => {
      setDns(c.host, [{ address: c.addr, family: c.family }]);
      await expect(assertPublicHttpsUrl(`https://${c.host}/`)).rejects.toThrow(/private/);
    });
  }

  it('rejects IPv4 literal pointed at IMDS', async () => {
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private v4 literal/,
    );
  });

  it('rejects when ANY resolved address is private (mixed-public-and-private)', async () => {
    setDns('mixed.evil.test', [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(assertPublicHttpsUrl('https://mixed.evil.test/')).rejects.toThrow(/private v4 10/);
  });
});

describe('assertPublicHttpsUrl — happy path', () => {
  it('accepts a public https URL on port 443', async () => {
    setDns('example.com', [{ address: '93.184.216.34', family: 4 }]);
    const result = await assertPublicHttpsUrl('https://example.com/path?q=1');
    expect(result.url.hostname).toBe('example.com');
    expect(result.url.pathname).toBe('/path');
    expect(result.resolved).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
  it('accepts a public IPv6 URL', async () => {
    setDns('v6public.test', [{ address: '2606:4700:4700::1111', family: 6 }]);
    const result = await assertPublicHttpsUrl('https://v6public.test/');
    expect(result.resolved[0].family).toBe(6);
  });
});
