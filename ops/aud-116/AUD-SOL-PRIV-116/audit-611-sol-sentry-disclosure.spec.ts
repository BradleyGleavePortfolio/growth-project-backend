// Independent GPT-6.1 Sol audit probe for #611. No candidate source change.
// Mobile main already attaches only user.id to Sentry error/transaction
// events, and #611's procedure of record explicitly records that boundary.
// The public diagnostic-data disclosure must not claim email is attached.
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';

describe('#611 diagnostic disclosure matches the id-only Sentry boundary', () => {
  it('does not tell customers crash/performance reports include their email', () => {
    const html = renderTrustPage('privacy');
    const diagnosticItem = html.match(/<li>(Device, usage and diagnostic data[^<]*)<\/li>/)?.[1];
    expect(diagnosticItem).toBeDefined();
    expect(diagnosticItem).toContain('account ID');
    expect(diagnosticItem).not.toMatch(/email address/i);
  });

  it('the procedure of record describes opaque id only, never email', () => {
    const doc = readFileSync(
      join(__dirname, '../docs/privacy/vendor-deletion-and-backups.md'),
      'utf8',
    );
    const sentrySection = doc.slice(doc.indexOf('## 6. Sentry'), doc.indexOf('## 7. Resend'));
    expect(sentrySection).toContain('sets only the opaque user **id** on events, never the email');
  });
});
