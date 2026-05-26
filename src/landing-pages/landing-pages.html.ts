/**
 * Server-side HTML renderer for coach landing pages — v2 (PR-LP-RENDERER-V2).
 *
 * Brand: SaaS platform (NOT the founder courses brand). Tokens pulled from
 * the `tgp-platform-site` system: near-black dark surface, warm gold accent
 * (#d4a574), Geist Sans body + Fraunces display.  Register matches Linear /
 * Attio / Mercury / Stripe: calm, confident, premium B2B.  No emoji, no
 * exclamation marks, no countdown timers.  Spacing > decoration.
 *
 * Persuasion arc (7 sections, per the design doctrine §4):
 *   1. Hero               — single-promise headline, one CTA, social-proof line
 *   2. Problem ↔ Solution — split "what's broken / what changes"
 *   3. Outcome proof      — testimonial grid (no carousels)
 *   4. Mechanism          — 3-step how-it-works with iconography
 *   5. Trust              — credentials, press, numeric proof
 *   6. CTA + lead form    — cream-inverted section to pull the eye
 *   7. FAQ                — accordion (details/summary, zero JS)
 *
 * Backwards compat: the four legacy section kinds shipped in Phase 1/2
 * (before_after, pricing, offer_stack, guarantee) continue to render under
 * the new token system so existing published pages do not break.
 *
 * Entrance motion: a single inline IntersectionObserver script (~600 bytes
 * gzipped) toggles `.in-view` on sections as they cross the viewport. CSS
 * handles the rest. `prefers-reduced-motion: reduce` disables transforms.
 *
 * Post-submit celebration: the lead-form replaces itself with an inline
 * thank-you card on a successful fetch().  CSS-only confetti (no canvas, no
 * library) — three small <span> motes drift up the card border.
 *
 * Security:
 *   - JSON-LD inside <script type="application/ld+json"> is escaped against
 *     </script> breakout via `safeJsonLd` (carried over from v1).
 *   - Hero image goes through an <img> element, never CSS background-image
 *     (avoids the apostrophe-decode CSS-string injection path).
 *   - Every coach-supplied string runs through `esc` / `escAttr`.
 *   - `escAttr` substitutes '#' for any non-http(s) / non-relative URL,
 *     blocking `javascript:` and `data:` URLs in attribute context.
 */

import type { CoachLandingPage, CoachLandingPageSection, CoachPackage } from '@prisma/client';

export type CoachProfile = {
  business_name: string | null;
  bio: string | null;
  branding_accent_color: string | null;
  branding_logo_url: string | null;
  invite_code: string;
};

export type PageWithContext = CoachLandingPage & {
  sections: CoachLandingPageSection[];
  coach: {
    id: string;
    name: string;
    coach_practice_type: string | null;
    coach_profile: CoachProfile | null;
  };
};

// ─── HTML / JSON helpers ─────────────────────────────────────────────────────

/**
 * JSON.stringify is not safe to inline in a <script> tag — a value like
 * `</script><img onerror=…>` would terminate the script and inject HTML.
 * Escape angle brackets + ampersand + line-separator code points.
 */
function safeJsonLd(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s) / relative URLs only.  Anything else → '#'.  Blocks js:/data:. */
function escAttr(s: string | null | undefined): string {
  const v = (s || '').trim();
  if (!v) return '#';
  const safe = /^(?:https?:|\/)/i.test(v);
  return safe ? esc(v) : '#';
}

