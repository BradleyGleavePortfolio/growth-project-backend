/**
 * PR-18 B3 — focused tests for LandingPagePublicController custom-domain
 * Host-header routing.
 *
 * We instantiate the controller directly with a jest-mocked
 * LandingPagePublicService (no Nest TestingModule) because every concern
 * under test is a pure-function call on the controller class:
 *   - host normalization / rejection,
 *   - canonical-host pass-through (NOT hijacked by the custom-domain branch),
 *   - verified custom-domain rendering at the apex (no `/p/...`),
 *   - unverified/unknown host → no-store 404,
 *   - checkout / lead / view custom-domain routes mapping to the same page,
 *   - X-Forwarded-Host is NEVER trusted for routing.
 *
 * The Host normalization + canonical-host filtering lives in the
 * controller; the verified-domain DB lookup is owned by the service and is
 * stubbed here so the routing logic is tested in isolation.
 */

import { LandingPagePublicController } from '../src/landing-pages/landing-pages.public.controller';

// ─── Fake Express req/res ─────────────────────────────────────────────────────

function makeReq(
  headers: Record<string, string | string[] | undefined> = {},
): any {
  return {
    headers,
    ip: '203.0.113.9',
    socket: { remoteAddress: '203.0.113.9' },
  };
}

function makeRes(): any {
  const state: {
    _headers: Record<string, string>;
    _status?: number;
    _body?: unknown;
    _redirect?: { status: number; url: string };
  } = { _headers: {} };
  const res: any = {
    ...state,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
    redirect(status: number, url: string) {
      this._redirect = { status, url };
      return undefined;
    },
  };
  return res;
}

// ─── Mock LandingPagePublicService ────────────────────────────────────────────

const VERIFIED_HOST = 'coaching.example.com';
const COACH_SLUG = 'GP-JANE1';
const PAGE_SLUG = 'my-page';
const RENDERED_HTML = '<!doctype html><html>verified page</html>';
const CHECKOUT_URL =
  'https://app.trygrowthproject.com/v1/packages/public/join/tok_abc?lp=page-1';

function makeService(overrides: Record<string, jest.Mock> = {}) {
  return {
    // Only the verified host resolves to an address; everything else null.
    resolveCustomDomainAddress: jest.fn(async (host: string) =>
      host === VERIFIED_HOST
        ? { coachSlug: COACH_SLUG, pageSlug: PAGE_SLUG }
        : null,
    ),
    renderPage: jest.fn(async () => ({ html: RENDERED_HTML, found: true })),
    resolveCheckoutUrl: jest.fn(async () => CHECKOUT_URL),
    submitLead: jest.fn(async () => ({ ok: true })),
    recordView: jest.fn(async () => undefined),
    ...overrides,
  };
}

