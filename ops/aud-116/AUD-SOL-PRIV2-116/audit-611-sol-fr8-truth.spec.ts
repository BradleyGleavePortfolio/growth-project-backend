// Independent GPT-6.1 Sol probe. Exact #611 FR8 source; no candidate edits.
import { readFileSync } from 'fs';
import { join } from 'path';
import * as Sentry from '@sentry/node';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import { renderHelpPage } from '../src/public-pages/help-pages.html';
import { buildSentryOptions } from '../src/observability/sentry-config';

const doc = readFileSync(
  join(__dirname, '../docs/privacy/vendor-deletion-and-backups.md'),
  'utf8',
);

describe('independent #611 FR8 truth checks', () => {
  it('B-611-7: diagnostic bullet discloses opaque attribution, not email attribution', () => {
    const html = renderTrustPage('privacy');
    const item = html.match(/<li>(Device, usage and diagnostic data[^<]*)<\/li>/)?.[1];
    expect(item).toBeDefined();
    expect(item).toMatch(/crash and performance reports linked to your account ID/);
    expect(item).toMatch(/with no name or email address attached/);
    expect(item).not.toMatch(/include your account ID and email address/);
    const section = doc.slice(doc.indexOf('## 6. Sentry'), doc.indexOf('## 7. Resend'));
    expect(section).toContain('sets only the opaque user **id** on events, never the email');
    expect(section).toContain('backend sets no Sentry user');
  });

  it('unchanged backend envelope strips identifying user and request fields', async () => {
    const beforeSend = buildSentryOptions('https://unused.invalid', {}).beforeSend;
    if (!beforeSend) throw new Error('Required privacy hook missing');
    const event: Sentry.ErrorEvent = {
      type: undefined,
      event_id: 'synthetic-sol-fr8',
      exception: { values: [{ type: 'Error', value: 'synthetic provider failure' }] },
      user: { id: 'synthetic-id', email: 'synthetic@example.invalid', username: 'synthetic' },
      request: { url: 'https://unused.invalid/?email=synthetic@example.invalid' },
    };
    const result = await beforeSend(event, {});
    expect(result).not.toBeNull();
    expect(result?.user).toBeUndefined();
    expect(result?.request).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic@example.invalid');
  });

  it('operator Apple boundary: all three rendered pages avoid claiming revocation', () => {
    const privacy = renderTrustPage('privacy');
    for (const html of [
      privacy,
      renderTrustPage('consumer-health'),
      renderHelpPage('delete-account'),
    ]) {
      expect(html).not.toMatch(/revoke|revocation/i);
    }
    expect(privacy).toContain('Sign-In &amp; Security');
    expect(privacy).toContain('stop using it with your Apple ID');
    expect(doc).toContain('apple_revocation=revoked');
    expect(doc).toContain('a follow-up PR restores the revocation sentence');
  });

  it('help page retains separate permanent account and temporary identity/code windows', () => {
    const help = renderHelpPage('delete-account');
    expect(help).toContain('Closed account:');
    expect(help).toContain('It is kept with no end date.');
    expect(help).toContain('provider’s account ID is kept');
    expect(help).toContain('one-way code made from it, for 30 days');
    expect(help).toContain('then the code is discarded');
    expect(help).toContain('within 30 days of the deletion');
  });

  it('manual Apple unlink recovery uses Apple’s current iPhone path, not its web path', () => {
    // Apple support 102571, re-read 2026-10-04 with caching disabled:
    // iPhone: Settings > [name] > Sign in with Apple > app > Delete.
    // Sign-In & Security belongs to the account.apple.com instructions.
    // https://support.apple.com/en-us/102571
    for (const html of [renderTrustPage('privacy'), renderHelpPage('delete-account')]) {
      const paragraph = html.match(/<p>[^<]*on your iPhone open Settings[^<]*<\/p>/)?.[0];
      expect(paragraph).toBeDefined();
      expect(paragraph).not.toContain('then Sign-In &amp; Security');
      expect(paragraph).toContain('then Sign in with Apple');
    }
  });
});
