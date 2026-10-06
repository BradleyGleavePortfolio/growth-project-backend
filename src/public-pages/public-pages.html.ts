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
  <a class="cta" href="${ctaHref}">${ctaLabel}</a>${linksBlock}
  <footer>The Growth Project · ${policyFooterLinks()}</footer>
</main>
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
