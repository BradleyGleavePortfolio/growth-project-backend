import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

// r48 #9 — webview UA interstitial.
//
// Failure mode: a guest taps a coach's checkout link inside Instagram,
// Facebook, Twitter/X, TikTok, LinkedIn, Snapchat, Pinterest, or
// Discord.  These in-app browsers either block Apple Pay outright,
// strip Stripe.js cookies, or break the 3DS redirect.  The buyer
// either fails silently or gets stuck.
//
// Mitigation: detect known webview User-Agents on
//   /v1/packages/public/* (the entire guest-checkout surface)
// and return a tiny HTML interstitial with a "Open in Safari/Chrome"
// CTA.  The interstitial uses universal-link tricks (window.location =
// 'x-safari-...') plus copy-fallback so a buyer always has a path
// out.  GET requests are intercepted; POST requests pass through so
// AJAX from the storefront itself (called from the SSR page once the
// browser has switched) still works.

// Substring matches — case-insensitive.  Ordered by hit frequency
// from analytics (Instagram first because it's by far the noisiest
// webview source for affiliate-style links).
const WEBVIEW_UA_PATTERNS: ReadonlyArray<string> = [
  'Instagram',
  'FBAN',     // Facebook Audience Network
  'FBAV',     // Facebook App version
  'Twitter',
  'TikTok',
  'BytedanceWebview',
  'LinkedInApp',
  'Snapchat',
  'Pinterest',
  'DiscordBot',
  'Discord/', // Discord client UA
  'Line/',    // Line messenger
];

const INTERSTITIAL_PATH_PREFIX = '/v1/packages/public/';

function detectWebview(userAgent: string): string | null {
  if (!userAgent) return null;
  // Lowercase comparison so we don't miss a future client that
  // capitalises differently. We allocate one lowercased copy and
  // walk the constant pattern list — O(n*m) but n is tiny (~12).
  const lower = userAgent.toLowerCase();
  for (const pattern of WEBVIEW_UA_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

function renderInterstitial(url: string): string {
  // Tiny inline HTML — no external CSS so this renders even when the
  // webview blocks remote fonts/CSS.  The two buttons use universal
  // links on iOS (x-safari-https) and intent:// on Android, plus a
  // visible URL the buyer can copy-paste as a last resort.
  // R45: only branded domains (joingrowthproject.com / app.trygrowthproject.com).
  const safeUrl = url.replace(/[<>"'&]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;',
    };
    return map[c];
  });
  // Strip protocol for the iOS x-safari prefix.
  const noProtocol = url.replace(/^https?:\/\//, '');
  const safeNoProtocol = noProtocol.replace(/[<>"'&]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '&': '&amp;',
    };
    return map[c];
  });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Open in your browser</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { line-height: 1.5; }
  a.btn { display: block; text-align: center; background: #1a1a1a; color: #fff; padding: 14px 18px; border-radius: 10px; text-decoration: none; font-weight: 600; margin: 16px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #efefef; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
</style>
</head><body>
<h1>Finish in your browser</h1>
<p>This page can't process a secure payment inside this app. Open it in Safari or Chrome to continue.</p>
<a class="btn" href="x-safari-https://${safeNoProtocol}">Open in Safari (iOS)</a>
<a class="btn" href="intent://${safeNoProtocol}#Intent;scheme=https;package=com.android.chrome;end">Open in Chrome (Android)</a>
<p>If the buttons don't work, copy this link and paste it into your browser:</p>
<p><code>${safeUrl}</code></p>
</body></html>`;
}

@Injectable()
export class WebviewDetectMiddleware implements NestMiddleware {
  private readonly logger = new Logger(WebviewDetectMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Only short-circuit GET requests; the storefront's SSR layer
    // serves HTML, and AJAX POSTs that come AFTER the browser switch
    // must not be intercepted.
    if (req.method !== 'GET') {
      return next();
    }
    if (!req.path.startsWith(INTERSTITIAL_PATH_PREFIX)) {
      return next();
    }
    const ua = (req.headers['user-agent'] as string | undefined) ?? '';
    const matched = detectWebview(ua);
    if (!matched) {
      return next();
    }

    // Always render the user back to the same URL they're trying to
    // visit (so the universal link reopens them on the same checkout
    // page in their real browser).  Honor X-Forwarded-Proto so the
    // returned URL uses https when terminated at the proxy.
    const proto =
      ((req.headers['x-forwarded-proto'] as string | undefined) ?? 'https').split(
        ',',
      )[0].trim();
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      (req.headers['host'] as string | undefined) ??
      'joingrowthproject.com';
    const fullUrl = `${proto}://${host}${req.originalUrl}`;

    this.logger.debug(`webview detected (${matched}) on ${req.path}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Don't cache the interstitial — a buyer reopening in a real
    // browser should never see it again.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Webview-Detected', matched);
    res.status(200).send(renderInterstitial(fullUrl));
  }
}

// Exported so the test suite can exercise the pattern matcher without
// instantiating the middleware class.
export const __webviewDetectForTests = detectWebview;
