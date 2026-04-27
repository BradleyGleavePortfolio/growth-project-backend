import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import { sanitizeInviteCode } from '../src/public-pages/public-pages.html';

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: string | undefined;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    send(payload: string) {
      body = payload;
      return this;
    },
    get headers() {
      return headers;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  } as any;
}

describe('PublicPagesController', () => {
  const controller = new PublicPagesController();

  it('serves a 200 HTML page for /download/ios mentioning the App Store', () => {
    const res = makeRes();
    controller.iosDownload(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('App Store');
  });

  it('serves a 200 HTML page for /download/android mentioning Google Play', () => {
    const res = makeRes();
    controller.androidDownload(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('Google Play');
  });

  it('serves a 200 HTML page for /signup that explains invite-only access', () => {
    const res = makeRes();
    controller.signup(undefined, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('invite');
  });

  it('does not embed unresolved Apple/Google placeholder IDs', () => {
    const res = makeRes();
    controller.iosDownload(res);
    expect(res.body).not.toMatch(/apps\.apple\.com\/app\/id\d/);
    expect(res.body).not.toMatch(/play\.google\.com\/store\/apps\/details/);
  });

  it('renders the invite code on /signup when supplied via ?code=', () => {
    const res = makeRes();
    controller.signup('GP-A1B2C3', res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('GP-A1B2C3');
    expect(res.body).toContain('Your invite code');
    // The mailto subject carries the code so a support reply has context.
    expect(res.body).toContain('mailto:hello@trygrowthproject.com');
    expect(res.body).toMatch(/subject=Invite(%20|\+)GP-A1B2C3/);
  });

  it('renders the invite code on /signup/:code via the path variant', () => {
    const res = makeRes();
    controller.signupWithCode('GP-XYZ789', res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('GP-XYZ789');
    expect(res.body).toContain('Your invite is ready');
  });

  it('switches /signup to no-store when an invite code is present', () => {
    const withCode = makeRes();
    controller.signup('GP-A1B2C3', withCode);
    expect(withCode.headers['Cache-Control']).toBe('no-store, max-age=0');

    const withoutCode = makeRes();
    controller.signup(undefined, withoutCode);
    expect(withoutCode.headers['Cache-Control']).toBe('public, max-age=300');
  });

  it('silently drops invite codes that fail validation and renders the generic page', () => {
    const cases = [
      '<script>alert(1)</script>',
      'GP A1B2C3', // space — not in [A-Za-z0-9-]
      'GP_A1B2C3', // underscore — not in [A-Za-z0-9-]
      'AB',        // too short
      'A'.repeat(33), // too long
      '../etc/passwd',
      '"onload=alert(1)"',
    ];
    for (const bad of cases) {
      const res = makeRes();
      controller.signup(bad, res);
      expect(res.statusCode).toBe(200);
      // Generic copy is shown when the code doesn't validate.
      expect(res.body).toContain('Sign up by invite');
      expect(res.body).not.toContain('Your invite code');
      // No reflection of the bad input back into the markup.
      expect(res.body).not.toContain(bad);
    }
  });

  it('silently drops invalid path-variant codes and shows the generic page', () => {
    const res = makeRes();
    controller.signupWithCode('not valid', res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sign up by invite');
    expect(res.body).not.toContain('Your invite code');
  });
});

describe('sanitizeInviteCode', () => {
  it('accepts canonical GP-style codes', () => {
    expect(sanitizeInviteCode('GP-A1B2C3')).toBe('GP-A1B2C3');
    expect(sanitizeInviteCode('abc')).toBe('abc');
    expect(sanitizeInviteCode('a-b-c-1-2-3')).toBe('a-b-c-1-2-3');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(sanitizeInviteCode('  GP-A1B2C3  ')).toBe('GP-A1B2C3');
  });

  it('rejects empty / wrong-length / wrong-charset / non-string input', () => {
    expect(sanitizeInviteCode(undefined)).toBeNull();
    expect(sanitizeInviteCode(null)).toBeNull();
    expect(sanitizeInviteCode('')).toBeNull();
    expect(sanitizeInviteCode('ab')).toBeNull(); // 2 chars
    expect(sanitizeInviteCode('A'.repeat(33))).toBeNull(); // 33 chars
    expect(sanitizeInviteCode('GP A1B2C3')).toBeNull(); // space
    expect(sanitizeInviteCode('GP_A1B2C3')).toBeNull(); // underscore
    expect(sanitizeInviteCode('GP/A1B2C3')).toBeNull(); // slash
    expect(sanitizeInviteCode('<script>')).toBeNull();
    expect(sanitizeInviteCode(12345 as unknown)).toBeNull();
  });
});
