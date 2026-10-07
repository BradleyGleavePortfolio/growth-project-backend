import { policyFooterLinks } from './trust-pages.html';

export type DownloadPlatform = 'ios' | 'android';

// Quiet-luxury, mobile-first HTML. Mirrors the aesthetic of the invite
// landing page (warm neutrals, serif headline, generous whitespace) so
// that a user bouncing between /join/:code and /download/* perceives a
// single product. Inline CSS keeps the page renderable in one round-trip
// and trivially edge-cacheable.
//
// Copy is deliberately honest: when the App Store / Play Store listings
// don't exist yet, the page says so and offers a support contact.
// We do NOT publish placeholder Apple/Google IDs that don't resolve —
// that's the failure mode the operator asked us to avoid.

// One support address for every public page (owner ruling 2026-10-01): the
// constant lives in trust-pages.html.ts. Imported here, in place of the old
// local constant, so the change does not collide with open edits to the
// top of this file.
import { SUPPORT_EMAIL } from './trust-pages.html';

// Invite codes follow `GP-XXXXXX`-style minting (see InviteCodesService) and
// are validated via ValidateInviteCodeDto at 3–32 chars. We mirror that here
// AND constrain the alphabet to `[A-Za-z0-9-]` so an arbitrary query string
// can never reflect into the rendered page or a mailto subject. Anything
// outside that shape is silently dropped — the page still renders, just
// without the code section, so a malformed link does not break the flow.
const INVITE_CODE_RE = /^[A-Za-z0-9-]{3,32}$/;

export function sanitizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return INVITE_CODE_RE.test(trimmed) ? trimmed : null;
}

interface PageContent {
  title: string;
  headline: string;
  body: string;
  cta_label: string;
  cta_href: string;
  invite_code?: string | null;
  /** Optional quieter links under the CTA (label + href, both escaped). */
  links?: ReadonlyArray<{ label: string; href: string }>;
  /**
   * Optional inline script. Server-owned constants only, never request
   * data (the trust-surface CSP is off, see main.ts helmet config).
   */
  script?: string;
  /** B-DIGEST-127: render the CTA as a same-origin POST form button instead of a link. */
  form_action?: string;
}

function pageFor(platform: DownloadPlatform): PageContent {
  if (platform === 'ios') {
    return {
      title: 'The Growth Project for iPhone',
      headline: 'Coming to the App Store',
      // F10 (C-2): the listing is not live yet and there is no notify list,
      // so the page says only that, with a plain support contact.
      body:
        'The iPhone app is not on the App Store yet. It can be downloaded ' +
        'there once the listing is live. For questions in the meantime, ' +
        'contact support.',
      cta_label: 'Contact support',
      cta_href: `mailto:${SUPPORT_EMAIL}?subject=iPhone%20app`,
    };
  }
  return {
    title: 'The Growth Project for Android',
    headline: 'Coming to Google Play',
    body:
      'The Android app is not on Google Play yet. It can be downloaded there ' +
      'once the listing is live. For questions in the meantime, contact ' +
      'support.',
    cta_label: 'Contact support',
    cta_href: `mailto:${SUPPORT_EMAIL}?subject=Android%20app`,
  };
}

export function renderDownloadPage(platform: DownloadPlatform): string {
  return baseDocument(pageFor(platform));
}

/**
 * S-DUNNING-R2 (OR-110-2) — landing for the https link in dunning emails
 * (https://app.trygrowthproject.com/billing/update-card). On a phone with the
 * app installed the OS opens the app's card screen directly (universal link /
 * App Link) and this page never shows. Anywhere else it calmly asks the
 * client to open the app, where the card is updated natively. No account
 * data is rendered: the page is public and identical for everyone.
 */
export function renderBillingUpdateCardPage(): string {
  return baseDocument({
    title: 'The Growth Project — Update your card',
    headline: 'Update your card in the app',
    body:
      'Card updates happen inside The Growth Project app, so card details ' +
      'stay with the payment provider and never pass through a web page. ' +
      'Open the app on your phone and it takes you straight to the card ' +
      'screen. After the new card is saved, the app tries the amount owed ' +
      'on it; once that payment goes through, access continues, or comes ' +
      'back if it was paused.',
    cta_label: 'Open the app',
    cta_href: 'tgp://billing/update-card',
    links: [
      { label: 'Get the iPhone app', href: '/download/ios' },
      { label: 'Get the Android app', href: '/download/android' },
      {
        label: `Need help? Email ${SUPPORT_EMAIL}`,
        href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Updating my card')}`,
      },
    ],
  });
}

