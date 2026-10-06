import { Injectable } from '@nestjs/common';
import { InviteCodesService } from '../invite-codes/invite-codes.service';

// Server-rendered HTML for the public invite landing page. Kept as a small
// service so the controller stays focused on transport (status codes, headers,
// `@Res()`) and the rendering surface is unit-testable without booting Nest.
//
// This template is the temporary in-backend landing for `/join/:code` and
// `/invite/:code`. Long-term it belongs in a dedicated marketing/web app
// (likely the same repo as tgp-coach-console or a stand-alone Next.js
// "tgp-web"), but co-locating it here lets the deep-link readiness lane ship
// without a second deploy target. See docs/invite-landing.md for the
// extraction plan.
@Injectable()
export class InviteLandingService {
  constructor(private inviteCodes: InviteCodesService) {}

  // Resolve a public-facing invite preview. Mirrors InviteCodesService.previewCode
  // exactly — the indirection exists so we can swap in a richer DTO (e.g. coach
  // headshot URL) without touching every caller.
  async preview(code: string) {
    return this.inviteCodes.previewCode(code);
  }

  // Render the success/landing HTML for a valid code. Quiet-luxury aesthetic:
  // serif headline, warm neutral palette, generous whitespace, no marketing
  // chrome. Inline CSS so the page renders instantly without a second hop.
  //
  // B-LINKS-123: a visitor only sees this page when the OS did NOT hand the
  // link to the app (app not installed, link opened inside another app's
  // browser, or typed into the address bar). So the main button must never
  // be the universal link itself: iOS keeps same-domain taps in Safari, so
  // that button only reloaded this page. There is also no web signup (the
  // old "Continue on web" target asked the visitor to open the invite on a
  // phone, which looped). The buttons are now chosen per platform:
  //   - iPhone:  Get the app (App Store), then "Open the app" (tgp://).
  //   - Android: Open the app through an intent:// link whose fallback is
  //              the Play Store, so one tap works with or without the app.
  //   - Other:   ask the visitor to open the invite on a phone, with both
  //              store links and the code to enter.
  renderValid(params: {
    code: string;
    coach_name: string;
    business_name: string | null;
    accent_color: string | null;
    logo_url: string | null;
    deep_link_url: string;
    app_store_url: string;
    play_store_url: string;
    android_package: string;
    platform: LandingPlatform;
  }): string {
    const accent = sanitizeColor(params.accent_color) || '#1F1B16';
    const businessLine = params.business_name
      ? `<p class="biz">${escapeHtml(params.business_name)}</p>`
      : '';
    const logo = params.logo_url
      ? `<img class="logo" src="${escapeAttr(params.logo_url)}" alt="" />`
      : '';
    const codeDisplay = escapeHtml(params.code);
    const appStore = escapeAttr(params.app_store_url);
    const playStore = escapeAttr(params.play_store_url);
    const openApp = escapeAttr(params.deep_link_url);

    let actions: string;
    if (params.platform === 'ios') {
      actions = `
    <a class="primary" href="${appStore}" rel="noopener">Get the app on the App Store</a>
    <p class="lead">After installing, open this invite link again, or enter code ${codeDisplay} when you create your account.</p>
    <div class="alt">
      <a href="${openApp}">Already have the app? Open it</a>
    </div>`;
    } else if (params.platform === 'android') {
      const intentUrl = buildAndroidIntentUrl(
        params.code,
        params.android_package,
        params.play_store_url,
      );
      actions = `
    <a class="primary" href="${escapeHtml(intentUrl)}">Open in The Growth Project</a>
    <p class="lead">Without the app, this opens Google Play. After installing, open this invite link again, or enter code ${codeDisplay} when you create your account.</p>
    <div class="stores">
      <a href="${playStore}" rel="noopener">Google Play</a>
    </div>`;
    } else {
      actions = `
    <p class="lead">Open this invite on your phone to join. Install The Growth Project, then enter code ${codeDisplay} when you create your account.</p>
    <div class="stores">
      <a href="${appStore}" rel="noopener">App Store</a>
      <a href="${playStore}" rel="noopener">Google Play</a>
    </div>`;
    }

    return baseDocument({
      title: `Coach invite — ${escapeHtml(params.coach_name)}`,
      accent,
      bodyClass: 'state-valid',
      body: `
  <main class="card">
    ${logo}
    <p class="kicker">You've been invited to</p>
    <h1>${escapeHtml(params.coach_name)}'s coaching</h1>
    ${businessLine}
    <p class="code"><span>code</span> ${codeDisplay}</p>
${actions}
  </main>
      `,
    });
  }

