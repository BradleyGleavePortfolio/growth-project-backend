export type DownloadPlatform = 'ios' | 'android';

// Quiet-luxury, mobile-first HTML. Mirrors the aesthetic of the invite
// landing page (warm neutrals, serif headline, generous whitespace) so
// that a user bouncing between /join/:code and /download/* perceives a
// single product. Inline CSS keeps the page renderable in one round-trip
// and trivially edge-cacheable.
//
// Copy is deliberately honest: when the App Store / Play Store listings
// don't exist yet, we say so and offer the user a way to be notified.
// We do NOT publish placeholder Apple/Google IDs that don't resolve —
// that's the failure mode the operator asked us to avoid.

const SUPPORT_EMAIL = 'hello@trygrowthproject.com';

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
}

function pageFor(platform: DownloadPlatform): PageContent {
  if (platform === 'ios') {
    return {
      title: 'The Growth Project for iPhone',
      headline: 'Coming to the App Store',
      body:
        'The iPhone app is in private review. If your coach has invited you, ' +
        'they will share the App Store link as soon as it is live. In the ' +
        'meantime, leave us your email and we will notify you the moment it ' +
        'is available.',
      cta_label: 'Email us',
      cta_href: `mailto:${SUPPORT_EMAIL}?subject=Notify%20me%20when%20iOS%20is%20live`,
    };
  }
  return {
    title: 'The Growth Project for Android',
    headline: 'Coming to Google Play',
    body:
      'The Android app is in private review. If your coach has invited you, ' +
      'they will share the Play Store link as soon as it is live. In the ' +
      'meantime, leave us your email and we will notify you the moment it ' +
      'is available.',
    cta_label: 'Email us',
    cta_href: `mailto:${SUPPORT_EMAIL}?subject=Notify%20me%20when%20Android%20is%20live`,
  };
}

export function renderDownloadPage(platform: DownloadPlatform): string {
  return baseDocument(pageFor(platform));
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
      body:
        'Open this page on your phone to continue. If your coach has ' +
        'already shared a link, tap it from your phone to launch the app. ' +
        'If you run into trouble, email us with the code below and we will ' +
        'help you finish setup.',
      cta_label: 'Email us',
      cta_href:
        `mailto:${SUPPORT_EMAIL}` +
        `?subject=${encodeURIComponent('Invite ' + code)}`,
      invite_code: code,
    });
  }
  return baseDocument({
    title: 'The Growth Project — Sign up',
    headline: 'Sign up by invite',
    body:
      'The Growth Project is currently invite-only. If your coach has ' +
      'shared an invite link with you, open it on your phone to start. ' +
      'If you do not have an invite yet, reach out to your coach or ' +
      'email us and we will connect you with one.',
    cta_label: 'Email us',
    cta_href: `mailto:${SUPPORT_EMAIL}?subject=Request%20an%20invite`,
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
  footer { margin-top: 40px; font-size: 13px; color: #8A7F6E; }
</style>
</head>
<body>
<main>
  <h1>${headline}</h1>
  <p>${body}</p>${codeBlock}
  <a class="cta" href="${ctaHref}">${ctaLabel}</a>
  <footer>The Growth Project</footer>
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
