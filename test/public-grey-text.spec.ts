// FX-1136 (owner #168-13, "use a nice dark grey like #2c2c2c"; public web pages: "yes"):
// every small grey text on a light ground of the public web pages is #2C2C2C, the
// older faint greys are gone, and each pairing clears WCAG AA 4.5:1.
import { renderHelpPage } from '../src/public-pages/help-pages.html';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import { renderSignupPage } from '../src/public-pages/public-pages.html';
import { renderPayPageState } from '../src/storefront/pay-page.html';
import { renderThankYouPage } from '../src/storefront/thank-you.html';
import { InviteLandingService } from '../src/invite-landing/invite-landing.service';
import type { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { renderDownloadErrorPage } from '../src/data-export/data-export.controller';
import { contrastOnPaper, contrastRatio } from './_fixtures/css-contrast';

const GREY = '#2C2C2C';
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
      ['help', ['nav.help-nav .nav-link', 'p.reviewed', 'p.footnote', 'footer.brand-footer', 'footer.brand-footer a']],
      ['trust', ['nav.trust-nav .nav-link', 'p.reviewed', 'p.footnote', 'footer.brand-footer', 'footer.brand-footer a']],
      ['signup', ['p.code-label', 'footer', 'footer a']],
    ];
    for (const [k, list] of sels) {
      for (const sel of list) expect([k, sel, PAGES[k].includes(`  ${sel} {`)]).toEqual([k, sel, true]);
      for (const [sel, ratio] of Object.entries(contrastOnPaper(PAGES[k], list))) {
        expect([k, sel, ratio]).toEqual([k, sel, 13.18]);
      }
      expect(PAGES[k].match(/#2C2C2C/g)).toHaveLength(list.length);
    }
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
