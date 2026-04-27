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

interface PageContent {
  title: string;
  headline: string;
  body: string;
  cta_label: string;
  cta_href: string;
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

export function renderSignupPage(): string {
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
  a.cta { display: inline-block; padding: 14px 22px; border-radius: 999px; background: #1F1B16; color: #FBF8F3; text-decoration: none; font-weight: 500; font-size: 15px; }
  a.cta:hover { background: #3A332B; }
  footer { margin-top: 40px; font-size: 13px; color: #8A7F6E; }
</style>
</head>
<body>
<main>
  <h1>${headline}</h1>
  <p>${body}</p>
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
