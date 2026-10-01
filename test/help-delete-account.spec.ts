// Public account-deletion page (/help/delete-account), required by Google
// Play: a web URL where anyone can ask for account and data deletion without
// installing the app. These tests pin that the page is public (no login),
// is linked from the Privacy Policy, /help and the shared footer, and states
// only facts taken from code or the published policies:
//  - in-app path and confirmation steps: growth-project-mobile #313
//    (src/screens/client/SettingsScreen.tsx "Data & Privacy" > "Delete my
//    account"; src/screens/coach/settings/DangerZone.tsx "Privacy & Data" >
//    "Delete my account"; src/screens/settings/DeleteAccountScreen.tsx
//    "Type DELETE or <email>", password / Apple / Google re-auth,
//    "Keep my account", PERMANENTLY_DELETED, KEPT_RECORDS, BILLING_NOTE);
//  - 14-day grace, finalization within one day, no grace on an admin
//    deletion: backend #608 src/account-deletion/account-deletion.service.ts
//    (graceDays default 14, FINALIZE_WINDOW_MS, adminForceDelete);
//  - 30-day reply, 45 days for consumer health data, Roman 180 days, backups
//    six months: src/public-pages/trust-pages.html.ts.
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Response } from 'express';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import {
  DELETION_EMAIL_SUBJECT,
  PLAY_APP_NAME,
  PLAY_DEVELOPER_NAME,
  renderHelpPage,
  type HelpPage,
} from '../src/public-pages/help-pages.html';
import {
  ACCOUNT_DELETION_EMAIL,
  DELETE_ACCOUNT_HELP_PATH,
  policyFooterLinks,
  renderTrustPage,
  type TrustPage,
} from '../src/public-pages/trust-pages.html';
import { renderDownloadPage, renderSignupPage } from '../src/public-pages/public-pages.html';

interface FakeResState {
  headers: Record<string, string>;
  statusCode: number;
  body: string;
}

// Minimal express Response double, typed without casts.
function makeRes(): { res: Response; state: FakeResState } {
  const state: FakeResState = { headers: {}, statusCode: 0, body: '' };
  const res: Response = Object.assign(Object.create(null), {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k] = v;
      return res;
    },
    send(payload: string) {
      state.body = payload;
      return res;
    },
  });
  return { res, state };
}

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

const ALL_HELP_PAGES: HelpPage[] = [
  'index',
  'setup',
  'first-client',
  'tour',
  'faq',
  'support',
  'contact',
  'delete-account',
];
const ALL_TRUST_PAGES: TrustPage[] = ['privacy', 'consumer-health', 'terms', 'security', 'status'];
const LINK = `href="${DELETE_ACCOUNT_HELP_PATH}"`;

describe('/help/delete-account route', () => {
  it('is served as a 200 HTML page without login', () => {
    const controller = new PublicPagesController();
    const { res, state } = makeRes();
    controller.helpDeleteAccount(res);
    expect(state.statusCode).toBe(200);
    expect(state.headers['Content-Type']).toMatch(/text\/html/);
    expect(state.headers['Cache-Control']).toBe('public, max-age=300');
    expect(state.body).toContain('Delete your account');
    const handler = PublicPagesController.prototype.helpDeleteAccount;
    // @Public(): the global JwtAuthGuard skips token checks for this route.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('help/delete-account');
    expect(DELETE_ACCOUNT_HELP_PATH).toBe('/help/delete-account');
  });

  it('is excluded from the /api global prefix in main.ts', () => {
    const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toContain("'help/delete-account',");
  });
});

describe('/help/delete-account is linked', () => {
  it('from the Privacy Policy "Deleting your account" section', () => {
    const html = renderTrustPage('privacy');
    const section = html.slice(html.indexOf('<h2>Deleting your account</h2>'));
    expect(section.slice(0, section.indexOf('</section>'))).toContain(LINK);
  });

  it('from the /help overview body and the nav of every help page', () => {
    const index = renderHelpPage('index');
    const body = index.slice(index.indexOf('<h2>Your account</h2>'));
    expect(body.slice(0, body.indexOf('</section>'))).toContain(LINK);
    for (const page of ALL_HELP_PAGES) {
      const nav = renderHelpPage(page).match(/<nav class="help-nav">([\s\S]*?)<\/nav>/);
      expect(nav?.[1]).toContain(LINK);
    }
  });

  it('from the shared footer on every trust, help, download and signup page', () => {
    expect(policyFooterLinks()).toContain(`${LINK}>Delete your account</a>`);
    const pages = [
      ...ALL_TRUST_PAGES.map((p) => renderTrustPage(p)),
      ...ALL_HELP_PAGES.map((p) => renderHelpPage(p)),
      renderDownloadPage('ios'),
      renderDownloadPage('android'),
      renderSignupPage(null),
    ];
    for (const html of pages) {
      const footer = html.slice(html.lastIndexOf('<footer'));
      expect(footer).toContain(LINK);
    }
  });
});

