import { GetAppController } from '../src/get-app/get-app.controller';
import { GetAppService } from '../src/get-app/get-app.service';

// Minimal express-like Response double — same pattern as
// test/invite-landing.spec.ts. Avoids booting Nest for what is fundamentally
// a render + status assertion.
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

describe('GetAppController', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let controller: GetAppController;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.PUBLIC_WEB_SIGNUP_URL;
    delete process.env.PUBLIC_INVITE_BASE_URL;
    controller = new GetAppController(new GetAppService());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('renders 200 HTML for /get-app/ios with iOS-specific copy', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const res = makeRes();
    await controller.ios(undefined, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(res.body).toContain('iPhone');
    // Web signup CTA is rendered.
    expect(res.body).toContain('https://app.example.com/signup');
  });

  it('renders 200 HTML for /get-app/android with Android-specific copy', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const res = makeRes();
    await controller.android(undefined, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Android');
    expect(res.body).toContain('https://app.example.com/signup');
  });

  it('renders 200 HTML for /get-app with generic copy', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const res = makeRes();
    await controller.generic(undefined, res);
    expect(res.statusCode).toBe(200);
    // Generic page advertises both platforms in the lead and does not pick
    // a single-platform headline — this is the platform-agnostic interstitial.
    expect(res.body).toContain('Get The Growth Project');
    expect(res.body).not.toContain('iPhone');
    expect(res.body).not.toContain('for Android');
  });

  it('forwards a valid invite code into the web signup URL', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const res = makeRes();
    await controller.ios('GP-A1B2C3', res);
    expect(res.body).toContain('https://app.example.com/signup?code=GP-A1B2C3');
  });

  it('drops a too-short or too-long invite code without surfacing it', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const tooShort = makeRes();
    await controller.ios('ab', tooShort);
    expect(tooShort.body).not.toContain('code=');
    const tooLong = makeRes();
    await controller.ios('A'.repeat(33), tooLong);
    expect(tooLong.body).not.toContain('code=');
  });

  it('falls back to PUBLIC_INVITE_BASE_URL when PUBLIC_WEB_SIGNUP_URL is unset', async () => {
    process.env.PUBLIC_INVITE_BASE_URL = 'https://app.example.com/join';
    const res = makeRes();
    await controller.android(undefined, res);
    expect(res.body).toContain('https://app.example.com/join');
  });

  it('escapes a malicious-shaped PUBLIC_WEB_SIGNUP_URL into a safe href', async () => {
    // A misconfigured operator setting javascript: must not produce a live
    // javascript href in the rendered HTML. The render layer drops the URL
    // to "#" rather than reflecting an unsafe scheme.
    process.env.PUBLIC_WEB_SIGNUP_URL = 'javascript:alert(1)';
    const res = makeRes();
    await controller.ios(undefined, res);
    expect(res.body).not.toContain('javascript:alert');
    expect(res.body).toMatch(/href="#"/);
  });

  it('marks the page noindex,nofollow', async () => {
    process.env.PUBLIC_WEB_SIGNUP_URL = 'https://app.example.com/signup';
    const res = makeRes();
    await controller.generic(undefined, res);
    expect(res.body).toContain('noindex,nofollow');
  });
});
