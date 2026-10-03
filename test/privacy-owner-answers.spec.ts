/**
 * backend #611 FIX ROUND 7 (B-MOB-A, agent 115): the owner's answers to the
 * publication-hold questions (operator 115, 11:25 PDT 2026-10-03), items
 * O-611-1..6. Each item is pinned on every page that carries it, and the
 * new sentences speak without first person.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderTrustPage } from '../src/public-pages/trust-pages.html';
import { renderHelpPage } from '../src/public-pages/help-pages.html';

function visibleText(html: string): string {
  const bodyStart = html.indexOf('<body>');
  const body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  const map: Record<string, string> = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
  return body
    .split(/<[^>]*>/)
    .join(' ')
    .replace(/&(?:quot|#39|lt|gt|amp);/g, (m) => map[m] ?? m)
    .replace(/\s+/g, ' ');
}

const privacy = visibleText(renderTrustPage('privacy'));
const health = visibleText(renderTrustPage('consumer-health'));
const deleteHelp = visibleText(renderHelpPage('delete-account'));
const DOC = readFileSync(join(__dirname, '..', 'docs', 'privacy', 'vendor-deletion-and-backups.md'), 'utf8');

const ANTHROPIC =
  'Anthropic deletes what it receives within 30 days, except where its usage policy or the law requires it to keep it longer.';
const BACKUPS = 'database backups and copies are never kept more than six months after a confirmed deletion request';
const DUMPS =
  'Copies of the database made before an update to the service are deleted 30 days after the update is verified, and never kept beyond 90 days.';
const DEIDENTIFIED =
  'After an account is deleted, de-identified, aggregated information that cannot identify the person may be kept. TGP takes reasonable measures so it cannot be linked to anyone, commits publicly to keep it only in de-identified form and never to try to re-identify it, and requires by contract anyone it shares it with to do the same.';
const HEALTH_USE =
  'Health and fitness data is never used for advertising or for data mining other than to improve health management, and is used for health research only with your permission.';

const NEW_SENTENCES = [
  'Your information is kept while your account is open. Deletion can be started in the app or by email.',
  ANTHROPIC,
  'Mux — hosting and playback of the videos coaches upload. It receives the video files, with no name, email or account details attached.',
  'Mux (video hosting and playback) receives the videos coaches upload',
  'Backups — database backups and copies are never kept more than six months after a confirmed deletion request.',
  DUMPS,
  'Error reports in Sentry — 90 days.',
  'Email logs in Resend — 30 days.',
  'Product analytics in PostHog — a deleted person is removed from PostHog within 30 days of the deletion.',
  'PostHog — product analytics. Session recording is off.',
  'At Stripe, deletion requests are handled with Stripe’s redaction tools; Stripe keeps the payment records the law requires.',
  DEIDENTIFIED,
  HEALTH_USE,
];

describe('#611 owner answers O-611-1..6', () => {
  it('O-611-1: kept while the account is open; deletion starts in the app or by email', () => {
    expect(privacy).toContain(
      'Deleting your account Your information is kept while your account is open. Deletion can be started in the app or by email.',
    );
  });

  it('O-611-2: no ZDR — the Anthropic 30-day sentence on the Privacy Policy and the health policy deletion section', () => {
    expect(privacy).toContain(ANTHROPIC);
    const deletion = health.slice(health.indexOf('Deletion When'));
    expect(deletion).toContain(ANTHROPIC);
    expect(DOC).toMatch(/no\*\* ZDR agreement with Anthropic/);
  });

  it('O-611-3: Mux is named, with what it receives, in both provider lists', () => {
    expect(privacy).toContain('Mux — hosting and playback of the videos coaches upload.');
    expect(health).toContain('Mux (video hosting and playback) receives the videos coaches upload');
  });

  it('O-611-4: backups are plan-agnostic on every page; no rolling-schedule or plan claim', () => {
    for (const text of [privacy, health, deleteHelp]) {
      expect(text.toLowerCase()).toContain(BACKUPS);
      expect(text).toMatch(/deleted 30 days after the update is verified,? and never kept beyond 90 days/);
      expect(text).not.toMatch(/rolling schedule|overwritten|7-day|seven days|Supabase.{0,40}backup/i);
    }
    expect(DOC).toMatch(/production is on the Supabase \*\*Free\*\* plan/);
    expect(DOC).toMatch(/Procedure \(ADOPTED by the owner 2026-10-03/);
  });

  it('O-611-5: Stripe redaction, Sentry 90 days, Resend 30 days, PostHog recording off and removal within 30 days', () => {
    expect(privacy).toContain('Stripe’s redaction tools; Stripe keeps the payment records the law requires.');
    expect(privacy).toContain('Error reports in Sentry — 90 days.');
    expect(privacy).toContain('Email logs in Resend — 30 days.');
    expect(privacy).toContain('PostHog — product analytics. Session recording is off.');
    expect(privacy).toContain('a deleted person is removed from PostHog within 30 days of the deletion.');
  });

  it('O-611-6: de-identified data (RCW 19.373.010) and health data use (Apple 5.1.3) on both policies', () => {
    for (const text of [privacy, health]) {
      expect(text).toContain(DEIDENTIFIED);
      expect(text).toContain(HEALTH_USE);
    }
  });

  it('the new sentences use no first person and no exclamation mark', () => {
    for (const s of NEW_SENTENCES) {
      expect(s).not.toMatch(/\b(we|us|our|ours|ourselves)\b/i);
      expect(s).not.toContain('!');
    }
  });
});