describe('/help/delete-account content', () => {
  const html = renderHelpPage('delete-account');
  const text = visibleText(html);

  it('names the app and the developer as on the Google Play listing', () => {
    expect(PLAY_APP_NAME).toBe('TGP Fitness');
    expect(PLAY_DEVELOPER_NAME).toBe('The Growth Project');
    expect(text).toContain('How to delete your TGP Fitness account');
    expect(text).toContain('TGP Fitness is made by The Growth Project.');
    expect(html).toContain('<title>Delete your TGP Fitness account — The Growth Project</title>');
  });

  it('gives the exact in-app path from mobile #313 for clients and coaches', () => {
    expect(text).toContain(
      'If you are a client: open the profile tab (the person icon in the bottom bar), tap Settings, then under Data & Privacy tap Delete my account.',
    );
    expect(text).toContain(
      'If you are a coach: open the Settings tab, then under Privacy & Data tap Delete my account.',
    );
    expect(text).toContain(
      'type DELETE or your account email, then confirm it is you with your password, Sign in with Apple or Google',
    );
    expect(text).toContain('tap Keep my account to cancel it.');
  });

  it('gives a working email route with a subject line and identity check, never a password', () => {
    expect(ACCOUNT_DELETION_EMAIL).toBe('Bradleyapple1031@gmail.com');
    expect(DELETION_EMAIL_SUBJECT).toBe('Delete my account');
    expect(text).toContain(
      'Email Bradleyapple1031@gmail.com with the subject line “Delete my account”.',
    );
    expect(html).toContain(
      'href="mailto:Bradleyapple1031@gmail.com?subject=Delete%20my%20account"',
    );
    expect(text).toContain('Send it from the email address you use to sign in to the app.');
    expect(text).toContain(
      'Include the name on the account and say whether you are a client or a coach.',
    );
    expect(text).toContain('delete nothing until you reply from it to confirm');
    expect(text).toContain('We will never ask for your password, a card number or a sign-in code.');
    // Never asks for a password, card or code anywhere else on the page.
    expect(text).not.toMatch(/(send|include|tell us) (us )?your password/i);
  });

  it('lists what is deleted, matching #313 PERMANENTLY_DELETED and #608 tombstoning', () => {
    for (const item of [
      'Your sign-in account, name, email address and phone number',
      'Your profile, body measurements and consultation answers',
      'Food, water, fasting, weight and workout logs, check-ins and habits',
      'Health and activity data synced from Apple Health or connected devices, and bloodwork you entered, including uploaded files',
      'Your conversations with Roman, the AI assistant',
      'Your messages, community posts, comments, direct messages, voice notes and reactions',
      'Coach media, notes and briefs, if you coach',
      'Your targets, recipes, lists and preferences',
      'Notification settings and push notification tokens',
    ]) {
      expect(text).toContain(item);
    }
    expect(text).toContain(
      'Any subscription or payment plan you have, as a client or as a coach, is cancelled when the deletion completes',
    );
  });

  it('lists what is kept and for how long, matching #313 KEPT_RECORDS and the policies', () => {
    expect(text).toContain(
      'Payment and tax records held by Stripe, our payment processor, for as long as the law requires. Our own copies keep only amounts, dates and payment references, with no name or contact details.',
    );
    expect(text).toContain(
      'One deletion record with a random reference, the date and the result. It holds no name, email or account details.',
    );
    expect(text).toContain('If you coach: your clients are not deleted.');
    expect(text).toContain(
      'no copy is kept more than six months after a confirmed deletion request',
    );
    // Same six-month backup limit the Privacy Policy publishes.
    expect(visibleText(renderTrustPage('privacy'))).toContain(
      'never kept beyond six months after a confirmed deletion request',
    );
  });

  it('states the timings: 14-day grace, one day to finish, 30-day reply, Roman 180 days', () => {
    expect(text).toContain(
      'In the app: a 14-day grace period starts when you confirm. When it ends, your data is deleted within one day, and the app shows the date.',
    );
    expect(text).toContain('By email: we reply within 30 days of receiving your request.');
    expect(text).toContain('answered within 45 days');
    expect(text).toContain('each message is deleted automatically 180 days after it is sent');
    expect(text).toContain(
      'There is no 14-day grace period for a deletion we carry out at your request, so it cannot be cancelled.',
    );
    // The commitments come from the published policies.
    expect(visibleText(renderTrustPage('privacy'))).toContain('we respond within 30 days');
    expect(visibleText(renderTrustPage('privacy'))).toContain('14-day grace period');
    expect(visibleText(renderTrustPage('consumer-health'))).toContain(
      'within 45 days of receiving your request',
    );
  });

  it('follows the copy rules: no exclamation marks, emoji, placeholders or clinic partner', () => {
    expect(text).not.toContain('!');
    expect(text).not.toMatch(
      /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}]/u,
    );
    // Placeholder / unfinished-copy checks run for this page in
    // test/help-pages.spec.ts (ALL_PAGES includes 'delete-account').
    expect(html).not.toMatch(/\$\{[A-Z_]+\}/);
    expect(text).not.toMatch(/clinic/i);
    expect(text).not.toMatch(/something went wrong|please try again/i);
  });
});
