import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import {
  renderTrustPage,
  SUPPORT_EMAIL,
  POLICY_LAST_REVIEWED,
} from '../src/public-pages/trust-pages.html';

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

describe('PublicPagesController trust pages', () => {
  const controller = new PublicPagesController();

  it('serves /privacy as a 200 HTML page with privacy-policy copy', () => {
    const res = makeRes();
    controller.privacy(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toContain('Privacy Policy');
    expect(res.body).toContain('What we collect');
    expect(res.body).toContain('Your rights');
    // Practical user-rights path must surface the support email.
    expect(res.body).toContain(SUPPORT_EMAIL);
    // Last-reviewed signal so reviewers and customers see freshness.
    expect(res.body).toContain(POLICY_LAST_REVIEWED);
  });

  it('serves /terms as a 200 HTML page with terms-of-service copy', () => {
    const res = makeRes();
    controller.terms(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Terms of Service');
    expect(res.body).toContain('Acceptable use');
    expect(res.body).toContain('Subscriptions and billing');
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('serves /security as a 200 HTML page describing practical controls', () => {
    const res = makeRes();
    controller.security(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Security');
    expect(res.body).toContain('Transport and storage');
    expect(res.body).toContain('Incident response');
    // Honest about not holding audit certifications today — this is the
    // failure mode we are explicitly avoiding (no fake SOC 2 claim).
    expect(res.body).toMatch(/do not, however, currently hold/i);
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('serves /status as a 200 HTML page that lists current public endpoints honestly', () => {
    const res = makeRes();
    controller.status(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Status');
    // The endpoints section should enumerate the real surface area.
    expect(res.body).toContain('https://app.trygrowthproject.com/signup');
    expect(res.body).toContain(
      'https://app.trygrowthproject.com/download/ios',
    );
    expect(res.body).toContain(
      'https://app.trygrowthproject.com/download/android',
    );
    expect(res.body).toContain('https://app.trygrowthproject.com/health');
    // Explicit reporting channel.
    expect(res.body).toContain(SUPPORT_EMAIL);
  });

  it('sets a sensible Cache-Control on every trust page', () => {
    for (const route of ['privacy', 'terms', 'security', 'status'] as const) {
      const res = makeRes();
      (controller as any)[route](res);
      expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    }
  });

  it('does not claim certifications it does not hold (no SOC2 / HIPAA / ISO claims)', () => {
    const html = renderTrustPage('security');
    // Allow the *negative* mention ("we do not hold SOC 2") but reject any
    // affirmative claim. We assert by pattern: no "SOC 2 compliant",
    // "ISO 27001 certified", "HIPAA compliant" (case-insensitive).
    expect(html).not.toMatch(/SOC\s*2\s*(compliant|certified)/i);
    expect(html).not.toMatch(/ISO\s*27001\s*(compliant|certified)/i);
    expect(html).not.toMatch(/HIPAA\s*(compliant|certified)/i);
    expect(html).not.toMatch(/PCI[- ]DSS\s*(compliant|certified)/i);
  });

  it('avoids AI fingerprints / boilerplate hedging in trust copy', () => {
    for (const slug of ['privacy', 'terms', 'security', 'status'] as const) {
      const html = renderTrustPage(slug);
      expect(html).not.toMatch(/as an AI/i);
      expect(html).not.toMatch(/As a language model/i);
      expect(html).not.toMatch(/I cannot provide/i);
    }
  });

  it('includes a navigation header linking the four trust pages from each page', () => {
    for (const slug of ['privacy', 'terms', 'security', 'status'] as const) {
      const html = renderTrustPage(slug);
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/security"');
      expect(html).toContain('href="/status"');
    }
  });

  it('escapes the support email correctly into both display text and mailto', () => {
    const html = renderTrustPage('privacy');
    expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
    expect(html).toContain(SUPPORT_EMAIL);
  });

  it('uses the operator-confirmed support email (Bradley@Bradleytgpcoaching.com)', () => {
    expect(SUPPORT_EMAIL).toBe('Bradley@Bradleytgpcoaching.com');
  });

  it('emits a last-reviewed date in ISO-8601 (YYYY-MM-DD) form', () => {
    expect(POLICY_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
