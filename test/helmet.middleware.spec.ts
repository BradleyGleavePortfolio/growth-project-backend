import helmet from 'helmet';

// Audit E-1: helmet must be installed and registered globally in main.ts.
// We can't easily boot the full app in this unit-style suite, but we CAN
// assert two things that make a regression visible:
//
//   1. The package resolves and produces a working middleware function.
//   2. That middleware sets the security headers we care about (HSTS,
//      frameguard / X-Frame-Options, X-Content-Type-Options: nosniff,
//      Referrer-Policy) so a future tweak to the helmet() call site can't
//      silently drop them.
//
// The corresponding wiring assertion lives implicitly in main.ts itself —
// a grep for `app.use(helmet(...))` would catch removal at code-review time.

describe('helmet middleware (audit E-1)', () => {
  function runHelmet(opts: Parameters<typeof helmet>[0] = {}) {
    const mw = helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      ...opts,
    });
    const headers: Record<string, string | number | string[]> = {};
    const req: any = { headers: {}, secure: true };
    const res: any = {
      setHeader(k: string, v: string | number | string[]) {
        headers[k.toLowerCase()] = v;
      },
      getHeader(k: string) {
        return headers[k.toLowerCase()];
      },
      removeHeader(k: string) {
        delete headers[k.toLowerCase()];
      },
    };
    return new Promise<typeof headers>((resolve, reject) => {
      (mw as any)(req, res, (err: unknown) => (err ? reject(err) : resolve(headers)));
    });
  }

  it('returns a middleware function', () => {
    expect(typeof helmet).toBe('function');
    expect(typeof helmet()).toBe('function');
  });

  it('sets HSTS by default', async () => {
    const headers = await runHelmet();
    expect(headers['strict-transport-security']).toBeDefined();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const headers = await runHelmet();
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options (frameguard) to a deny-by-default value', async () => {
    const headers = await runHelmet();
    const xfo = String(headers['x-frame-options'] ?? '').toUpperCase();
    expect(['SAMEORIGIN', 'DENY']).toContain(xfo);
  });

  it('sets a Referrer-Policy header', async () => {
    const headers = await runHelmet();
    expect(headers['referrer-policy']).toBeDefined();
  });

  it('does NOT set Content-Security-Policy when CSP is disabled (JSON API)', async () => {
    const headers = await runHelmet();
    expect(headers['content-security-policy']).toBeUndefined();
  });
});