  // Render the not-found / revoked / paused / canceled error state. Same
  // visual language as `renderValid` but without any coach data — we do not
  // confirm the code's existence to a caller who has produced an unusable
  // value (defends against trivial enumeration that bypasses the JSON
  // throttler by going through the HTML route).
  renderInvalid(params: { web_signup_url: string }): string {
    return baseDocument({
      title: 'Invite unavailable',
      accent: '#1F1B16',
      bodyClass: 'state-invalid',
      body: `
  <main class="card">
    <p class="kicker">Invite link</p>
    <h1>This invite isn't available.</h1>
    <p class="lead">
      The link may have expired, been replaced, or your coach has paused new
      clients. Reach out to them for a fresh invite.
    </p>
    <div class="alt">
      <a href="${escapeAttr(params.web_signup_url)}">Continue without a code</a>
    </div>
  </main>
      `,
    });
  }
}

// ---- helpers ---------------------------------------------------------------

export type LandingPlatform = 'ios' | 'android' | 'other';

// Coarse platform from the User-Agent, used only to order the buttons. iPadOS
// in desktop mode reports a Mac UA and gets the "other" layout (both stores),
// which still works.
export function landingPlatformFromUserAgent(ua: string | undefined): LandingPlatform {
  const s = ua ?? '';
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  return 'other';
}

// Android intent link: opens the installed app on tgp://join/<code>, and
// when the app is missing the browser follows S.browser_fallback_url (the
// Play Store listing). The code was already validated by previewCode
// (letters, digits, dashes) and is URI-encoded again here.
export function buildAndroidIntentUrl(
  code: string,
  androidPackage: string,
  playStoreUrl: string,
): string {
  const fallback = /^https?:\/\//i.test(playStoreUrl.trim())
    ? `S.browser_fallback_url=${encodeURIComponent(playStoreUrl.trim())};`
    : '';
  const pkg = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(androidPackage.trim())
    ? androidPackage.trim()
    : 'com.growthproject.app';
  return `intent://join/${encodeURIComponent(code)}#Intent;scheme=tgp;package=${pkg};${fallback}end`;
}

// Strict allowlist for inline color values. We accept #RGB / #RRGGBB only —
// anything else is dropped to the default. This keeps a malicious or
// malformed `branding_accent_color` from breaking out of the style attribute.
function sanitizeColor(input: string | null): string | null {
  if (!input) return null;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input) ? input : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same as escapeHtml but tuned for attribute contexts. We additionally reject
// any URL whose scheme isn't http/https/tgp — so a malformed `logo_url` cannot
// inject `javascript:` or `data:` into an href/src.
function escapeAttr(s: string): string {
  const trimmed = (s || '').trim();
  const safeScheme = /^(?:https?:|tgp:|\/)/i.test(trimmed);
  const value = safeScheme ? trimmed : '#';
  return escapeHtml(value);
}

function baseDocument(opts: {
  title: string;
  accent: string;
  bodyClass: string;
  body: string;
}): string {
  // CSS palette mirrors quiet-luxury direction: warm off-white background,
  // ink-black serif for headlines, soft sans for body. Accent color drives
  // the primary CTA only — never large blocks — so a coach's brand color
  // can't make the page feel garish.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { --accent: ${opts.accent}; --ink: #1F1B16; --paper: #FAF7F2; --muted: #6B6259; --line: #E7E1D6; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--paper); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; }
  .card { width: 100%; max-width: 420px; background: #FFFFFF; border: 1px solid var(--line); border-radius: 18px; padding: 40px 28px; text-align: center; }
  .kicker { margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; color: var(--muted); }
  h1 { margin: 0 0 6px; font-family: "Playfair Display", "Iowan Old Style", Georgia, "Times New Roman", serif; font-weight: 500; font-size: 28px; line-height: 1.2; }
  .biz { margin: 0 0 20px; color: var(--muted); font-size: 15px; }
  .lead { margin: 8px 0 24px; color: var(--muted); font-size: 15px; }
  .code { margin: 24px auto; display: inline-flex; align-items: baseline; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; letter-spacing: 0.08em; }
  .code span { text-transform: uppercase; color: var(--muted); font-size: 10px; letter-spacing: 0.18em; }
  .logo { max-width: 56px; max-height: 56px; margin: 0 auto 16px; display: block; border-radius: 12px; }
  a { color: var(--ink); }
  .primary { display: inline-block; margin-top: 8px; padding: 14px 22px; background: var(--accent); color: #FFFFFF; border-radius: 999px; text-decoration: none; font-weight: 500; font-size: 15px; }
  .alt { margin-top: 22px; font-size: 13px; color: var(--muted); }
  .alt a { color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }
  .alt .dot { margin: 0 8px; }
  .stores { margin-top: 18px; display: flex; gap: 12px; justify-content: center; font-size: 12px; color: var(--muted); }
  .stores a { color: var(--muted); text-decoration: none; border: 1px solid var(--line); padding: 8px 14px; border-radius: 999px; }
</style>
</head>
<body class="${opts.bodyClass}">
${opts.body}
</body>
</html>`;
}
