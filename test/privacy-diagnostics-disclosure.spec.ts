/**
 * backend #611 FIX ROUND 8 (B-611-116, agent 116): GPT-6.1 Sol B-611-7 and
 * Claude Opus C-611-12. The public Privacy Policy said crash and performance
 * reports "include your account ID and email address". The implemented
 * Sentry boundary is account id only:
 *   - mobile src/services/sentry.ts `setSentryUser` calls
 *     `Sentry.setUser({ id: user.id })`, and src/services/sentryPrivacy.ts
 *     `scrubEvent` reduces any event user to `{ id }` (mobile main 367e6c48);
 *   - backend src/observability/sentry-config.ts `beforeSend` forwards an
 *     allow-listed envelope with no `user` at all, and the backend never
 *     calls `Sentry.setUser`.
 * The procedure of record (docs/privacy/vendor-deletion-and-backups.md §6)
 * already says so. The public text must say the same, and the telemetry
 * boundary stays id-only (this spec pins the backend half of it).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import * as Sentry from '@sentry/node';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import { buildSentryOptions } from '../src/observability/sentry-config';

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

const privacyHtml = renderTrustPage('privacy');
const privacy = visibleText(privacyHtml);
const health = visibleText(renderTrustPage('consumer-health'));
const DOC = readFileSync(
  join(__dirname, '..', 'docs', 'privacy', 'vendor-deletion-and-backups.md'),
  'utf8',
);

const DIAGNOSTIC_ITEM =
  'Device, usage and diagnostic data — IP address, browser or device type, app version, request times and security logs; product analytics events and screen views linked to your account ID; and crash and performance reports linked to your account ID, with no name or email address attached.';

function diagnosticItem(): string {
  const match = /<li>(Device, usage and diagnostic data[^<]*)<\/li>/.exec(privacyHtml);
  if (!match) throw new Error('diagnostic bullet missing from /privacy');
  return match[1];
}

describe('#611 B-611-7: the diagnostic disclosure matches the id-only Sentry boundary', () => {
  it('says crash and performance reports carry the account ID with no name or email attached', () => {
    const item = diagnosticItem();
    expect(item).toBe(DIAGNOSTIC_ITEM);
    expect(item).toContain(
      'crash and performance reports linked to your account ID, with no name or email address attached',
    );
    expect(item).not.toMatch(/include your account ID and email/i);
  });

  it('no policy page tells a reader that error, crash or performance reports carry their email', () => {
    for (const text of [privacy, health]) {
      for (const sentence of text.split(/(?<=[.;])\s+/)) {
        if (!/(crash|performance|error) reports?|Sentry/i.test(sentence)) continue;
        // A sentence about these reports may mention email only to say it is
        // not attached (or to name Resend, the email provider).
        if (/email/i.test(sentence)) {
          expect(sentence).toMatch(/with no name or email address attached|Resend \(email\)/);
        }
      }
    }
  });

  it('the public text and the procedure of record (§6 Sentry) say the same thing', () => {
    const sentry = DOC.slice(DOC.indexOf('## 6. Sentry'), DOC.indexOf('## 7. Resend'));
    expect(sentry).toContain('sets only the opaque user **id** on events, never the email');
    expect(sentry).toContain(
      'The Privacy Policy says crash and performance reports are linked to the account id, with no name or email address attached.',
    );
    expect(privacy).toContain(
      'crash and performance reports linked to your account ID, with no name or email address attached',
    );
  });

  it('the backend half of the boundary forwards no user, so no email, on an error event', async () => {
    const hook = buildSentryOptions('https://unused.invalid', {}).beforeSend;
    if (!hook) throw new Error('beforeSend required');
    const event: Sentry.ErrorEvent = {
      type: undefined,
      event_id: 'event-611-7',
      exception: { values: [{ type: 'Error', value: 'queue unavailable' }] },
      user: { id: 'user-611', email: 'client-611@example.invalid', username: 'client-611' },
    };
    const result = await hook(event, {});
    expect(result?.user).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('client-611@example.invalid');
  });

  it('the corrected sentence has no first person and no exclamation mark', () => {
    expect(DIAGNOSTIC_ITEM).not.toMatch(/\b(we|us|our|ours|ourselves)\b/i);
    expect(DIAGNOSTIC_ITEM).not.toContain('!');
  });
});
