import { Injectable } from '@nestjs/common';

// Server-rendered HTML for the durable "Get the app" interstitial pages
// served at /get-app, /get-app/ios, and /get-app/android. These exist so
// operators have a real, valid HTTPS URL to use for APP_STORE_URL /
// PLAY_STORE_URL during the window between deploy-ready backend and live
// store listings — without resorting to placeholder values that point at
// 404s, marketing landers we don't control, or `https://example.com`.
//
// Once real App Store / Play Store listings exist, the operator updates
// APP_STORE_URL / PLAY_STORE_URL to the canonical store URLs and these
// routes become a quiet "no longer the canonical entry point" fallback —
// still useful for QR codes printed before the switchover, never harmful.
//
// Visual language matches src/invite-landing/invite-landing.service.ts so
// the unauthenticated public surface looks coherent.

export type Platform = 'ios' | 'android' | 'unknown';

@Injectable()
export class GetAppService {
  // Render the platform-specific or generic interstitial. `webSignupUrl` is
  // surfaced so a visitor without a usable mobile platform (or who lands
  // here from a desktop browser) can still continue on web. `inviteCode`
  // is optional — when present, the "Continue on web" CTA carries the code
  // forward so the signup flow can attach the user to the right coach.
  render(params: {
    platform: Platform;
    webSignupUrl: string;
    inviteCode?: string | null;
  }): string {
    const { platform } = params;
    const webSignup = withInviteCode(params.webSignupUrl, params.inviteCode);
    const headline =
      platform === 'ios'
        ? 'The Growth Project for iPhone'
        : platform === 'android'
          ? 'The Growth Project for Android'
          : 'Get The Growth Project';
    const platformLine =
      platform === 'ios'
        ? 'iOS App Store listing'
        : platform === 'android'
          ? 'Google Play listing'
          : 'Mobile apps';
    const lead =
      platform === 'unknown'
        ? `Our iOS and Android apps are launching soon. In the meantime, you can continue setup in your browser — your account and any invite link you have will carry over to the app the moment it's available.`
        : `The ${platformLine} is being prepared. We'll send you here automatically once it's live. In the meantime, you can continue setup in your browser — your account will carry over to the app the moment it's available.`;

    return baseDocument({
      title: headline,
      bodyClass: `state-get-app state-${platform}`,
      body: `
  <main class="card">
    <p class="kicker">${escapeHtml(platformLine)}</p>
    <h1>${escapeHtml(headline)}</h1>
    <p class="lead">${escapeHtml(lead)}</p>
    <a class="primary" href="${escapeAttr(webSignup)}">Continue on web</a>
    <p class="note">No download required. Bookmark this page to come back when the app is live.</p>
  </main>
      `,
    });
  }
}

// ---- helpers ---------------------------------------------------------------

function withInviteCode(base: string, code: string | null | undefined): string {
  // We re-use the URL machinery from the invite-landing module's contract:
  // the web signup URL may already encode a code (`/signup?code=GP-...`).
  // Only append when we have a code AND the base does not already include
  // a `code=` query param. Defensive — never throw on a malformed URL.
  if (!code) return base;
  try {
    const u = new URL(base);
    if (!u.searchParams.has('code')) {
      u.searchParams.set('code', code);
    }
    return u.toString();
  } catch {
    return base;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same as escapeHtml but tuned for attribute contexts. Reject any URL whose
// scheme isn't http/https or relative `/` so a misconfigured
// PUBLIC_WEB_SIGNUP_URL cannot inject `javascript:` or `data:` into the
// rendered href.
function escapeAttr(s: string): string {
  const trimmed = (s || '').trim();
  const safeScheme = /^(?:https?:|\/)/i.test(trimmed);
  const value = safeScheme ? trimmed : '#';
  return escapeHtml(value);
}

function baseDocument(opts: {
  title: string;
  bodyClass: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { --ink: #1F1B16; --paper: #FAF7F2; --muted: #6B6259; --line: #E7E1D6; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; }
  .card { width: 100%; max-width: 460px; background: #FFFFFF; border: 1px solid var(--line); border-radius: 18px; padding: 40px 28px; text-align: center; }
  .kicker { margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; color: var(--muted); }
  h1 { margin: 0 0 12px; font-family: "Playfair Display", "Iowan Old Style", Georgia, "Times New Roman", serif; font-weight: 500; font-size: 28px; line-height: 1.2; }
  .lead { margin: 0 0 24px; color: var(--muted); font-size: 15px; }
  a { color: var(--ink); }
  .primary { display: inline-block; padding: 14px 22px; background: var(--ink); color: #FFFFFF; border-radius: 999px; text-decoration: none; font-weight: 500; font-size: 15px; }
  .note { margin: 18px 0 0; color: var(--muted); font-size: 12px; }
</style>
</head>
<body class="${opts.bodyClass}">
${opts.body}
</body>
</html>`;
}