function nl2br(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

/** Convert bold/italic markdown to safe HTML.  No arbitrary HTML pass-through. */
function markdownLight(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// ─── Accent picker ───────────────────────────────────────────────────────────

/**
 * Four named accents the coach can pick.  The DB stores a free-form
 * `accent_color` hex (legacy from Phase 1) — we resolve it to the closest
 * preset.  Any unrecognised value falls through to the gold default.
 */
interface AccentTriplet {
  base: string;     // primary swatch
  hover: string;    // hover-state lift
  contrast: string; // text colour on base
}

const ACCENTS: Record<'gold' | 'sage' | 'terracotta' | 'slate', AccentTriplet> = {
  gold:       { base: '#d4a574', hover: '#e0b585', contrast: '#1a1410' },
  sage:       { base: '#5d7d65', hover: '#6e9077', contrast: '#0f1a12' },
  terracotta: { base: '#c87a5d', hover: '#d68a6e', contrast: '#1a0f0a' },
  slate:      { base: '#4a5870', hover: '#5a6a85', contrast: '#0e1117' },
};

function resolveAccent(input: string | null | undefined): AccentTriplet {
  const raw = (input || '').trim().toLowerCase();
  // Exact-name hits first (a future migration may swap the column to an enum
  // with name strings; the renderer already supports it).
  if (raw in ACCENTS) return ACCENTS[raw as keyof typeof ACCENTS];
  // Hex equality / proximity — exact match wins, otherwise default.
  for (const triplet of Object.values(ACCENTS)) {
    if (triplet.base.toLowerCase() === raw) return triplet;
  }
  return ACCENTS.gold;
}

// ─── Critical CSS (inlined; gzipped ~6kb) ────────────────────────────────────
//
// Token system mirrors the SaaS platform site — dark default, warm gold
// accent, Geist Sans + Fraunces.  All measurements are clamps so the page
// breathes on small screens without media queries everywhere.

function brandCss(accent: AccentTriplet): string {
  return `
:root {
  --bg: #0b0b0c;
  --surface: #131316;
  --surface-2: #1a1a1f;
  --ink: #f3f3f3;
  --ink-2: #b8b8bb;
  --ink-3: #6e6e72;
  --accent: ${accent.base};
  --accent-hover: ${accent.hover};
  --accent-ink: ${accent.contrast};
  --cream: #f5efe6;
  --cream-ink: #1a1410;
  --border: rgba(255, 255, 255, 0.08);
  --success: #5fb574;
  --error: #d97757;
  --radius: 14px;
  --max-w: 1080px;
  --measure: 640px;

  /* Type scale (modular ratio ~1.25, anchored at 16px body) */
  --t-12: 12px;
  --t-14: 14px;
  --t-16: 16px;
  --t-18: 18px;
  --t-24: 24px;
  --t-32: 32px;
  --t-48: 48px;
  --t-72: 72px;
  --t-hero: clamp(3rem, 6vw, 5.5rem);

  /* Display + body fonts. Geist Sans is the body/UI face; Fraunces is the
     display face used for hero H1 and section H2 only.  Both are loaded
     via system fallbacks first so the page draws instantly on a cold
     visitor without a font-network round trip. */
  --font-display: 'Fraunces', 'Iowan Old Style', Georgia, 'Times New Roman', serif;
  --font-body: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
}

*, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; background: var(--bg); }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: var(--t-18);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: 'ss01', 'cv01', 'cv11';
}

h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 500;
  line-height: 1.05;
  letter-spacing: -0.02em;
  font-variation-settings: 'opsz' 144, 'WONK' 30, 'SOFT' 30;
}
h4 { font-family: var(--font-body); font-weight: 600; }

img { max-width: 100%; display: block; }
a { color: var(--ink); text-decoration: none; }
a:hover { color: var(--accent); }

/* Layout primitives */
.lp-wrap { max-width: var(--max-w); margin: 0 auto; padding: 0 24px; }
.lp-section { padding: clamp(72px, 10vw, 128px) 24px; }
.lp-section--cream { background: var(--cream); color: var(--cream-ink); }
.lp-section--cream h1, .lp-section--cream h2, .lp-section--cream h3 { color: var(--cream-ink); }
.lp-section--cream .ink-2 { color: #5c4d3f; }

.eyebrow {
  font-family: var(--font-mono);
  font-size: var(--t-12);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 16px;
}
.lp-section--cream .eyebrow { color: #8a6b48; }

.measure { max-width: var(--measure); }
.ink-2 { color: var(--ink-2); }

/* Coach strip */
.strip {
  display: flex; align-items: center; gap: 12px;
  padding: 20px 24px; border-bottom: 1px solid var(--border);
}
.strip__logo { width: 32px; height: 32px; border-radius: 8px; object-fit: cover; }
.strip__name { font-weight: 600; font-size: var(--t-14); }
.strip__biz { font-size: var(--t-12); color: var(--ink-3); }

/* Hero */
.hero { padding-top: clamp(80px, 12vw, 144px); padding-bottom: clamp(80px, 12vw, 144px); position: relative; }
.hero__inner { max-width: var(--max-w); margin: 0 auto; padding: 0 24px; }
.hero h1 {
  font-size: var(--t-hero); letter-spacing: -0.02em;
  max-width: 14ch; margin-bottom: 24px;
}
.hero__sub { font-size: var(--t-24); color: var(--ink-2); max-width: var(--measure); margin-bottom: 40px; line-height: 1.4; }
.hero__cta-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.hero__proof { color: var(--ink-3); font-size: var(--t-14); margin-top: 24px; }
.hero__bg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; opacity: 0.18; pointer-events: none;
}

/* Buttons */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 14px 22px; border-radius: 999px;
  font-family: var(--font-body); font-weight: 500; font-size: var(--t-16);
  border: 1px solid transparent; cursor: pointer;
  transition: background 200ms ease-out, transform 200ms ease-out, border-color 200ms ease-out;
  text-decoration: none;
}
.btn--primary { background: var(--accent); color: var(--accent-ink); }
.btn--primary:hover { background: var(--accent-hover); color: var(--accent-ink); }
.btn--ghost { background: transparent; color: var(--ink); border-color: var(--border); }
.btn--ghost:hover { border-color: var(--accent); color: var(--accent); }
.lp-section--cream .btn--ghost { color: var(--cream-ink); border-color: rgba(0, 0, 0, 0.12); }
.lp-section--cream .btn--ghost:hover { border-color: var(--accent); color: var(--accent-ink); background: var(--accent); }

/* Problem-Solution */
.ps-grid {
  display: grid; gap: 32px;
  grid-template-columns: 1fr; max-width: var(--max-w); margin: 0 auto;
}
@media (min-width: 760px) { .ps-grid { grid-template-columns: 1fr 1fr; gap: 48px; } }
.ps-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 32px;
}
.ps-card--solution { border-color: var(--accent); }
.ps-card h3 { font-size: var(--t-32); margin-bottom: 16px; }
.ps-card p { color: var(--ink-2); font-size: var(--t-18); }

/* Testimonials */
.tg { display: grid; gap: 24px; grid-template-columns: 1fr; max-width: var(--max-w); margin: 0 auto; }
@media (min-width: 760px) { .tg { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1000px) { .tg { grid-template-columns: repeat(3, 1fr); } }
.t-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px;
  display: flex; flex-direction: column; gap: 16px;
}
.t-card__quote { font-size: var(--t-18); color: var(--ink); line-height: 1.5; }
.t-card__attr { display: flex; align-items: center; gap: 12px; margin-top: auto; }
.t-card__avatar {
  width: 40px; height: 40px; border-radius: 999px; object-fit: cover;
  background: var(--surface-2);
}
.t-card__name { font-weight: 600; font-size: var(--t-14); }
.t-card__metric {
  font-family: var(--font-mono); font-size: var(--t-12);
  color: var(--accent); margin-top: 2px;
}

/* Mechanism — 3-step */
.steps { display: grid; gap: 24px; grid-template-columns: 1fr; max-width: var(--max-w); margin: 0 auto; }
@media (min-width: 760px) { .steps { grid-template-columns: repeat(3, 1fr); gap: 32px; } }
.step {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 28px;
}
.step__num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 999px;
  background: var(--accent); color: var(--accent-ink);
  font-family: var(--font-mono); font-size: var(--t-14); font-weight: 600;
  margin-bottom: 20px;
}
.step__title { font-size: var(--t-24); margin-bottom: 8px; font-family: var(--font-display); font-weight: 500; }
.step__body { color: var(--ink-2); font-size: var(--t-16); }

/* Trust — numbers + creds */
.trust-numbers {
  display: grid; gap: 24px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  max-width: var(--max-w); margin: 0 auto 40px;
}
.trust-num__value {
  font-family: var(--font-display); font-size: var(--t-72);
  letter-spacing: -0.03em; color: var(--accent); line-height: 1;
}
.trust-num__label {
  font-family: var(--font-mono); font-size: var(--t-12);
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
  margin-top: 8px;
}
.trust-creds {
  display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;
  max-width: var(--max-w); margin: 0 auto;
}
.trust-cred {
  padding: 8px 16px; border: 1px solid var(--border);
  border-radius: 999px; font-size: var(--t-14); color: var(--ink-2);
}

/* CTA + lead form (cream) */
.cta-form-wrap {
  max-width: 720px; margin: 0 auto;
  display: grid; gap: 32px;
}
.cta-form-wrap h2 {
  font-size: clamp(2rem, 4vw, 3rem); max-width: 18ch;
}
.lead-form { display: grid; gap: 16px; }
.lead-form__group { display: flex; flex-direction: column; gap: 6px; }
.lead-form label {
  font-family: var(--font-mono); font-size: var(--t-12);
  letter-spacing: 0.08em; text-transform: uppercase; color: #5c4d3f;
}
.lead-form input, .lead-form textarea {
  width: 100%; padding: 14px 16px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 12px;
  font-family: var(--font-body); font-size: var(--t-16); color: var(--cream-ink);
  outline: none; transition: border-color 200ms ease-out, background 200ms ease-out;
}
.lead-form input:focus, .lead-form textarea:focus {
  border-color: var(--accent); background: rgba(255, 255, 255, 0.9);
}
.lead-form__submit {
  margin-top: 8px;
  background: var(--cream-ink); color: var(--cream);
  border: none; padding: 16px 24px; border-radius: 999px;
  font-family: var(--font-body); font-weight: 500; font-size: var(--t-16);
  cursor: pointer; transition: background 200ms ease-out;
}
.lead-form__submit:hover { background: #2a2018; }
.lead-form__reassurance { color: #5c4d3f; font-size: var(--t-14); margin-top: 8px; }

/* Celebration card (replaces form on submit success) */
.celebrate {
  position: relative;
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  padding: 40px 32px;
  background: rgba(255, 255, 255, 0.6);
  text-align: center;
  overflow: hidden;
}
.celebrate h3 {
  font-size: var(--t-32); margin-bottom: 12px; color: var(--cream-ink);
}
.celebrate p { color: #5c4d3f; font-size: var(--t-18); }
/* CSS-only confetti — three motes drift up the corners on first render. */
.celebrate::before,
.celebrate::after,
.celebrate > .mote {
  content: ''; position: absolute; width: 8px; height: 8px;
  background: var(--accent); border-radius: 2px; opacity: 0;
  animation: mote 1800ms ease-out forwards;
}
.celebrate::before { left: 10%; top: 100%; animation-delay: 0ms; }
.celebrate::after { right: 12%; top: 100%; animation-delay: 180ms; background: var(--accent-hover); }
.celebrate > .mote { left: 50%; top: 100%; animation-delay: 360ms; background: var(--cream-ink); }
@keyframes mote {
  0% { transform: translateY(0) rotate(0); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: translateY(-180px) rotate(180deg); opacity: 0; }
}

/* FAQ accordion */
.faq-list { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 4px; }
.faq-item {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; overflow: hidden;
}
.faq-item[open] { border-color: var(--accent); }
.faq-item summary {
  list-style: none; padding: 22px 24px; cursor: pointer;
  font-weight: 500; font-size: var(--t-18);
  display: flex; justify-content: space-between; align-items: center;
}
.faq-item summary::-webkit-details-marker { display: none; }
.faq-item summary::after {
  content: '+'; font-family: var(--font-mono); font-size: var(--t-24);
  color: var(--accent); transition: transform 240ms ease-out;
}
.faq-item[open] summary::after { content: '−'; }
.faq-item__a { padding: 0 24px 22px; color: var(--ink-2); font-size: var(--t-16); line-height: 1.65; }

/* Legacy section carryovers (Phase 1/2 backwards compat) */
.legacy-pricing { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); max-width: var(--max-w); margin: 0 auto; }
.legacy-pricing__card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px 24px; }
.legacy-pricing__card--highlighted { border-color: var(--accent); }
.legacy-pricing__name { font-size: var(--t-18); font-weight: 600; }
.legacy-pricing__price { font-family: var(--font-display); font-size: var(--t-48); margin: 8px 0; }
.legacy-pricing__interval { color: var(--ink-3); font-size: var(--t-14); }
.legacy-pricing__desc { color: var(--ink-2); font-size: var(--t-14); margin: 16px 0; }
.legacy-pricing__cta { display: inline-block; padding: 12px 20px; background: var(--accent); color: var(--accent-ink); border-radius: 999px; font-weight: 500; }
.legacy-ba { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; max-width: var(--max-w); margin: 0 auto 32px; }
.legacy-ba__img { width: 100%; aspect-ratio: 3/4; object-fit: cover; border-radius: var(--radius); }
.legacy-ba__cap { color: var(--ink-3); font-size: var(--t-14); margin-top: 8px; text-align: center; }
.legacy-offer { display: flex; flex-direction: column; gap: 12px; max-width: var(--max-w); margin: 0 auto; }
.legacy-offer__row { display: flex; justify-content: space-between; align-items: center; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.legacy-offer__title { font-weight: 500; }
.legacy-offer__value { color: var(--ink-3); font-size: var(--t-14); }
.legacy-offer__dollars { font-family: var(--font-mono); color: var(--accent); }
.legacy-guarantee { background: var(--surface); border: 2px solid var(--accent); border-radius: var(--radius); padding: 40px; text-align: center; max-width: var(--max-w); margin: 0 auto; }
.legacy-guarantee__days { font-family: var(--font-display); font-size: var(--t-72); color: var(--accent); line-height: 1; }
.legacy-guarantee__label { font-family: var(--font-mono); font-size: var(--t-12); color: var(--ink-3); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 16px; }
.legacy-guarantee__title { font-size: var(--t-24); margin-bottom: 12px; }
.legacy-guarantee__body { color: var(--ink-2); max-width: 480px; margin: 0 auto; }

/* Entrance motion — IntersectionObserver attaches .in-view to .reveal nodes.
   Opacity + 12px translate, 600ms ease-out. Stagger handled via custom
   property --d. The reduce-motion query disables transforms entirely. */
.reveal { opacity: 0; transform: translateY(12px); transition: opacity 600ms ease-out, transform 600ms ease-out; transition-delay: var(--d, 0ms); }
.reveal.in-view { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  .reveal, .reveal.in-view { opacity: 1; transform: none; transition: none; }
  .celebrate::before, .celebrate::after, .celebrate > .mote { animation: none; opacity: 0; }
  html { scroll-behavior: auto; }
}
`;
}

// ─── Base document shell ─────────────────────────────────────────────────────

interface BaseDocumentOpts {
  title: string;
  description: string;
  accent: AccentTriplet;
  canonicalUrl: string;
  ogImage: string | null;
  jsonLd: string;
  body: string;
}

function baseDocument(opts: BaseDocumentOpts): string {
  const { accent, title, description, canonicalUrl, ogImage, jsonLd, body } = opts;
  const ogImg = ogImage
    ? `<meta property="og:image" content="${escAttr(ogImage)}" />`
    : '';
  const twitterImg = ogImage
    ? `<meta name="twitter:image" content="${escAttr(ogImage)}" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0b0b0c" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${escAttr(canonicalUrl)}" />

<!-- Open Graph -->
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${escAttr(canonicalUrl)}" />
${ogImg}

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
${twitterImg}

<!-- Schema.org JSON-LD — escaped against </script> breakout (safeJsonLd). -->
<script type="application/ld+json">${jsonLd}</script>

<!-- Critical CSS inlined for instant first paint. No external stylesheet
     blocks rendering. Both display (Fraunces) and body (Geist Sans)
     declarations fall through to a system stack — see brandCss() — so
     the page paints immediately on system fonts, with no FOIT and no
     paint-blocking webfont request. A future self-hosted WOFF2 +
     <link rel=preload> can be added when the static-asset pipeline
     lands; until then the system fallback is the canonical behavior. -->
<style>${brandCss(accent)}</style>
</head>
<body>
${body}
<script>
/* Entrance motion: attach IntersectionObserver to .reveal nodes.  Class is
   added on first intersection and never removed (no jank if a user scrolls
   back up).  Honors prefers-reduced-motion via the CSS layer.  Falls back
   silently when IntersectionObserver is unsupported (IE 11 etc.). */
(function () {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(function (n) { n.classList.add('in-view'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('in-view');
        io.unobserve(e.target);
      }
    });
  }, { rootMargin: '0px 0px -64px 0px', threshold: 0.05 });
  document.querySelectorAll('.reveal').forEach(function (n) { io.observe(n); });
})();
</script>
</body>
</html>`;
}

// ─── Section renderers ───────────────────────────────────────────────────────

function renderHero(
  payload: Record<string, unknown>,
  page: CoachLandingPage,
  coachSlug: string,
  pageSlug: string,
  proofLine: string,
): string {
  const headline = String(payload.headline || page.headline || '');
  const sub = String(payload.subheadline || page.subheadline || '');
  const imgUrl = String(payload.hero_image_url || page.hero_image_url || '');
  const ctaLabel = esc(page.primary_cta_label || 'Get started');
  // Lead-form pages anchor in-page; checkout pages go to the storefront route.
  const ctaHref =
    page.primary_cta_type === 'lead_form'
      ? '#lead-form'
      : escAttr(`/p/${coachSlug}/${pageSlug}/checkout`);
  const bgImg = imgUrl
    ? `<img class="hero__bg" src="${escAttr(imgUrl)}" alt="" aria-hidden="true" loading="eager" fetchpriority="high" />`
    : '';
  return `
<section class="hero" aria-label="Hero">
  ${bgImg}
  <div class="hero__inner reveal">
    <h1>${nl2br(headline)}</h1>
    ${sub ? `<p class="hero__sub">${nl2br(sub)}</p>` : ''}
    <div class="hero__cta-row">
      <a class="btn btn--primary" href="${ctaHref}">${ctaLabel}</a>
    </div>
    ${proofLine ? `<p class="hero__proof">${esc(proofLine)}</p>` : ''}
  </div>
</section>`;
}

function renderProblemSolution(payload: Record<string, unknown>): string {
  const pt = String(payload.problem_title || '');
  const pb = String(payload.problem_body || '');
  const st = String(payload.solution_title || '');
  const sb = String(payload.solution_body || '');
  return `
<section class="lp-section" aria-label="Problem and solution">
  <div class="lp-wrap">
    <p class="eyebrow reveal">What changes</p>
    <div class="ps-grid">
      <div class="ps-card reveal" style="--d:80ms">
        <h3>${esc(pt)}</h3>
        <p>${nl2br(pb)}</p>
      </div>
      <div class="ps-card ps-card--solution reveal" style="--d:160ms">
        <h3>${esc(st)}</h3>
        <p>${nl2br(sb)}</p>
      </div>
    </div>
  </div>
</section>`;
}

function renderTestimonials(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? (payload.items as any[]) : [];
  return `
<section class="lp-section" aria-label="Outcome proof">
  <div class="lp-wrap">
    <p class="eyebrow reveal">What clients say</p>
    <h2 class="reveal" style="--d:80ms; font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 48px; max-width: 18ch;">Results, not promises.</h2>
    <div class="tg">
      ${items.map((item, i) => `
      <div class="t-card reveal" style="--d:${80 + i * 80}ms">
        <p class="t-card__quote">${esc(item.quote)}</p>
        <div class="t-card__attr">
          ${item.photo_url
            ? `<img class="t-card__avatar" src="${escAttr(item.photo_url)}" alt="${esc(item.name)}" loading="lazy" />`
            : `<div class="t-card__avatar"></div>`}
          <div>
            <div class="t-card__name">${esc(item.name)}</div>
            <div class="t-card__metric">${esc(item.result_metric)}</div>
          </div>
        </div>
      </div>`).join('')}
    </div>
  </div>
</section>`;
}

function renderMechanism(payload: Record<string, unknown>): string {
  const steps = Array.isArray(payload.steps) ? (payload.steps as any[]) : [];
  return `
<section class="lp-section" style="background: var(--surface)" aria-label="How it works">
  <div class="lp-wrap">
    <p class="eyebrow reveal">How it works</p>
    <h2 class="reveal" style="--d:80ms; font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 48px; max-width: 18ch;">Three steps, one outcome.</h2>
    <div class="steps">
      ${steps.map((step, i) => `
      <div class="step reveal" style="--d:${80 + i * 80}ms">
        <div class="step__num">${i + 1}</div>
        <div class="step__title">${esc(step.title)}</div>
        <p class="step__body">${nl2br(step.body)}</p>
      </div>`).join('')}
    </div>
  </div>
</section>`;
}

function renderTrust(payload: Record<string, unknown>): string {
  const numbers = Array.isArray(payload.numbers) ? (payload.numbers as any[]) : [];
  const creds = Array.isArray(payload.credentials) ? (payload.credentials as string[]) : [];
  return `
<section class="lp-section" aria-label="Trust">
  <div class="lp-wrap">
    <p class="eyebrow reveal" style="text-align: center">Trust signals</p>
    ${numbers.length > 0 ? `
    <div class="trust-numbers">
      ${numbers.map((n, i) => `
      <div class="reveal" style="--d:${80 + i * 80}ms; text-align: center">
        <div class="trust-num__value">${esc(n.value)}</div>
        <div class="trust-num__label">${esc(n.label)}</div>
      </div>`).join('')}
    </div>` : ''}
    ${creds.length > 0 ? `
    <div class="trust-creds reveal" style="--d:${80 + numbers.length * 80}ms">
      ${creds.map((c) => `<div class="trust-cred">${esc(c)}</div>`).join('')}
    </div>` : ''}
  </div>
</section>`;
}

function renderLeadForm(
  payload: Record<string, unknown>,
  coachSlug: string,
  pageSlug: string,
  coachName: string,
): string {
  const fields = Array.isArray(payload.fields)
    ? (payload.fields as string[])
    : ['name', 'email'];
  const ctaLabel = String(payload.cta_label || 'Send me details');
  const formAction = `/p/${coachSlug}/${pageSlug}/leads`;
  const fieldHtml = fields
    .map((f) => {
      switch (f) {
        case 'name':
          return `<div class="lead-form__group"><label for="lf-name">Your name</label><input id="lf-name" name="name" type="text" autocomplete="name" required /></div>`;
        case 'email':
          return `<div class="lead-form__group"><label for="lf-email">Email</label><input id="lf-email" name="email" type="email" autocomplete="email" required /></div>`;
        case 'phone':
          return `<div class="lead-form__group"><label for="lf-phone">Phone</label><input id="lf-phone" name="phone" type="tel" autocomplete="tel" /></div>`;
        case 'goal':
          return `<div class="lead-form__group"><label for="lf-goal">Your goal</label><input id="lf-goal" name="goal" type="text" /></div>`;
        default:
          return '';
      }
    })
    .join('');
  return `
<section class="lp-section lp-section--cream" id="lead-form" aria-label="Get in touch">
  <div class="cta-form-wrap">
    <div class="reveal">
      <p class="eyebrow">Get in touch</p>
      <h2>Tell me a little about you.</h2>
    </div>
    <form class="lead-form reveal" id="lead-form-el" style="--d:80ms" action="${escAttr(formAction)}" method="POST" data-coach-name="${esc(coachName)}">
      ${fieldHtml}
      <button class="lead-form__submit" type="submit">${esc(ctaLabel)}</button>
      <p class="lead-form__reassurance">No spam. ${esc(coachName)} responds within 24 hours.</p>
    </form>
    <div class="celebrate" id="lead-celebration" style="display: none" role="status" aria-live="polite">
      <span class="mote"></span>
      <h3 id="celebrate-line"></h3>
      <p id="celebrate-sub"></p>
    </div>
  </div>
</section>
<script>
(function () {
  var form = document.getElementById('lead-form-el');
  var celebrate = document.getElementById('lead-celebration');
  var line = document.getElementById('celebrate-line');
  var sub = document.getElementById('celebrate-sub');
  if (!form || !celebrate || !line || !sub) return;
  var coachName = form.getAttribute('data-coach-name') || 'your coach';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var body = {};
    data.forEach(function (v, k) { body[k] = v; });
    var firstName = (body.name || '').split(' ')[0] || 'friend';
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (r.ok) {
          form.style.display = 'none';
          line.textContent = 'Thanks, ' + firstName + '.';
          sub.textContent = coachName + ' will be in touch within 24 hours.';
          celebrate.style.display = 'block';
        }
      })
      .catch(function () { /* network drop — let the user retry */ });
  });
})();
</script>`;
}

function renderFaq(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? (payload.items as any[]) : [];
  return `
<section class="lp-section" aria-label="Frequently asked questions">
  <div class="lp-wrap">
    <p class="eyebrow reveal" style="text-align: center">Frequently asked</p>
    <h2 class="reveal" style="--d:80ms; text-align: center; font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 48px;">Common questions.</h2>
    <div class="faq-list">
      ${items.map((item, i) => `
      <details class="faq-item reveal" style="--d:${80 + i * 60}ms">
        <summary>${esc(item.question)}</summary>
        <div class="faq-item__a">${markdownLight(item.answer)}</div>
      </details>`).join('')}
    </div>
  </div>
</section>`;
}

// ─── Legacy section carryovers (Phase 1/2 backwards compat) ──────────────────

function renderBeforeAfterLegacy(payload: Record<string, unknown>): string {
  const pairs = Array.isArray(payload.pairs) ? (payload.pairs as any[]) : [];
  return `
<section class="lp-section" aria-label="Before and after">
  <div class="lp-wrap">
    <p class="eyebrow reveal">Transformations</p>
    ${pairs.map((pair, i) => `
    <div class="reveal" style="--d:${80 + i * 80}ms">
      <div class="legacy-ba">
        <div>
          <img class="legacy-ba__img" src="${escAttr(pair.before_url)}" alt="Before" loading="lazy" />
          <p class="legacy-ba__cap">Before · ${esc(pair.date_label)}</p>
        </div>
        <div>
          <img class="legacy-ba__img" src="${escAttr(pair.after_url)}" alt="After" loading="lazy" />
          <p class="legacy-ba__cap">After · ${esc(pair.date_label)}</p>
        </div>
      </div>
      ${pair.caption ? `<p class="legacy-ba__cap">${esc(pair.caption)}</p>` : ''}
    </div>`).join('')}
  </div>
</section>`;
}

function renderPricingLegacy(
  payload: Record<string, unknown>,
  packages: CoachPackage[],
  coachSlug: string,
  pageSlug: string,
): string {
  const highlightedId = String(payload.highlighted_id || '');
  return `
<section class="lp-section" id="pricing" aria-label="Pricing">
  <div class="lp-wrap">
    <p class="eyebrow reveal">Pricing</p>
    <h2 class="reveal" style="--d:80ms; font-size: clamp(2rem, 4vw, 3rem); margin-bottom: 48px;">Choose your path.</h2>
    <div class="legacy-pricing">
      ${packages.map((pkg, i) => {
        const isHigh = pkg.id === highlightedId;
        const priceDisplay = `$${(pkg.amount_cents / 100).toFixed(pkg.amount_cents % 100 === 0 ? 0 : 2)}`;
        const checkoutUrl = `/p/${coachSlug}/${pageSlug}/checkout?tier=${pkg.id}`;
        return `
      <div class="legacy-pricing__card${isHigh ? ' legacy-pricing__card--highlighted' : ''} reveal" style="--d:${80 + i * 80}ms">
        <div class="legacy-pricing__name">${esc(pkg.name)}</div>
        <div class="legacy-pricing__price">${priceDisplay}</div>
        <div class="legacy-pricing__interval">${pkg.billing_type === 'recurring' ? `per ${pkg.interval ?? 'month'}` : 'one-time'}</div>
        ${pkg.description ? `<p class="legacy-pricing__desc">${esc(pkg.description)}</p>` : ''}
        <a class="legacy-pricing__cta" href="${escAttr(checkoutUrl)}">Get started</a>
      </div>`;
      }).join('')}
    </div>
  </div>
</section>`;
}

function renderOfferStackLegacy(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? (payload.items as any[]) : [];
  return `
<section class="lp-section" aria-label="What's included">
  <div class="lp-wrap">
    <p class="eyebrow reveal">What's included</p>
    <div class="legacy-offer">
      ${items.map((item, i) => `
      <div class="legacy-offer__row reveal" style="--d:${80 + i * 60}ms">
        <div>
          <div class="legacy-offer__title">${esc(item.title)}</div>
          <div class="legacy-offer__value">${esc(item.value_line)}</div>
        </div>
        ${item.value_dollars ? `<div class="legacy-offer__dollars">$${item.value_dollars}</div>` : ''}
      </div>`).join('')}
    </div>
  </div>
</section>`;
}

function renderGuaranteeLegacy(payload: Record<string, unknown>): string {
  const days = payload.days ? Number(payload.days) : null;
  return `
<section class="lp-section" aria-label="Guarantee">
  <div class="lp-wrap">
    <div class="legacy-guarantee reveal">
      ${days ? `<div class="legacy-guarantee__days">${days}</div><p class="legacy-guarantee__label">Day guarantee</p>` : ''}
      <h3 class="legacy-guarantee__title">${esc(String(payload.title || ''))}</h3>
      <p class="legacy-guarantee__body">${markdownLight(String(payload.body || ''))}</p>
    </div>
  </div>
</section>`;
}

// ─── Section dispatch ────────────────────────────────────────────────────────

function renderSection(
  section: CoachLandingPageSection,
  page: CoachLandingPage,
  packages: CoachPackage[],
  coachSlug: string,
  pageSlug: string,
  proofLine: string,
  coachName: string,
): string {
  const payload = (section.payload as Record<string, unknown>) || {};
  switch (section.kind) {
    case 'hero':
      return renderHero(payload, page, coachSlug, pageSlug, proofLine);
    case 'problem_solution':
      return renderProblemSolution(payload);
    case 'testimonials':
      return renderTestimonials(payload);
    case 'mechanism':
      return renderMechanism(payload);
    case 'trust':
      return renderTrust(payload);
    case 'lead_form':
      return renderLeadForm(payload, coachSlug, pageSlug, coachName);
    case 'faq':
      return renderFaq(payload);
    // Legacy carryovers — Phase 1/2 pages must keep rendering.
    case 'before_after':
      return renderBeforeAfterLegacy(payload);
    case 'pricing':
      return renderPricingLegacy(payload, packages, coachSlug, pageSlug);
    case 'offer_stack':
      return renderOfferStackLegacy(payload);
    case 'guarantee':
      return renderGuaranteeLegacy(payload);
    default:
      return '';
  }
}

// ─── Not found page (SaaS dark) ──────────────────────────────────────────────

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="color-scheme" content="dark" />
<title>Page not available</title>
<style>
  :root { --bg: #0b0b0c; --surface: #131316; --ink: #f3f3f3; --ink-2: #b8b8bb; --ink-3: #6e6e72; --border: rgba(255,255,255,.08); --accent: #d4a574; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh; display: grid; place-items: center; padding: 32px 20px;
    -webkit-font-smoothing: antialiased;
  }
  .card { max-width: 460px; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 56px 40px; text-align: center; }
  .eyebrow { font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin-bottom: 16px; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 32px; letter-spacing: -0.02em; margin-bottom: 12px; }
  p { color: var(--ink-2); font-size: 17px; line-height: 1.55; }
</style>
</head>
<body>
<div class="card">
  <p class="eyebrow">Coach landing page</p>
  <h1>This page isn&rsquo;t available.</h1>
  <p>The link may have expired or the coach paused this page. Reach out to them directly for the latest.</p>
</div>
</body>
</html>`;
}

// ─── Public renderer entry ───────────────────────────────────────────────────

export function renderPublicPage(
  page: PageWithContext,
  packages: CoachPackage[],
  coachSlug: string,
  baseUrl: string,
): string {
  const coach = page.coach;
  const profile = coach.coach_profile;
  const accent = resolveAccent(page.accent_color || profile?.branding_accent_color);
  const canonicalUrl = `${baseUrl}/p/${coachSlug}/${page.slug}`;
  const businessName = profile?.business_name ?? null;
  const coachName = coach.name;

  const title = `${page.headline} — ${businessName || coachName}`;
  const description = page.subheadline || `Work with ${coachName}.`;

  // A short social-proof line under the hero CTA.  Pulled from coach bio
  // when present (capped so it stays a one-liner); otherwise omitted (no
  // fake numbers, no fallback strings — empty hero stays empty).
  const proofLine = profile?.bio
    ? profile.bio.replace(/\s+/g, ' ').trim().slice(0, 140)
    : '';

  // Schema.org JSON-LD — escaped against </script> breakout (safeJsonLd).
  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        name: coachName,
        url: canonicalUrl,
        ...(profile?.bio ? { description: profile.bio } : {}),
      },
      ...(businessName
        ? [{
            '@type': 'LocalBusiness',
            name: businessName,
            url: canonicalUrl,
            ...(profile?.bio ? { description: profile.bio } : {}),
          }]
        : []),
    ],
  });

  // Coach strip — slim header above the hero.
  const logoHtml = profile?.branding_logo_url
    ? `<img class="strip__logo" src="${escAttr(profile.branding_logo_url)}" alt="${esc(coachName)}" />`
    : '';
  const strip = `
<header class="strip" aria-label="Coach">
  ${logoHtml}
  <div>
    <div class="strip__name">${esc(coachName)}</div>
    ${businessName ? `<div class="strip__biz">${esc(businessName)}</div>` : ''}
  </div>
</header>`;

  // Render every section the coach placed on the page.  The arc order is
  // determined by `order_index` in the DB, not by section kind — coaches
  // can re-order freely within the locked design system.
  const sectionsHtml = page.sections
    .map((s) => renderSection(s, page, packages, coachSlug, page.slug, proofLine, coachName))
    .join('');

  const body = `${strip}${sectionsHtml}`;

  return baseDocument({
    title,
    description,
    accent,
    canonicalUrl,
    ogImage: page.hero_image_url,
    jsonLd,
    body,
  });
}
