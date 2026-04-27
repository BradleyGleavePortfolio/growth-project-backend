import { PublicPagesController } from '../src/public-pages/public-pages.controller';

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
    controller.signup(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('invite');
  });

  it('does not embed unresolved Apple/Google placeholder IDs', () => {
    const res = makeRes();
    controller.iosDownload(res);
    expect(res.body).not.toMatch(/apps\.apple\.com\/app\/id\d/);
    expect(res.body).not.toMatch(/play\.google\.com\/store\/apps\/details/);
  });
});
