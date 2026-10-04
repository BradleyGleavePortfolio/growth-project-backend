/**
 * C-611-18 (agent 117, B-PRIV-FU-117; Claude Opus 5.5 lens at #611 b09f2061):
 * the Sign in with Apple iPhone steps on /privacy and /help/delete-account are
 * right on iOS 18 and later only, and the app supports iOS 16.4 and later
 * (Expo SDK 56; ExpoModulesCore.podspec sets ios 16.4).
 *
 * Apple's own guides, fetched 2026-10-04:
 *   - iPhone User Guide, iOS 18.0 and iOS 26, "Sign in with Apple on iPhone":
 *     Settings > [your name] > Sign in with Apple > the app > Delete >
 *     Stop Using. Apple Support 102571 (published 2026-09-14) gives the same
 *     path and the web path account.apple.com > Sign-In & Security > Sign in
 *     with Apple.
 *     https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/18.0/ios/18.0
 *     https://support.apple.com/en-us/102571
 *   - iPhone User Guide, iOS 16.0 and iOS 17.0: Settings > [your name] >
 *     Password and Security > Apps Using Your Apple ID > the app > Stop Using
 *     Apple ID.
 *     https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/17.0/ios/17.0
 *
 * So the iPhone sentence says it is for iOS 18 or later, and earlier versions
 * (and any other device) get the web steps, which do not depend on the iOS
 * version. Apple's link stays on both pages.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as trust from '../src/public-pages/trust-pages.html';
import { renderHelpPage } from '../src/public-pages/help-pages.html';

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const map: Record<string, string> = {
    '&quot;': '"',
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
  };
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m)
    .replace(/\s+/g, ' ');
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`missing start marker: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`missing end marker: ${end}`);
  return text.slice(from, to);
}

function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/);
}

const privacyHtml = trust.renderTrustPage('privacy');
const helpHtml = renderHelpPage('delete-account');
const privacyDeletion = between(
  visibleText(privacyHtml),
  'Deleting your account',
  'De-identified information',
);
const helpInApp = between(
  visibleText(helpHtml),
  'Delete your account in the app',
  'Ask us by email if you do not have the app',
);
const DOC = readFileSync(
  join(__dirname, '..', 'docs', 'privacy', 'vendor-deletion-and-backups.md'),
  'utf8',
);

describe('C-611-18: the Sign in with Apple steps match the iOS version', () => {
  it('the iPhone steps say they are for iOS 18 or later, before the first step', () => {
    for (const text of [trust.SIGN_IN_WITH_APPLE_DELETION_TEXT, privacyDeletion, helpInApp]) {
      const iphone = sentences(text).filter((s) => /\biPhone\b/.test(s));
      expect(iphone).toHaveLength(1);
      const step = iphone[0];
      expect(step).toContain('iOS 18 or later');
      expect(step.indexOf('iOS 18 or later')).toBeLessThan(step.indexOf('open Settings'));
    }
  });

  it('earlier iOS versions and other devices get the web steps', () => {
    for (const text of [trust.SIGN_IN_WITH_APPLE_DELETION_TEXT, privacyDeletion, helpInApp]) {
      const web = sentences(text).filter((s) => s.includes('account.apple.com'));
      expect(web).toHaveLength(1);
      expect(web[0]).toMatch(/^On an earlier version of iOS, or on any other device, /);
      expect(web[0]).toContain('Sign-In & Security');
      expect(web[0]).not.toMatch(/\bSettings\b/);
    }
  });

  it('no page gives the iOS 16/17 menu names as current steps', () => {
    for (const text of [privacyDeletion, helpInApp]) {
      expect(text).not.toMatch(/Password (?:and|&) Security|Apps Using Your Apple ID|Stop Using Apple ID/);
    }
  });

  it('both pages still link Apple Support 102571', () => {
    const anchor = `<a href="${trust.APPLE_SIGN_IN_SUPPORT_URL}">${trust.APPLE_SIGN_IN_SUPPORT_LINK.label}</a>`;
    for (const html of [privacyHtml, helpHtml]) expect(html).toContain(anchor);
  });

  it('procedures §0 record the iOS 18 qualifier and the earlier-version source', () => {
    const s0 = between(DOC, 'Sign in with Apple: #608 revokes', 'Everything below covers');
    expect(s0).toContain('iOS 18 or later');
    expect(s0).toContain('iOS 16.4');
    expect(s0).toContain('https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/17.0/ios/17.0');
  });

  it('the new copy has no first person and no exclamation mark', () => {
    const s = trust.SIGN_IN_WITH_APPLE_DELETION_TEXT;
    expect(s).not.toMatch(/\b(we|us|our|ours|ourselves)\b/i);
    expect(s).not.toContain('!');
  });
});