/**
 * HUNT-01-124 — landing for the sign-up confirmation email when it is opened
 * somewhere the app's `tgp://verified` return cannot open (a computer, or a
 * phone without the app), once the owner points SUPABASE_REDIRECT_URL / the
 * Supabase Site URL here. Supabase confirms the address before redirecting
 * and appends either the new session (`#access_token=...`) or an error
 * (`#error=access_denied&error_code=otp_expired...`) to this URL. The
 * fragment never reaches the server, so the page is static; the inline
 * script (a) switches to the expired-link copy when the fragment or query
 * carries an error and (b) removes the fragment from the address bar so
 * session tokens are not left visible or copied. Nothing is stored or sent.
 */
export const EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE = 'This link has expired or was already used';
export const EMAIL_CONFIRMED_LINK_PROBLEM_BODY =
  'If the email address is already confirmed, open The Growth Project app and ' +
  'sign in. If sign-in still asks for confirmation, contact support for a new link.';
export const EMAIL_CONFIRMED_SCRIPT = [
  '(function () {',
  "  var loc = window.location;",
  "  var raw = (loc.hash || '').replace(/^#/, '') + '&' + (loc.search || '').replace(/^\\?/, '');",
  "  var failed = /(^|&)(error|error_code)=/.test(raw);",
  "  if ((loc.hash || loc.search) && window.history && window.history.replaceState) {",
  "    window.history.replaceState(null, '', loc.pathname);",
  '  }',
  '  if (!failed) return;',
  "  var h = document.querySelector('h1');",
  "  var p = document.querySelector('main > p');",
  "  var a = document.querySelector('a.cta');",
  `  if (h) h.textContent = ${JSON.stringify(EMAIL_CONFIRMED_LINK_PROBLEM_HEADLINE)};`,
  `  if (p) p.textContent = ${JSON.stringify(EMAIL_CONFIRMED_LINK_PROBLEM_BODY)};`,
  "  if (a) a.setAttribute('href', 'tgp://verified?error=link_problem');",
  '})();',
].join('\n');

export function renderEmailConfirmedPage(): string {
  return baseDocument({
    title: 'The Growth Project — Email confirmed',
    headline: 'Email confirmed',
    body:
      'Open The Growth Project app on your phone and sign in with the email ' +
      'address and password used at sign-up. There is no need to open this ' +
      'link again.',
    cta_label: 'Open the app',
    cta_href: 'tgp://verified',
    links: [
      { label: 'Get the iPhone app', href: '/download/ios' },
      { label: 'Get the Android app', href: '/download/android' },
      {
        label: `Need help? Email ${SUPPORT_EMAIL}`,
        href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Confirming my email')}`,
      },
    ],
    script: EMAIL_CONFIRMED_SCRIPT,
  });
}

const APP_LINKS = (subject: string): ReadonlyArray<{ label: string; href: string }> => [
  { label: 'Get the iPhone app', href: '/download/ios' },
  { label: 'Get the Android app', href: '/download/android' },
  {
    label: `Need help? Email ${SUPPORT_EMAIL}`,
    href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`,
  },
];

/**
 * B-DIGEST-127 — target of the "Open the app" button in every digest email
 * (https://app.trygrowthproject.com/open). Static and identical for everyone.
 */
export function renderOpenAppPage(): string {
  return baseDocument({
    title: 'The Growth Project — Open the app',
    headline: 'Open The Growth Project',
    body:
      'Summaries, check-ins, messages and training all live in The Growth ' +
      'Project app. Open it on your phone to see the details.',
    cta_label: 'Open the app',
    cta_href: 'tgp://',
    links: APP_LINKS('Opening the app'),
  });
}

export type DigestUnsubscribeState = 'confirm' | 'done' | 'expired' | 'invalid';

/**
 * B-DIGEST-127 — the one-click unsubscribe page for summary emails. 'confirm'
 * (GET with a valid token) shows a button that POSTs back to the same URL, so
 * a mail scanner that only follows links turns nothing off; 'done' follows the
 * POST. No account data is rendered.
 */
export function renderDigestUnsubscribePage(
  state: DigestUnsubscribeState,
  formAction?: string,
): string {
  const title = 'The Growth Project — Summary emails';
  if (state === 'confirm' && formAction) {
    return baseDocument({
      title,
      headline: 'Turn off summary emails',
      body:
        'Daily and weekly summary emails stop for this account. In-app ' +
        'notifications, receipts and account emails are not affected.',
      cta_label: 'Turn off summary emails',
      cta_href: formAction,
      form_action: formAction,
    });
  }
  if (state === 'done') {
    return baseDocument({
      title,
      headline: 'Summary emails are off',
      body:
        'Daily and weekly summary emails are now off for this account. ' +
        'Receipts and account emails still arrive as usual.',
      cta_label: 'Open the app',
      cta_href: 'tgp://',
      links: APP_LINKS('Summary emails'),
    });
  }
  return baseDocument({
    title,
    headline:
      state === 'expired' ? 'This link has expired' : 'This link does not work',
    body:
      'Use the unsubscribe link in the most recent summary email, or contact ' +
      'support to turn summary emails off.',
    cta_label: 'Contact support',
    cta_href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Turn off summary emails')}`,
  });
}

