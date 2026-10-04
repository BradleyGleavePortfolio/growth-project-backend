/**
 * backend #611 FIX ROUND 8 (B-611-116, agent 116). Claude Opus 5.5 verdict
 * at 5eac8f21 (B-611-10, B-611-11, C-611-13..16) and operator 116's ruling on
 * the Sign in with Apple sentence (release gate RG-1):
 *   - B-611-10: /help/delete-account "What we keep" lists everything the
 *     Privacy Policy says is kept, from shared strings;
 *   - B-611-11: the runbook steps that create database dumps carry the
 *     published 30/90-day limits (procedures §1.1), as does the business
 *     continuity plan's weekly export;
 *   - C-611-13: Mux also receives the device's IP address and device type;
 *   - C-611-14: the owner's PostHog deadline leaves room for PostHog's
 *     asynchronous deletion inside the published 30 days;
 *   - C-611-15: RCW 19.373.010 wording ("process", not only "keep");
 *   - C-611-16: "kept while your account is open" yields to shorter periods;
 *   - RG-1: production has no Sign in with Apple key yet, so the policy does
 *     not claim deletion revokes Sign in with Apple; it states what is true.
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

function readRepo(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', ...parts), 'utf8');
}

const privacy = visibleText(trust.renderTrustPage('privacy'));
const health = visibleText(trust.renderTrustPage('consumer-health'));
const deleteHelp = visibleText(renderHelpPage('delete-account'));
const helpKeep = between(deleteHelp, 'What we keep, and for how long', 'How long it takes');
const privacyDeletion = between(privacy, 'Deleting your account', 'De-identified information');
const DOC = readRepo('docs', 'privacy', 'vendor-deletion-and-backups.md');
const RUNBOOK = readRepo('docs', 'deploy-runbook.md');
const BCP = readRepo('docs', 'soc2', 'policies', 'business-continuity-plan.md');

const CLOSED_ACCOUNT =
  'a closed-account record with no name, contact details or profile, holding only an internal account number, the account type and dates such as when the account was opened and closed';
const ONE_WAY_CODE =
  'a one-way code made from it, for 30 days, so the app can tell you the account was deleted if you sign in again; then the code is discarded';
const ANTHROPIC =
  'Anthropic deletes what it receives within 30 days, except where its usage policy or the law requires it to keep it longer.';
const DEIDENTIFIED =
  'After an account is deleted, de-identified, aggregated information that cannot identify the person may be kept. TGP takes reasonable measures so it cannot be linked to anyone, commits publicly to keep and use it only in de-identified form and never to try to re-identify it, and requires by contract anyone it shares it with to do the same.';
const KEPT_WHILE_OPEN =
  'Unless a shorter period is listed above, your information is kept while your account is open.';
const MUX_DEVICE =
  'When a video is uploaded or played, the device connects to Mux directly, so Mux also receives its IP address and device type.';
const APPLE_TODAY =
  'If you used Sign in with Apple, deleting your account ends the app’s link to your Apple ID. To remove the app from your Apple ID as well, on your iPhone open Settings, tap your name, then Sign-In & Security, then Sign in with Apple, choose the app and stop using it with your Apple ID.';
const HELP_PROVIDER_ID =
  'While removing your sign-in account at your sign-in provider is still being retried, that provider’s account ID is kept. Once it is removed, the account ID is replaced by ' +
  ONE_WAY_CODE +
  '.';
const HELP_VENDOR_WINDOWS =
  'Copies at service providers: error reports in Sentry are kept 90 days and email logs in Resend 30 days, and a deleted person is removed from PostHog product analytics within 30 days of the deletion.';

const NEW_SENTENCES = [
  KEPT_WHILE_OPEN,
  MUX_DEVICE,
  APPLE_TODAY,
  HELP_PROVIDER_ID,
  HELP_VENDOR_WINDOWS,
  `Closed account: ${CLOSED_ACCOUNT}, so the payment records and logs that must be kept still point to one closed account. It is kept with no end date.`,
  `What Anthropic received: ${ANTHROPIC}`,
  `De-identified information: ${DEIDENTIFIED}`,
  'Commits publicly to keep and use it only in de-identified form',
];

describe('#611 B-611-10: /help/delete-account keeps the same list as the Privacy Policy', () => {
  it('lists the closed-account record, the sign-in provider ID and the 30-day one-way code', () => {
    expect(privacyDeletion).toContain(CLOSED_ACCOUNT);
    expect(privacyDeletion).toContain(ONE_WAY_CODE);
    expect(helpKeep).toContain(`Closed account: ${CLOSED_ACCOUNT}`);
    expect(helpKeep).toContain(HELP_PROVIDER_ID);
  });

  it('lists Anthropic’s 30-day copy, de-identified information and the vendor windows', () => {
    expect(helpKeep).toContain(`What Anthropic received: ${ANTHROPIC}`);
    expect(helpKeep).toContain(`De-identified information: ${DEIDENTIFIED}`);
    expect(helpKeep).toContain(HELP_VENDOR_WINDOWS);
  });

  it('every item the Privacy Policy keeps has its counterpart on the help page', () => {
    const pairs: Array<[RegExp, RegExp]> = [
      [/payment records the law requires/, /Payment and tax records held by Stripe/],
      [/security and audit logs/i, /Security and audit logs/],
      [
        /one deletion record with a random reference/i,
        /One deletion record with a random reference/,
      ],
      [/closed-account record/, /Closed account: a closed-account record/],
      [/that provider’s account ID/, /that provider’s account ID is kept/],
      [/one-way code made from it, for 30 days/, /one-way code made from it, for 30 days/],
      [
        /Anthropic deletes what it receives within 30 days/,
        /Anthropic deletes what it receives within 30 days/,
      ],
      [/de-identified, aggregated information/, /de-identified, aggregated information/],
      [/Error reports in Sentry — 90 days/, /error reports in Sentry are kept 90 days/],
      [/Email logs in Resend — 30 days/, /email logs in Resend 30 days/],
      [
        /removed from PostHog within 30 days/,
        /removed from PostHog product analytics within 30 days/,
      ],
    ];
    for (const [onPrivacy, onHelp] of pairs) {
      expect(privacy).toMatch(onPrivacy);
      expect(helpKeep).toMatch(onHelp);
    }
  });

  it('the shared strings are exported once and used by both pages', () => {
    for (const name of [
      'CLOSED_ACCOUNT_RECORD_TEXT',
      'ONE_WAY_CODE_TEXT',
      'ANTHROPIC_RETENTION_TEXT',
      'DEIDENTIFIED_TEXT',
    ]) {
      const value: unknown = Reflect.get(trust, name);
      expect(typeof value).toBe('string');
      if (typeof value !== 'string') continue;
      expect(privacy).toContain(value);
      expect(deleteHelp).toContain(value);
    }
  });
});

describe('#611 B-611-11: the procedures that create database copies carry the published limits', () => {
  it('deploy runbook §2 step 3 states the §1.1 rules and drops "S3 bucket, etc."', () => {
    const step = between(RUNBOOK, '3. **Take a reference dump before any deploy', '4. **Deploy.**');
    expect(step).toMatch(/one owner-controlled location/);
    expect(step).toMatch(/named with (its|the) date/);
    expect(step).toMatch(/30 days after the deploy (it was taken for )?is verified/);
    expect(step).toMatch(/never (keep it|kept) (for )?more than 90 days/i);
    expect(step).toMatch(/monthly|first working day of each month/i);
    expect(step).toContain('privacy/vendor-deletion-and-backups.md');
    expect(step).not.toMatch(/S3\s+bucket,\s+etc/);
  });

  it('deploy runbook §3 step 1 points to the same limits', () => {
    const step = between(RUNBOOK, '1. **Backup before deploy**', '2. **Run the migration');
    expect(step).toMatch(/30 days/);
    expect(step).toMatch(/90 days/);
    expect(step).toContain('privacy/vendor-deletion-and-backups.md');
  });

  it('the business continuity plan weekly export follows §1.1, including old S3 versions', () => {
    const cadence = between(BCP, '### Manual backup cadence', '### Backup test cadence');
    expect(cadence).toContain('privacy/vendor-deletion-and-backups.md');
    expect(cadence).toMatch(/90 days/);
    expect(cadence).toMatch(/noncurrent/i);
  });

  it('procedures §1.1 no longer quotes the runbook’s open-ended storage line as current', () => {
    const dumps = between(DOC, '### 1.1 Our own database dumps', '### 1.2 Restores');
    expect(dumps).not.toMatch(/S3 bucket, etc/);
    expect(dumps).not.toMatch(/Nothing ages them out automatically/);
  });
});

describe('#611 C-611-13..16 and the Sign in with Apple ruling', () => {
  it('C-611-13: Mux also receives the device IP address and device type', () => {
    expect(privacy).toContain(
      `Mux — hosting and playback of the videos coaches upload. It receives the video files, with no name, email or account details attached. ${MUX_DEVICE}`,
    );
  });

  it('C-611-14: the owner removes a person from PostHog within 21 days, inside the published 30', () => {
    const row = DOC.split('\n').find((line) => line.startsWith('| PostHog (product analytics)'));
    expect(row).toBeDefined();
    expect(row).toMatch(/within 21 days of the deletion finalizing/);
    expect(privacy).toContain(
      'a deleted person is removed from PostHog within 30 days of the deletion.',
    );
  });

  it('C-611-15: both policies commit to process de-identified data only in de-identified form', () => {
    for (const text of [privacy, health]) {
      expect(text).toContain(DEIDENTIFIED);
      expect(text).not.toContain('commits publicly to keep it only in de-identified form');
    }
  });

  it('C-611-16: "kept while your account is open" yields to the shorter periods listed above it', () => {
    expect(privacy).toContain(
      `Deleting your account ${KEPT_WHILE_OPEN} Deletion can be started in the app or by email.`,
    );
    const retention = privacy.indexOf('How long we keep it');
    expect(retention).toBeGreaterThan(0);
    expect(retention).toBeLessThan(privacy.indexOf(KEPT_WHILE_OPEN));
  });

  it('RG-1: no claim that deletion revokes Sign in with Apple; the true path is stated', () => {
    for (const text of [privacy, health, deleteHelp]) {
      expect(text).not.toMatch(/revoke/i);
    }
    expect(privacyDeletion).toContain(APPLE_TODAY);
    expect(DOC).toMatch(/restores? the revocation sentence/);
  });

  it('the rest of the approved deletion paragraph is unchanged', () => {
    expect(privacyDeletion).toContain(
      'You can delete your account in the app: Settings, then Delete account. You confirm with your password or Sign in with Apple, and deletion is scheduled straight away with a 14-day grace period during which you can cancel. After that, your profile, consultation answers, logs, connected health data, Roman conversations, notifications and community memberships are permanently deleted, and the content of your community posts and messages is removed. ' +
        APPLE_TODAY +
        ' We keep only what we must: the payment records the law requires; security and audit logs; one deletion record with a random reference, the date and the result; and ' +
        CLOSED_ACCOUNT +
        ', so the records we must keep still point to one closed account. While removing your sign-in account at your sign-in provider is still being retried, we also keep that provider’s account ID. Once it is removed, we keep only ' +
        ONE_WAY_CODE +
        '.',
    );
  });

  it('the new sentences use no first person and no exclamation mark', () => {
    for (const s of NEW_SENTENCES) {
      expect(s).not.toMatch(/\b(we|us|our|ours|ourselves)\b/i);
      expect(s).not.toContain('!');
    }
  });
});
