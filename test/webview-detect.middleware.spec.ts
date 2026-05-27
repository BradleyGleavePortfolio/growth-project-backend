// A279-P2-1 — host allow-list for the webview interstitial.
//
// Express has no `trust proxy` configured, and Fly's edge forwards
// client headers verbatim, so an attacker can craft a request with a
// malicious `X-Forwarded-Host` (or `Host`) value. The interstitial
// renders the host into both an <a href> and a visible copy-paste
// <code> block — classic phishing / brand-injection vector.
//
// `resolveTrustedHost` is the single chokepoint: it validates each
// header value against ALLOWED_INTERSTITIAL_HOSTS, falls through on
// failure, and ends at the hard-coded canonical default.

import {
  WebviewDetectMiddleware,
  resolveTrustedHost,
} from '../src/storefront/webview-detect.middleware';

function fakeReq(
  headers: Record<string, string | string[] | undefined>,
  overrides: Partial<{ method: string; path: string; originalUrl: string }> = {},
): any {
  return {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/v1/packages/public/abc',
    originalUrl: overrides.originalUrl ?? '/v1/packages/public/abc',
    headers,
  };
}

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode: number | null = null;
  let body: string | null = null;
  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    status: jest.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    send: jest.fn((b: string) => {
      body = b;
      return res;
    }),
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res;
}

describe('resolveTrustedHost (A279-P2-1)', () => {
  it('accepts a valid X-Forwarded-Host', () => {
    const host = resolveTrustedHost({
      headers: { 'x-forwarded-host': 'joingrowthproject.com' },
    });
    expect(host).toBe('joingrowthproject.com');
  });

  it('accepts app.trygrowthproject.com', () => {
    expect(
      resolveTrustedHost({
        headers: { 'x-forwarded-host': 'app.trygrowthproject.com' },
      }),
    ).toBe('app.trygrowthproject.com');
  });

  it('rejects a malicious X-Forwarded-Host and falls through to Host', () => {
    const host = resolveTrustedHost({
      headers: {
        'x-forwarded-host': 'evil.example',
        host: 'app.trygrowthproject.com',
      },
    });
    expect(host).toBe('app.trygrowthproject.com');
  });

  it('rejects a malicious Host and falls through to the default', () => {
    const host = resolveTrustedHost({
      headers: { host: 'evil.example' },
    });
    expect(host).toBe('joingrowthproject.com');
  });

  it('rejects malicious values on BOTH headers and falls through to default', () => {
    const host = resolveTrustedHost({
      headers: {
        'x-forwarded-host': 'attacker.tld',
        host: 'also-attacker.tld',
      },
    });
    expect(host).toBe('joingrowthproject.com');
  });

  it('comma-separated X-Forwarded-Host uses the FIRST value only', () => {
    // First value is allow-listed; trailing values are ignored. This
    // matches RFC 7239 / X-Forwarded-* convention.
    const host = resolveTrustedHost({
      headers: { 'x-forwarded-host': 'joingrowthproject.com, evil.com' },
    });
    expect(host).toBe('joingrowthproject.com');
  });

  it('comma-separated X-Forwarded-Host with malicious FIRST value falls through (does NOT scan tail for a valid host)', () => {
    // Crucial: an attacker who can inject a header MUST NOT be able to
    // sneak through by listing a valid host as a tail entry.
    const host = resolveTrustedHost({
      headers: {
        'x-forwarded-host': 'evil.com, joingrowthproject.com',
        host: 'app.trygrowthproject.com',
      },
    });
    expect(host).toBe('app.trygrowthproject.com');
  });

  it('strips a port suffix (`app.trygrowthproject.com:443` → `app.trygrowthproject.com`)', () => {
    const host = resolveTrustedHost({
      headers: { 'x-forwarded-host': 'app.trygrowthproject.com:443' },
    });
    expect(host).toBe('app.trygrowthproject.com');
  });

  it('is case-insensitive (DNS hostnames are case-insensitive)', () => {
    const host = resolveTrustedHost({
      headers: { 'x-forwarded-host': 'JoinGrowthProject.com' },
    });
    expect(host).toBe('joingrowthproject.com');
  });

  it('handles empty / missing headers by returning the default', () => {
    expect(resolveTrustedHost({ headers: {} })).toBe('joingrowthproject.com');
    expect(
      resolveTrustedHost({
        headers: { 'x-forwarded-host': '', host: '' },
      }),
    ).toBe('joingrowthproject.com');
  });

  it('treats an array-form X-Forwarded-Host (some proxies parse) like the string form', () => {
    // Express/node may surface a multi-valued header as an array. We
    // take the first array entry and run it through the same
    // comma-split / port-strip / allow-list normalisation.
    const host = resolveTrustedHost({
      headers: { 'x-forwarded-host': ['evil.com', 'joingrowthproject.com'] },
    });
    expect(host).toBe('joingrowthproject.com'); // falls through to default
  });

  it('whitespace-only header is treated as missing', () => {
    expect(
      resolveTrustedHost({
        headers: { 'x-forwarded-host': '   ', host: '   ' },
      }),
    ).toBe('joingrowthproject.com');
  });

  it('rejects subdomain-prefix typosquats (`joingrowthproject.com.evil.com`)', () => {
    // Set.has is exact-string equality, not suffix \u2014 this is the
    // structural reason the allow-list is safe against this attack.
    expect(
      resolveTrustedHost({
        headers: { 'x-forwarded-host': 'joingrowthproject.com.evil.com' },
      }),
    ).toBe('joingrowthproject.com');
  });
});

describe('WebviewDetectMiddleware host-rendering (A279-P2-1)', () => {
  function uaInstagram() {
    return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 280.0.0.0';
  }

  it('renders allow-listed host into the interstitial body', () => {
    const mw = new WebviewDetectMiddleware();
    const req = fakeReq({
      'user-agent': uaInstagram(),
      'x-forwarded-host': 'app.trygrowthproject.com',
      'x-forwarded-proto': 'https',
    });
    const res = fakeRes();
    mw.use(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('app.trygrowthproject.com');
    // Must NOT contain a malicious host.
    expect(res.body).not.toContain('evil');
  });

  it('drops a malicious X-Forwarded-Host and renders the safe Host instead', () => {
    const mw = new WebviewDetectMiddleware();
    const req = fakeReq({
      'user-agent': uaInstagram(),
      'x-forwarded-host': 'attacker.example',
      host: 'joingrowthproject.com',
      'x-forwarded-proto': 'https',
    });
    const res = fakeRes();
    mw.use(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('joingrowthproject.com');
    expect(res.body).not.toContain('attacker.example');
  });

  it('drops a malicious Host too and falls through to the default', () => {
    const mw = new WebviewDetectMiddleware();
    const req = fakeReq({
      'user-agent': uaInstagram(),
      host: 'attacker.example',
      'x-forwarded-proto': 'https',
    });
    const res = fakeRes();
    mw.use(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('joingrowthproject.com');
    expect(res.body).not.toContain('attacker.example');
  });

  it('non-webview UA passes through (no interstitial, host validation irrelevant)', () => {
    const mw = new WebviewDetectMiddleware();
    const req = fakeReq({
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const res = fakeRes();
    const next = jest.fn();
    mw.use(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });
});