export function renderSignupPage(inviteCode?: string | null): string {
  const code = sanitizeInviteCode(inviteCode);
  if (code) {
    // When the user arrives with a recognised invite code, the page's job
    // changes: confirm we received the code, ask them to open it on their
    // phone (where the universal link hands off to the app), and keep the
    // mailto fallback so they can still reach a human if anything goes
    // wrong. The code is rendered into the page so the user can verify it
    // matches what their coach sent — and the mailto subject carries it so
    // a support reply can pick up the thread without the user re-typing.
    return baseDocument({
      title: 'The Growth Project — Sign up',
      headline: 'Your invite is ready',
      // F10 (C-1): no first person and no promise of a manual setup step;
      // the code is entered in the app, support is the fallback.
      body:
        'Open The Growth Project app on your phone and enter the invite code ' +
        'below during setup to connect with your coach. If your coach shared ' +
        'a link, open it on your phone to launch the app. For help with ' +
        'setup, contact support and include the code.',
      cta_label: 'Contact support',
      cta_href: `mailto:${SUPPORT_EMAIL}` + `?subject=${encodeURIComponent('Invite ' + code)}`,
      invite_code: code,
    });
  }
  return baseDocument({
    title: 'The Growth Project — Sign up',
    // Signup is open (owner decision; B-STORECOPY-2): no invite code is
    // needed. A coach's invite code only connects the new client to them.
    headline: 'Create an account',
    body:
      'Open The Growth Project app to create a client or coach account. ' +
      'If a coach shared an invite code, enter it during setup to connect ' +
      'with them. No invite code is needed to create an account. For help ' +
      'with setup, contact support.',
    cta_label: 'Contact support',
    cta_href: `mailto:${SUPPORT_EMAIL}?subject=Signup%20help`,
  });
}

// Keep the markup, CSS, and copy escaping in one place so future tweaks
// (e.g. adding a logo, swapping the accent color) touch a single file.
function baseDocument(p: PageContent): string {
  const title = escapeHtml(p.title);
  const headline = escapeHtml(p.headline);
  const body = escapeHtml(p.body);
  const ctaLabel = escapeHtml(p.cta_label);
  const ctaHref = escapeAttr(p.cta_href);
  // Only render the invite-code block when the controller has handed us a
  // code that already passed sanitizeInviteCode — but escape again here
  // anyway, defence in depth costs nothing.
  const codeBlock = p.invite_code
    ? `\n  <p class="code-label">Your invite code</p>\n  <p class="code">${escapeHtml(p.invite_code)}</p>`
    : '';
  const links = (p.links ?? [])
    .map((l) => `\n    <li><a href="${escapeAttr(l.href)}">${escapeHtml(l.label)}</a></li>`)
    .join('');
  const linksBlock = links ? `\n  <ul class="links">${links}\n  </ul>` : '';
  const cta = p.form_action
    ? `<form method="post" action="${escapeAttr(p.form_action)}"><button class="cta" type="submit">${ctaLabel}</button></form>`
    : `<a class="cta" href="${ctaHref}">${ctaLabel}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #FBF8F3; color: #1F1B16; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px 20px; }
  main { max-width: 480px; width: 100%; text-align: left; }
  h1 { font-family: "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 36px; line-height: 1.15; letter-spacing: -0.01em; margin: 0 0 18px 0; }
  p { font-size: 17px; line-height: 1.55; margin: 0 0 28px 0; color: #3A332B; }
  p.code-label { margin: 0 0 6px 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #8A7F6E; }
  p.code { margin: 0 0 28px 0; font-family: "SF Mono", "Menlo", ui-monospace, monospace; font-size: 17px; color: #1F1B16; user-select: all; }
  a.cta { display: inline-block; padding: 14px 22px; border-radius: 999px; background: #1F1B16; color: #FBF8F3; text-decoration: none; font-weight: 500; font-size: 15px; }
  a.cta:hover { background: #3A332B; }
  button.cta { display: inline-block; padding: 14px 22px; border: 0; border-radius: 999px; background: #1F1B16; color: #FBF8F3; font: inherit; font-weight: 500; font-size: 15px; cursor: pointer; }
  ul.links { list-style: none; padding: 0; margin: 28px 0 0 0; }
  ul.links li { margin: 0 0 10px 0; font-size: 15px; }
  ul.links a { color: #3A332B; }
  footer { margin-top: 40px; font-size: 13px; color: #8A7F6E; }
  footer a { color: #8A7F6E; text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>${headline}</h1>
  <p>${body}</p>${codeBlock}
  ${cta}${linksBlock}
  <footer>The Growth Project · ${policyFooterLinks()}</footer>
</main>${p.script ? `\n<script>\n${p.script}\n</script>` : ''}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