function build(overrides: Record<string, jest.Mock> = {}) {
  const svc = makeService(overrides);
  const ctrl = new LandingPagePublicController(svc as any);
  return { ctrl, svc };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LandingPagePublicController — custom-domain Host routing (B3)', () => {
  describe('GET / (custom-domain root)', () => {
    it('renders the verified custom-domain page without /p/... params', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: VERIFIED_HOST });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).toHaveBeenCalledWith(VERIFIED_HOST);
      expect(svc.renderPage).toHaveBeenCalledWith(COACH_SLUG, PAGE_SLUG);
      expect(res._status).toBe(200);
      expect(res._body).toBe(RENDERED_HTML);
      expect(res._headers['cache-control']).toContain('max-age=60');
      expect(res._headers['cache-control']).toContain('stale-while-revalidate');
    });

    it('normalizes a Host with port + trailing dot + uppercase before lookup', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'Coaching.Example.com.:8443' });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      // Port stripped, trailing dot removed, lowercased → bare host.
      expect(svc.resolveCustomDomainAddress).toHaveBeenCalledWith(VERIFIED_HOST);
      expect(res._status).toBe(200);
    });

    it('returns a no-store 404 for an unknown/unverified host', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'evil.attacker.com' });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).toHaveBeenCalledWith(
        'evil.attacker.com',
      );
      expect(svc.renderPage).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._headers['cache-control']).toBe('no-store, max-age=0');
    });

    it('returns a no-store 404 (does NOT look up) for a canonical app host', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'app.trygrowthproject.com' });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      // Canonical host short-circuits BEFORE any DB lookup.
      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(svc.renderPage).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._headers['cache-control']).toBe('no-store, max-age=0');
    });

    it.each([
      ['comma chain', 'coaching.example.com,evil.com'],
      ['embedded path', 'coaching.example.com/evil'],
      ['scheme', 'https://coaching.example.com'],
      ['userinfo', 'user@coaching.example.com'],
      ['empty', '   '],
    ])('rejects a malicious Host (%s) → no-store 404, no lookup', async (_label, host) => {
      const { ctrl, svc } = build();
      const req = makeReq({ host });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._headers['cache-control']).toBe('no-store, max-age=0');
    });

    it('rejects an over-length Host (>253 chars)', async () => {
      const { ctrl, svc } = build();
      const longHost = `${'a'.repeat(250)}.com`;
      const req = makeReq({ host: longHost });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
    });

    it('NEVER trusts X-Forwarded-Host for routing (only Host)', async () => {
      const { ctrl, svc } = build();
      // Host is canonical (would 404); attacker tries to steer routing to a
      // verified domain via X-Forwarded-Host. It must be ignored entirely.
      const req = makeReq({
        host: 'app.trygrowthproject.com',
        'x-forwarded-host': VERIFIED_HOST,
      });
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(svc.renderPage).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
    });

    it('returns no-store 404 when Host header is entirely absent', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({});
      const res = makeRes();

      await ctrl.renderCustomDomainRoot(req, res);

      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
    });
  });

  describe('GET /p/:coachSlug/:pageSlug (canonical, unchanged)', () => {
    it('still renders from path params regardless of Host', async () => {
      const { ctrl, svc } = build();
      const res = makeRes();

      await ctrl.renderPage('GP-OTHER', 'other-page', res);

      // Path route uses its params directly — no host resolution at all.
      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(svc.renderPage).toHaveBeenCalledWith('GP-OTHER', 'other-page');
      expect(res._status).toBe(200);
    });

    it('404s on over-length slug without touching the custom-domain branch', async () => {
      const { ctrl, svc } = build();
      const res = makeRes();

      await ctrl.renderPage('x'.repeat(81), 'page', res);

      expect(svc.renderPage).not.toHaveBeenCalled();
      expect(svc.resolveCustomDomainAddress).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._headers['cache-control']).toBe('no-store, max-age=0');
    });
  });

  describe('GET /checkout (custom-domain)', () => {
    it('maps to the same page checkout and 302s to the storefront', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: VERIFIED_HOST });
      const res = makeRes();

      await ctrl.checkoutCustomDomain('pkg-1', req, res);

      expect(svc.resolveCheckoutUrl).toHaveBeenCalledWith(
        COACH_SLUG,
        PAGE_SLUG,
        'pkg-1',
      );
      expect(res._redirect).toEqual({ status: 302, url: CHECKOUT_URL });
    });

    it('400s on missing tier (same as /p/... checkout)', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: VERIFIED_HOST });
      const res = makeRes();

      await ctrl.checkoutCustomDomain('', req, res);

      expect(svc.resolveCheckoutUrl).not.toHaveBeenCalled();
      expect(res._status).toBe(400);
      expect(res._body).toMatchObject({ error: 'missing_tier' });
    });

    it('404 no-store for a non-custom-domain host (does not leak checkout)', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'app.trygrowthproject.com' });
      const res = makeRes();

      await ctrl.checkoutCustomDomain('pkg-1', req, res);

      expect(svc.resolveCheckoutUrl).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._headers['cache-control']).toBe('no-store, max-age=0');
    });
  });

  describe('POST /leads (custom-domain)', () => {
    it('submits the lead against the resolved page', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: VERIFIED_HOST });

      const out = await ctrl.submitLeadCustomDomain(
        { email: 'a@b.com' } as any,
        req,
      );

      expect(svc.submitLead).toHaveBeenCalledWith(COACH_SLUG, PAGE_SLUG, {
        email: 'a@b.com',
      });
      expect(out).toEqual({ ok: true });
    });

    it('returns {ok:false} silently for a non-custom-domain host', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'unknown.example.org' });

      const out = await ctrl.submitLeadCustomDomain(
        { email: 'a@b.com' } as any,
        req,
      );

      expect(svc.submitLead).not.toHaveBeenCalled();
      expect(out).toEqual({ ok: false });
    });

    it('preserves the 429 throttle behavior from the service', async () => {
      const { ctrl, svc } = build({
        submitLead: jest.fn(async () => {
          const e: any = new Error('TOO_MANY_LEADS');
          e.status = 429;
          throw e;
        }),
      });
      const req = makeReq({ host: VERIFIED_HOST });

      await expect(
        ctrl.submitLeadCustomDomain({ email: 'a@b.com' } as any, req),
      ).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('POST /view (custom-domain)', () => {
    it('records a view against the resolved page', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({
        host: VERIFIED_HOST,
        'user-agent': 'Mozilla/5.0',
        referer: 'https://instagram.com',
      });

      const out = await ctrl.recordViewCustomDomain(
        { scroll_depth: 50 } as any,
        req,
      );

      // Fire-and-forget: returns immediately. Give the async write a tick.
      await new Promise((r) => setTimeout(r, 5));

      expect(out).toEqual({ ok: true });
      expect(svc.recordView).toHaveBeenCalledTimes(1);
      expect(svc.recordView).toHaveBeenCalledWith(
        COACH_SLUG,
        PAGE_SLUG,
        { scroll_depth: 50 },
        expect.any(String),
        'Mozilla/5.0',
        'https://instagram.com',
      );
    });

    it('always 200s but does nothing for a non-custom-domain host', async () => {
      const { ctrl, svc } = build();
      const req = makeReq({ host: 'app.trygrowthproject.com' });

      const out = await ctrl.recordViewCustomDomain({} as any, req);

      expect(out).toEqual({ ok: true });
      expect(svc.recordView).not.toHaveBeenCalled();
    });
  });
});
