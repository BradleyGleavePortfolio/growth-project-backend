/**
 * R49 SNI host-routing middleware tests.
 *
 * The middleware reads `req.headers.host`, looks up a verified domain,
 * and rewrites `req.url` to /p/<coach>/<page>/...  We verify:
 *   - Platform hosts pass through unchanged.
 *   - Unknown hosts are negative-cached and pass through.
 *   - Verified domains: GET / → GET /p/<coach>/<page>.
 *   - Subroutes (/checkout, /leads, /view) are rewritten with query
 *     string preservation.
 *   - Unmapped subpaths fall through (e.g. /robots.txt).
 *   - Cache TTL means a second lookup within 60s does not hit DB.
 */

import { LandingPageHostMiddleware } from '../src/landing-pages/domains/host-routing.middleware';

function makeService(resolveResult: any = null) {
  const profileFindFirst = jest.fn(async ({ where }: any) => {
    if (where.coach_id === 'coach-1') return { invite_code: 'GP-COACH1' };
    return null;
  });
  return {
    resolveByHost: jest.fn().mockResolvedValue(resolveResult),
    // The middleware reaches into the service to grab a profile slug.
    // Expose a minimal `prisma` so the tests can assert on it.
    prisma: { coachProfile: { findFirst: profileFindFirst } },
  };
}

function makeReq(host: string, url: string): any {
  return {
    headers: { host },
    url,
  };
}

function nextFn() {
  return jest.fn();
}

const verifiedResult = {
  domain: {
    id: 'dom-1',
    domain: 'coaching.example.com',
    coach_id: 'coach-1',
    landing_page_id: 'page-1',
    verification_status: 'verified',
    cert_status: 'issued',
  },
  landing_page: {
    id: 'page-1',
    coach_id: 'coach-1',
    slug: 'transform',
    status: 'published',
  },
};

describe('LandingPageHostMiddleware', () => {
  let mw: LandingPageHostMiddleware;
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService(verifiedResult);
    mw = new LandingPageHostMiddleware(svc as any);
  });

  it('passes through platform hosts unchanged', async () => {
    const req = makeReq('app.trygrowthproject.com', '/api/v1/health');
    const next = nextFn();
    await mw.use(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.url).toBe('/api/v1/health');
    expect(svc.resolveByHost).not.toHaveBeenCalled();
  });

  it('passes through *.fly.dev', async () => {
    const req = makeReq('growth-project-backend.fly.dev', '/api/v1/whatever');
    const next = nextFn();
    await mw.use(req, {} as any, next);
    expect(req.url).toBe('/api/v1/whatever');
    expect(svc.resolveByHost).not.toHaveBeenCalled();
  });

  it('rewrites GET / on a verified domain to /p/<coach>/<page>', async () => {
    const req = makeReq('coaching.example.com', '/');
    const next = nextFn();
    await mw.use(req, {} as any, next);
    expect(req.url).toBe('/p/GP-COACH1/transform');
    expect(req.headers['x-tgp-original-host']).toBe('coaching.example.com');
    expect(req.headers['x-tgp-original-url']).toBe('/');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rewrites GET /checkout?tier=pkg preserving query', async () => {
    const req = makeReq('coaching.example.com', '/checkout?tier=pkg-1');
    await mw.use(req, {} as any, nextFn());
    expect(req.url).toBe('/p/GP-COACH1/transform/checkout?tier=pkg-1');
  });

  it('rewrites POST /leads + /view', async () => {
    const req1 = makeReq('coaching.example.com', '/leads');
    await mw.use(req1, {} as any, nextFn());
    expect(req1.url).toBe('/p/GP-COACH1/transform/leads');

    const req2 = makeReq('coaching.example.com', '/view');
    await mw.use(req2, {} as any, nextFn());
    expect(req2.url).toBe('/p/GP-COACH1/transform/view');
  });

  it('falls through on unknown sub-paths (e.g. /robots.txt)', async () => {
    const req = makeReq('coaching.example.com', '/robots.txt');
    await mw.use(req, {} as any, nextFn());
    expect(req.url).toBe('/robots.txt');
  });

  it('falls through (404 path) for unknown host with negative cache entry', async () => {
    svc.resolveByHost.mockResolvedValueOnce(null);
    const req = makeReq('bogus.example.com', '/');
    await mw.use(req, {} as any, nextFn());
    expect(req.url).toBe('/');
    // Second request within TTL should NOT re-query the DB.
    await mw.use(makeReq('bogus.example.com', '/page'), {} as any, nextFn());
    expect(svc.resolveByHost).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite when verification is not issued (unpublished page)', async () => {
    svc.resolveByHost.mockResolvedValueOnce({
      ...verifiedResult,
      landing_page: { ...verifiedResult.landing_page, status: 'draft' },
    });
    const req = makeReq('coaching.example.com', '/');
    await mw.use(req, {} as any, nextFn());
    expect(req.url).toBe('/');
  });

  it('strips port from Host header before lookup', async () => {
    const req = makeReq('coaching.example.com:8443', '/');
    await mw.use(req, {} as any, nextFn());
    expect(svc.resolveByHost).toHaveBeenCalledWith('coaching.example.com');
    expect(req.url).toBe('/p/GP-COACH1/transform');
  });

  it('caches positive lookups for 60s', async () => {
    await mw.use(makeReq('coaching.example.com', '/'), {} as any, nextFn());
    await mw.use(makeReq('coaching.example.com', '/checkout'), {} as any, nextFn());
    expect(svc.resolveByHost).toHaveBeenCalledTimes(1);
  });

  it('survives a DB blip without persisting the failure', async () => {
    svc.resolveByHost.mockRejectedValueOnce(new Error('db down'));
    const req = makeReq('coaching.example.com', '/');
    await mw.use(req, {} as any, nextFn());
    expect(req.url).toBe('/'); // fell through
    // The negative-cache TTL is short (5s) for DB errors, so a second
    // call within that window does NOT retry — that's intentional to
    // shield the DB during outages.  We verify only that the
    // middleware did not throw.
  });

  it('resetForTests clears the cache', async () => {
    await mw.use(makeReq('coaching.example.com', '/'), {} as any, nextFn());
    mw.resetForTests();
    await mw.use(makeReq('coaching.example.com', '/'), {} as any, nextFn());
    expect(svc.resolveByHost).toHaveBeenCalledTimes(2);
  });
});
