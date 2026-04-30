import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import {
  renderHelpPage,
  HELP_LAST_REVIEWED,
  SUPPORT_EMAIL,
  type HelpPage,
} from '../src/public-pages/help-pages.html';

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

const ALL_PAGES: ReadonlyArray<HelpPage> = [
  'index',
  'setup',
  'first-client',
  'tour',
  'faq',
  'support',
  'contact',
];

const ROUTE_HANDLERS: ReadonlyArray<{
  page: HelpPage;
  method: keyof PublicPagesController;
  expectInBody: string;
}> = [
  { page: 'index', method: 'helpIndex' as any, expectInBody: 'Help' },
  { page: 'setup', method: 'helpSetup' as any, expectInBody: 'Coach setup checklist' },
  {
    page: 'first-client',
    method: 'helpFirstClient' as any,
    expectInBody: 'Invite your first client',
  },
  { page: 'tour', method: 'helpTour' as any, expectInBody: 'Coach console tour' },
  { page: 'faq', method: 'helpFaq' as any, expectInBody: 'Frequently asked questions' },
  { page: 'support', method: 'helpSupport' as any, expectInBody: 'What support covers' },
  { page: 'contact', method: 'helpContact' as any, expectInBody: 'Contact support' },
];

describe('PublicPagesController help pages', () => {
  const controller = new PublicPagesController();

  it.each(ROUTE_HANDLERS)(
    'serves /help/$page as a 200 HTML page',
    ({ method, expectInBody }) => {
      const res = makeRes();
      (controller as any)[method](res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toMatch(/text\/html/);
      expect(res.body).toContain(expectInBody);
    },
  );

  it('sets a sensible Cache-Control on every help page', () => {
    for (const { method } of ROUTE_HANDLERS) {
      const res = makeRes();
      (controller as any)[method](res);
      expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    }
  });

  it('emits a last-reviewed date in ISO-8601 (YYYY-MM-DD) form', () => {
    expect(HELP_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reuses the operator-confirmed support email from trust-pages', () => {
    // Help and trust pages must agree on the single mailbox so a future
    // operator change happens in one place.
    expect(SUPPORT_EMAIL).toBe('Bradley@Bradleytgpcoaching.com');
  });

  it('renders the support address only on the contact page intro and the shared footer', () => {
    // Setup, first-client, tour, faq, and support pages route coaches to
    // the contact page rather than naming the mailbox in body copy. The
    // shared footer at the bottom of every page is the one place outside
    // the contact page where the address appears.
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      const occurrences = html.split(SUPPORT_EMAIL).length - 1;
      if (slug === 'contact') {
        // Contact: intro + footer (display) + footer (mailto href).
        expect(occurrences).toBeGreaterThanOrEqual(2);
      } else {
        // Other pages: footer display + footer mailto href = 2.
        expect(occurrences).toBe(2);
      }
    }
  });

  it('includes a navigation header linking every help page from each page', () => {
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      expect(html).toContain('href="/help"');
      expect(html).toContain('href="/help/setup"');
      expect(html).toContain('href="/help/first-client"');
      expect(html).toContain('href="/help/tour"');
      expect(html).toContain('href="/help/faq"');
      expect(html).toContain('href="/help/support"');
      expect(html).toContain('href="/help/contact"');
    }
  });

  it('does not contain placeholders, TODOs, or "coming soon" copy', () => {
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      expect(html).not.toMatch(/TODO/);
      expect(html).not.toMatch(/FIXME/);
      expect(html).not.toMatch(/coming soon/i);
      expect(html).not.toMatch(/lorem ipsum/i);
      expect(html).not.toMatch(/placeholder/i);
      // Unresolved tokens like ${SUPPORT_EMAIL} must not leak through.
      expect(html).not.toMatch(/\$\{[A-Z_]+\}/);
    }
  });

  it('does not contain emoji', () => {
    // Quiet-luxury enterprise tone: no emoji on any help page. The regex
    // covers the common Unicode emoji ranges (pictographs, symbols,
    // dingbats, regional indicators).
    const emojiPattern =
      /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/u;
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      expect(html).not.toMatch(emojiPattern);
    }
  });

  it('avoids AI fingerprints / boilerplate hedging in help copy', () => {
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      expect(html).not.toMatch(/as an AI/i);
      expect(html).not.toMatch(/As a language model/i);
      expect(html).not.toMatch(/I cannot provide/i);
    }
  });

  it('escapes the support email correctly into both display text and mailto on every page', () => {
    for (const slug of ALL_PAGES) {
      const html = renderHelpPage(slug);
      expect(html).toContain(`mailto:${SUPPORT_EMAIL}`);
      expect(html).toContain(SUPPORT_EMAIL);
    }
  });

  it('contact page exposes the structured intake schema fields', () => {
    const html = renderHelpPage('contact');
    // The intake schema is the contract for any future contact form
    // built against this inbox; the field names must round-trip.
    for (const field of [
      'account_email',
      'category',
      'subject',
      'body',
      'client_email',
      'attachments',
      'console_url',
      'user_agent',
      'ts_iso',
    ]) {
      expect(html).toContain(field);
    }
    // And the canonical category enum.
    for (const value of [
      'outage',
      'billing',
      'client_signup',
      'data',
      'security',
      'account_merge',
      'other',
    ]) {
      expect(html).toContain(value);
    }
  });

  it('support page links to the public status page so coaches self-route outage reports', () => {
    const html = renderHelpPage('support');
    expect(html).toContain('https://app.trygrowthproject.com/status');
  });

  it('setup and first-client pages reference the canonical console and invite URLs', () => {
    const setup = renderHelpPage('setup');
    expect(setup).toContain('https://console.thegrowthproject.app');
    expect(setup).toContain('https://app.trygrowthproject.com/join');
    const firstClient = renderHelpPage('first-client');
    expect(firstClient).toContain('https://app.trygrowthproject.com/join');
  });

  it('faq page contains the most-frequent coach questions verbatim', () => {
    const html = renderHelpPage('faq');
    expect(html).toContain('Why does my account say Client instead of Coach');
    expect(html).toContain('Does my invite link expire');
    expect(html).toContain('Are messages real-time');
    expect(html).toContain('Where do I get an invoice');
  });
});
