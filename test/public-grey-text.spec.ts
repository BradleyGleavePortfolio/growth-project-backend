// FX-1136 (owner #168-13, "use a nice dark grey like #2c2c2c"; public web pages: "yes"):
// every small grey text on a light ground of the public web pages is #2C2C2C, the
// older faint greys are gone, and each pairing clears WCAG AA 4.5:1.
import { renderHelpPage } from '../src/public-pages/help-pages.html';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import {
  renderBillingUpdateCardPage, renderDigestUnsubscribePage, renderDownloadPage, renderEmailConfirmedPage,
  renderOpenAppPage, renderSignupPage,
} from '../src/public-pages/public-pages.html';
import { renderPayPageState } from '../src/storefront/pay-page.html';
import { renderThankYouPage } from '../src/storefront/thank-you.html';
import { InviteLandingService } from '../src/invite-landing/invite-landing.service';
import type { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { renderDownloadErrorPage } from '../src/data-export/data-export.controller';
import { contrastOnPaper, contrastRatio, cssValue } from './_fixtures/css-contrast';

const GREY = '#2C2C2C';
// Body text on the help and policy pages (owner 10-23).
const BODY = ['p.intro', 'section p', 'section li'];
const HELP_TABLE = 'table.intake th, table.intake td';
const OLD_GREYS = /#(8A7F6E|6F6658|6B675F|6B6259)\b|color:#555\b/i;

// renderValid never reads the code service.
const invite = new InviteLandingService({} as InviteCodesService);
const PAGES: Record<string, string> = {
  help: renderHelpPage('setup'),
  trust: renderTrustPage('privacy'),
  signup: renderSignupPage('GP-A1B2C3'),
  pay: renderPayPageState('This plan is no longer offered.', 'n'),
  thankYou: renderThankYouPage({
    packageName: 'P', amountFormatted: '$1.00', isRecurring: false, nextChargeAt: null,
    unlocked: [], upcoming: [],
  }),
  invite: invite.renderValid({
    code: 'GP-X1Y2Z3', coach_name: 'A', business_name: null, accent_color: null, logo_url: null,
    deep_link_url: 'tgp://join/GP-X1Y2Z3', app_store_url: 'https://apps.apple.com/app/x',
    play_store_url: 'https://play.google.com/store/apps/details?id=x',
    android_package: 'com.growthproject.app', platform: 'ios', nonce: 'n',
  }),
  exportError: renderDownloadErrorPage(null, 'Try again.', 'req-1'),
};

describe('public pages: one small grey text colour, #2C2C2C (owner #168-13)', () => {
  it.each(Object.keys(PAGES))('%s carries none of the older faint greys', (k) => {
    expect(PAGES[k]).not.toMatch(OLD_GREYS);
  });

  it('help, trust and the shared public layout use #2C2C2C at AA on the page paper', () => {
    const sels: Array<[string, string[]]> = [
      ['help', ['nav.help-nav .nav-link', 'p.reviewed', 'p.footnote', 'footer.brand-footer', 'footer.brand-footer a', ...BODY, HELP_TABLE]],
      ['trust', ['nav.trust-nav .nav-link', 'p.reviewed', 'p.footnote', 'footer.brand-footer', 'footer.brand-footer a', ...BODY]],
      ['signup', ['p', 'p.code-label', 'ul.links a', 'footer', 'footer a']],
    ];
    for (const [k, list] of sels) {
      for (const sel of list) expect([k, sel, PAGES[k].includes(`  ${sel} {`)]).toEqual([k, sel, true]);
      for (const [sel, ratio] of Object.entries(contrastOnPaper(PAGES[k], list))) {
        expect([k, sel, ratio]).toEqual([k, sel, 13.18]);
      }
      // help also draws the phone labels of the contact table in it (inside @media, checked below);
      // signup also uses it as the button's hover ground (checked below).
      expect(PAGES[k].match(/#2C2C2C/g)).toHaveLength(list.length + (k === 'help' || k === 'signup' ? 1 : 0));
    }
  });

  // COLOR-FOLLOWUPS (owner 10-23: "Make the help and policy page body text #2C2C2C? sure"):
  // intro, section paragraphs, lists, contact-table cells and their phone labels left #3A332B.
  it.each(['help', 'trust'])('%s body text is #2C2C2C, with no #3A332B left', (k) => {
    const html = k === 'help' ? renderHelpPage('contact') : PAGES.trust;
    expect(html).not.toMatch(/#3A332B/i);
    const sels = k === 'help' ? [...BODY, HELP_TABLE] : BODY;
    for (const [sel, ratio] of Object.entries(contrastOnPaper(html, sels))) {
      expect([k, sel, ratio]).toEqual([k, sel, 13.18]);
    }
    if (k === 'help') {
      expect(html).toMatch(/table\.intake td\[data-label\]::before \{[^}]*color: #2C2C2C;/);
      expect(html).toContain('<table class="intake"');
    }
  });

  // COLOR-FIX-2 (owner D5 - A): the landing page's body text, its link list and the button's
  // hover ground left #3A332B; every page on the shared layout, and every public page, now has none.
  const HELP_SLUGS = ['index', 'setup', 'first-client', 'tour', 'faq', 'support', 'contact', 'delete-account'] as const;
  const TRUST_SLUGS = ['privacy', 'consumer-health', 'terms', 'security', 'status'] as const;
  const SHARED_LAYOUT: Record<string, string> = {
    'download ios': renderDownloadPage('ios'),
    'download android': renderDownloadPage('android'),
    'billing update card': renderBillingUpdateCardPage(),
    'email confirmed': renderEmailConfirmedPage(),
    'open app': renderOpenAppPage(),
    'unsubscribe confirm': renderDigestUnsubscribePage('confirm', '/email/unsubscribe?t=x'),
    'unsubscribe done': renderDigestUnsubscribePage('done'),
    'unsubscribe expired': renderDigestUnsubscribePage('expired'),
    'unsubscribe invalid': renderDigestUnsubscribePage('invalid'),
    'signup with code': renderSignupPage('GP-A1B2C3'),
    'signup without code': renderSignupPage(null),
  };
  const EVERY_PUBLIC_PAGE: Record<string, string> = {
    ...SHARED_LAYOUT,
    ...Object.fromEntries(HELP_SLUGS.map((h) => [`help ${h}`, renderHelpPage(h)])),
    ...Object.fromEntries(TRUST_SLUGS.map((t) => [`trust ${t}`, renderTrustPage(t)])),
    ...PAGES,
  };

  it.each(Object.keys(EVERY_PUBLIC_PAGE))('%s has no #3A332B left', (k) => {
    expect(EVERY_PUBLIC_PAGE[k]).not.toMatch(/#3A332B/i);
  });

  it.each(Object.keys(SHARED_LAYOUT))('%s draws its body text and links in #2C2C2C at 13.18:1', (k) => {
    expect(contrastOnPaper(SHARED_LAYOUT[k], ['p', 'ul.links a'])).toEqual({ p: 13.18, 'ul.links a': 13.18 });
    expect(cssValue(SHARED_LAYOUT[k], 'a.cta:hover', 'background')).toBe(GREY);
  });

  it('keeps the button words readable on its #2C2C2C hover ground, and the hover still differs from rest', () => {
    const html = SHARED_LAYOUT['open app'];
    const words = cssValue(html, 'a.cta', 'color');
    expect(words).toBe('#FBF8F3');
    expect(contrastRatio(words as string, GREY)).toBeGreaterThanOrEqual(4.5);
    expect(cssValue(html, 'a.cta', 'background')).toBe('#1F1B16');
  });

  it('the current help and trust tab stays marked once its grey matches the others', () => {
    expect(PAGES.help).toMatch(/nav\.help-nav \.nav-link\.active \{ color: #1F1B16; text-decoration: underline;/);
    expect(PAGES.trust).toMatch(/nav\.trust-nav \.nav-link\.active \{ color: #1F1B16; text-decoration: underline;/);
  });

  it('pay page, thank-you, invite and export pages set their muted text to #2C2C2C', () => {
    expect(PAGES.pay).toContain('--muted:#2C2C2C;');
    expect(PAGES.thankYou).toContain('--muted: #2C2C2C;');
    expect(PAGES.invite).toContain('--muted: #2C2C2C;');
    expect(PAGES.exportError).toContain('.ref{color:#2C2C2C;');
  });

  it('every light ground those pages draw #2C2C2C on clears AA 4.5:1', () => {
    // pay: bone, surface; thank-you / invite: paper, card, soft panel; export: page; help/trust/public: paper.
    for (const bg of ['#F5EFE4', '#FFFDF8', '#FAF7F2', '#FFFFFF', '#F1ECE1', '#FAF9F6', '#FBF8F3']) {
      expect([bg, contrastRatio(GREY, bg) >= 4.5]).toEqual([bg, true]);
    }
  });
});
