/**
 * backend #611 FIX ROUND 9 (B-611-R9-116, agent 116). GPT-6.1 Sol B-611-17 and
 * Claude Opus 5.5 B-611-12, both at acf9ff0f: the manual Sign in with Apple
 * removal steps on /privacy and /help/delete-account gave the account.apple.com
 * menu (Sign-In & Security) as an iPhone step.
 *
 * Apple Support 102571, "Manage your apps with Sign in with Apple" (published
 * 2026-09-14), https://support.apple.com/en-us/102571 :
 *   - iPhone, stop using it with an app: open the Settings app, tap [your
 *     name], tap Sign in with Apple, select the app or developer, tap Delete,
 *     follow the onscreen steps to confirm;
 *   - web: sign in on account.apple.com, go to Sign-In & Security, select
 *     Sign in with Apple.
 * The iPhone User Guide, "Sign in with Apple on iPhone",
 * https://support.apple.com/guide/iphone/sign-in-with-apple-iph238921d37/ios ,
 * gives the same iPhone path (Delete, then Stop Using). Both call the account
 * "Apple Account".
 *
 * The operator ruling on RG-1 still holds: no page claims that deletion
 * revokes Sign in with Apple until the owner sets the Apple key.
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

// Sentences end at ". " (no sentence here ends in "?" or "!"); the domain
// "account.apple.com" has no space after its dots, so it stays whole.
function sentences(text: string): string[] {
  return text.split(/(?<=\.)\s+/);
}

const APPLE_SUPPORT_URL = 'https://support.apple.com/en-us/102571';
// Repinned by agent 117 for the iOS 18 qualifier (C-611-18;
// test/privacy-apple-ios-version.spec.ts).
const APPLE_NOW =
  'If you used Sign in with Apple, deleting your account ends the app’s link to your Apple Account. ' +
  'To remove the app from your Apple Account as well, on an iPhone with iOS 18 or later open Settings, tap your name, then Sign in with Apple, choose the app, tap Delete and follow the steps on screen to confirm. ' +
  'On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose the app and stop using Sign in with Apple for it.';
const APPLE_LINK_LABEL = 'Apple Support: Manage your apps with Sign in with Apple';

const privacyHtml = trust.renderTrustPage('privacy');
const healthHtml = trust.renderTrustPage('consumer-health');
const helpHtml = renderHelpPage('delete-account');
const privacy = visibleText(privacyHtml);
const health = visibleText(healthHtml);
const deleteHelp = visibleText(helpHtml);
const privacyDeletion = between(privacy, 'Deleting your account', 'De-identified information');
const helpInApp = between(
  deleteHelp,
  'Delete your account in the app',
  'Ask us by email if you do not have the app',
);
const HELP_SRC = readFileSync(
  join(__dirname, '..', 'src', 'public-pages', 'help-pages.html.ts'),
  'utf8',
);
const DOC = readFileSync(
  join(__dirname, '..', 'docs', 'privacy', 'vendor-deletion-and-backups.md'),
  'utf8',
);

describe('#611 B-611-17 / B-611-12: the Sign in with Apple removal path is Apple’s current one', () => {
  it('both pages render the one shared sentence, pinned word for word', () => {
    expect(trust.SIGN_IN_WITH_APPLE_DELETION_TEXT).toBe(APPLE_NOW);
    expect(privacyDeletion).toContain(APPLE_NOW);
    expect(helpInApp).toContain(APPLE_NOW);
    // The help page takes the shared constant; it keeps no copy of its own.
    expect(HELP_SRC).toContain('SIGN_IN_WITH_APPLE_DELETION_TEXT');
    expect(HELP_SRC).not.toMatch(/Sign in with Apple, choose the app/);
  });

  it('the iPhone steps follow Apple’s order: Settings, your name, Sign in with Apple, the app, Delete, confirm', () => {
    for (const text of [privacyDeletion, helpInApp]) {
      const iphone = sentences(text).filter((s) => /\biPhone\b/.test(s));
      expect(iphone).toHaveLength(1);
      const step = iphone[0];
      const order = [
        'open Settings',
        'tap your name',
        'Sign in with Apple',
        'choose the app',
        'tap Delete',
        'confirm',
      ].map((marker) => step.indexOf(marker));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(step).not.toContain('Sign-In & Security');
    }
  });

  it('Sign-In & Security appears only as the account.apple.com step, on every policy page', () => {
    for (const text of [privacy, health, deleteHelp]) {
      for (const s of sentences(text).filter((x) => x.includes('Sign-In & Security'))) {
        expect(s).toContain('account.apple.com');
        expect(s).not.toMatch(/\biPhone\b|\bSettings\b/);
      }
      expect(text).not.toMatch(/Settings, tap your name, then Sign-In & Security/);
    }
  });

  it('the account is called Apple Account, as Apple names it', () => {
    for (const text of [privacy, health, deleteHelp]) {
      expect(text).not.toMatch(/\bApple ID\b/);
    }
    expect(privacyDeletion).toContain('your Apple Account');
    expect(helpInApp).toContain('your Apple Account');
  });

  it('both pages link to Apple’s maintained instructions', () => {
    expect(Reflect.get(trust, 'APPLE_SIGN_IN_SUPPORT_URL')).toBe(APPLE_SUPPORT_URL);
    const anchor = `<a href="${APPLE_SUPPORT_URL}">${APPLE_LINK_LABEL}</a>`;
    for (const html of [privacyHtml, helpHtml]) {
      expect(html).toContain(anchor);
    }
    expect(trust.safeHref(APPLE_SUPPORT_URL)).toBe(APPLE_SUPPORT_URL);
  });

  it('RG-1 still holds: no page claims that deletion revokes Sign in with Apple', () => {
    for (const text of [privacy, health, deleteHelp]) {
      expect(text).not.toMatch(/revok|revocation/i);
    }
    expect(DOC).toContain('apple_revocation=revoked');
    expect(DOC).toMatch(/restores? the revocation sentence/);
  });

  it('procedures §0 record the path and its source', () => {
    const s0 = between(DOC, 'Sign in with Apple: #608 revokes', 'Everything below covers');
    expect(s0).toContain(APPLE_SUPPORT_URL);
    expect(s0).toContain('Settings > [your name] > Sign in with Apple');
    expect(s0).toContain('account.apple.com > Sign-In & Security > Sign in with Apple');
    expect(s0).not.toMatch(/\bApple ID\b/);
  });

  it('the new copy uses no first person and no exclamation mark', () => {
    for (const s of [APPLE_NOW, APPLE_LINK_LABEL]) {
      expect(s).not.toMatch(/\b(we|us|our|ours|ourselves)\b/i);
      expect(s).not.toContain('!');
    }
  });
});
