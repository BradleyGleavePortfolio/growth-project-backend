/**
 * Server-side HTML renderer for coach landing pages.
 *
 * Design principles:
 * - Premium typography: Playfair Display for headlines, Inter/system for body
 * - Generous whitespace, max-width 720px content blocks
 * - Inline critical CSS, no external fonts until after paint (preload trick)
 * - Open Graph + Twitter card meta
 * - LocalBusiness + Person schema.org JSON-LD
 * - Section rendering: switch on section.kind, render each to its locked template
 * - Four visual templates: transformation, authority, community, offer
 * - LCP target < 1.2s on 4G via inline critical CSS
 * - Sticky mobile CTA bar + desktop exit-intent (vanilla JS, no framework)
 *
 * Pattern mirrors invite-landing.service.ts but is significantly richer.
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
    // Prisma relation name on User model is 'coach_profile' (not 'profile')
    coach_profile: CoachProfile | null;
  };
};

// ─── JSON-LD safe serialiser ────────────────────────────────────────────────

/**
 * Serialise an object as JSON that is safe to inline inside a
 * <script type="application/ld+json"> block.
 *
 * JSON.stringify does NOT escape `<`, `>`, or `&`, so a value such as
 * `</script><img onerror=…>` will terminate the script element and inject
 * arbitrary HTML.  The canonical fix (used by Google's safe-html guide and
 * Angular's SSR renderer) is to unicode-escape every angle bracket and
 * ampersand.  U+2028 / U+2029 are also escaped because some JS engines
 * (pre-ES2019 spec) treat them as line terminators inside string literals.
 */
function safeJsonLd(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ─── HTML escape helpers ──────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s: string | null | undefined): string {
  const v = (s || '').trim();
  if (!v) return '#';
  const safe = /^(?:https?:|\/)/i.test(v);
  return safe ? esc(v) : '#';
}

function sanitizeColor(c: string | null | undefined): string {
  if (!c) return '#1a1612';
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : '#1a1612';
}

function nl2br(s: string): string {
  return esc(s).replace(/\n/g, '<br>');
}

/** Convert markdown bold/italic to safe HTML (no arbitrary HTML). */
function markdownLight(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// ─── Base document ────────────────────────────────────────────────────────────

interface BaseDocumentOpts {
  title: string;
  description: string;
  accent: string;
  canonicalUrl: string;
  ogImage: string | null;
  coachName: string;
  businessName: string | null;
  jsonLd: string;
  body: string;
  primaryCtaLabel: string;
  primaryCtaHref: string;
  template: string;
}

function baseDocument(opts: BaseDocumentOpts): string {
  const { accent, title, description, canonicalUrl, ogImage, coachName, businessName, jsonLd, body, primaryCtaLabel, primaryCtaHref, template } = opts;
  const ogImg = ogImage ? `<meta property="og:image" content="${escAttr(ogImage)}" />` : '';

  return `<!doctype html>
<html lang="en" data-template="${esc(template)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="index,follow" />
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
${ogImage ? `<meta name="twitter:image" content="${escAttr(ogImage)}" />` : ''}

<!-- Schema.org JSON-LD (LocalBusiness + Person) -->
<script type="application/ld+json">${jsonLd}</script>

<!-- Critical CSS inlined for LCP < 1.2s — no external CSS blocks paint -->
<style>
:root {
  --accent: ${accent};
  --accent-dark: color-mix(in srgb, ${accent} 80%, #000);
  --ink: #1a1612;
  --paper: #faf8f5;
  --surface: #fff;
  --muted: #6b6259;
  --border: #e7e1d6;
  --radius: 16px;
  --max-w: 720px;
}
*,::before,::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{
  background:var(--paper);
  color:var(--ink);
  font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:17px;
  line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4{
  font-family:"Playfair Display","Iowan Old Style",Georgia,"Times New Roman",serif;
  font-weight:500;
  line-height:1.15;
  letter-spacing:-0.01em;
}
img{max-width:100%;display:block;}
a{color:var(--accent);text-decoration:none;}
a:hover{text-decoration:underline;}

/* Layout */
.lp-section{padding:80px 20px;max-width:var(--max-w);margin:0 auto;}
.lp-section--full{padding:0;max-width:none;}
.section-label{
  font-size:11px;text-transform:uppercase;letter-spacing:.14em;
  color:var(--muted);margin-bottom:12px;
}

/* Hero */
.hero{
  position:relative;overflow:hidden;
  min-height:520px;display:flex;align-items:flex-end;
  padding:60px 20px 72px;
  background:#1a1612;
}
.hero__bg{
  position:absolute;inset:0;
  width:100%;height:100%;
  object-fit:cover;object-position:center;
  filter:brightness(.55);
  transition:filter .3s;
  z-index:0;
}
.hero__content{
  position:relative;z-index:1;
  max-width:var(--max-w);margin:0 auto;width:100%;
}
.hero h1{
  color:#fff;font-size:clamp(36px,6vw,72px);
  margin-bottom:18px;text-shadow:0 2px 24px rgba(0,0,0,.25);
}
.hero__sub{color:rgba(255,255,255,.88);font-size:20px;margin-bottom:32px;max-width:560px;}
.hero__cta{
  display:inline-block;padding:16px 32px;
  background:var(--accent);color:#fff;
  border-radius:999px;font-weight:600;font-size:16px;
  box-shadow:0 4px 24px rgba(0,0,0,.2);
  transition:transform .15s,box-shadow .15s;
}
.hero__cta:hover{transform:translateY(-1px);box-shadow:0 6px 32px rgba(0,0,0,.28);text-decoration:none;}

/* Before / After */
.ba-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:32px;}
.ba-pair{border-radius:var(--radius);overflow:hidden;background:var(--surface);border:1px solid var(--border);}
.ba-pair__img{width:100%;aspect-ratio:3/4;object-fit:cover;}
.ba-pair__label{
  padding:10px 14px;font-size:12px;letter-spacing:.06em;
  font-variant-numeric:tabular-nums lining-nums;
  color:var(--muted);
  font-family:ui-monospace,"Cascadia Code","Fira Code",monospace;
}
.ba-caption{font-size:14px;color:var(--muted);text-align:center;margin-top:6px;}
@media(max-width:540px){.ba-grid{grid-template-columns:1fr;}}

/* Testimonials */
.testimonials-grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));}
.testimonial-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:24px;
}
.testimonial-card__header{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.testimonial-card__avatar{
  width:44px;height:44px;border-radius:50%;object-fit:cover;
  background:var(--border);flex-shrink:0;
}
.testimonial-card__name{font-weight:600;font-size:15px;}
.testimonial-card__metric{
  font-size:12px;color:var(--accent);
  font-family:ui-monospace,"Cascadia Code","Fira Code",monospace;
  font-variant-numeric:tabular-nums;
  margin-top:2px;
}
.testimonial-card__quote{font-size:15px;color:var(--muted);font-style:italic;}
.testimonial-card__quote::before{content:'\u201c';}
.testimonial-card__quote::after{content:'\u201d';}

/* Pricing */
.pricing-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));}
.pricing-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:28px 24px;
  transition:transform .2s,box-shadow .2s;
}
.pricing-card:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,.08);}
.pricing-card--highlighted{
  border-color:var(--accent);
  box-shadow:0 0 0 2px var(--accent),0 8px 32px rgba(0,0,0,.1);
}
.pricing-card__badge{
  display:inline-block;margin-bottom:12px;
  padding:4px 12px;border-radius:999px;
  background:var(--accent);color:#fff;
  font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
}
.pricing-card__name{font-size:18px;font-weight:600;margin-bottom:8px;}
.pricing-card__price{
  font-size:36px;font-weight:700;
  font-family:"Playfair Display",Georgia,serif;
  margin-bottom:4px;
}
.pricing-card__interval{font-size:14px;color:var(--muted);}
.pricing-card__desc{font-size:14px;color:var(--muted);margin:12px 0 20px;}
.pricing-card__cta{
  display:block;text-align:center;
  padding:12px 20px;background:var(--ink);color:#fff;
  border-radius:999px;font-weight:600;font-size:15px;
  transition:background .15s;
}
.pricing-card--highlighted .pricing-card__cta{background:var(--accent);}
.pricing-card__cta:hover{opacity:.9;text-decoration:none;}

/* FAQ accordion */
.faq-list{display:flex;flex-direction:column;gap:4px;}
details.faq-item{
  border:1px solid var(--border);border-radius:12px;
  background:var(--surface);overflow:hidden;
}
details.faq-item[open]{border-color:var(--accent);}
details.faq-item summary{
  list-style:none;padding:18px 22px;cursor:pointer;
  font-weight:600;font-size:16px;
  display:flex;justify-content:space-between;align-items:center;
}
details.faq-item summary::-webkit-details-marker{display:none;}
details.faq-item summary::after{
  content:'+';font-size:22px;font-weight:400;
  color:var(--accent);flex-shrink:0;margin-left:16px;
  transition:transform .2s;
}
details.faq-item[open] summary::after{content:'\u2212';}
.faq-item__answer{padding:0 22px 18px;color:var(--muted);font-size:15px;line-height:1.7;}

/* Lead form */
.lead-form{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px;}
.lead-form__title{font-size:22px;margin-bottom:6px;}
.lead-form__sub{color:var(--muted);font-size:15px;margin-bottom:24px;}
.lead-form__group{margin-bottom:16px;}
.lead-form label{
  display:block;font-size:13px;font-weight:600;
  letter-spacing:.04em;text-transform:uppercase;
  margin-bottom:6px;color:var(--muted);
}
.lead-form input,.lead-form textarea{
  width:100%;padding:12px 14px;
  border:1px solid var(--border);border-radius:10px;
  font-size:16px;background:var(--paper);
  transition:border-color .15s;outline:none;
}
.lead-form input:focus,.lead-form textarea:focus{border-color:var(--accent);}
.lead-form__submit{
  width:100%;padding:14px;background:var(--accent);color:#fff;
  border:none;border-radius:999px;font-size:16px;font-weight:600;
  cursor:pointer;transition:opacity .15s;margin-top:8px;
}
.lead-form__submit:hover{opacity:.9;}
.lead-form__success{display:none;text-align:center;padding:24px 0;}
.lead-form__success h3{font-size:22px;margin-bottom:8px;}
.lead-form__success p{color:var(--muted);}

/* Offer stack */
.offer-list{display:flex;flex-direction:column;gap:12px;}
.offer-item{
  display:flex;justify-content:space-between;align-items:center;
  padding:16px 20px;background:var(--surface);border:1px solid var(--border);border-radius:12px;
}
.offer-item__text{flex:1;}
.offer-item__title{font-weight:600;font-size:16px;}
.offer-item__value{font-size:14px;color:var(--muted);}
.offer-item__dollars{
  font-size:18px;font-weight:700;color:var(--accent);
  font-variant-numeric:tabular-nums;margin-left:16px;white-space:nowrap;
}

/* Guarantee */
.guarantee-card{
  background:var(--surface);border:2px solid var(--accent);border-radius:var(--radius);
  padding:36px;text-align:center;
}
.guarantee-card__days{
  font-size:56px;font-weight:700;color:var(--accent);
  font-family:"Playfair Display",Georgia,serif;
  margin-bottom:4px;
}
.guarantee-card__title{font-size:22px;margin-bottom:12px;}
.guarantee-card__body{color:var(--muted);font-size:16px;max-width:480px;margin:0 auto;}

/* Section headings */
.section-heading{font-size:clamp(28px,4vw,42px);margin-bottom:16px;}
.section-sub{color:var(--muted);font-size:17px;max-width:560px;margin-bottom:40px;line-height:1.6;}

/* Sticky mobile CTA bar */
.sticky-cta{
  display:none;
  position:sticky;bottom:0;left:0;right:0;z-index:100;
  background:var(--surface);border-top:1px solid var(--border);
  padding:12px 20px;
}
.sticky-cta a{
  display:block;text-align:center;
  padding:14px;background:var(--accent);color:#fff;
  border-radius:999px;font-weight:600;font-size:16px;
}
@media(max-width:768px){.sticky-cta{display:block;}}

/* Exit intent overlay (desktop only — populated by JS below) */
#exit-intent{
  display:none;position:fixed;inset:0;z-index:999;
  background:rgba(26,22,18,.72);backdrop-filter:blur(4px);
  align-items:center;justify-content:center;
}
#exit-intent.active{display:flex;}
.exit-modal{
  background:var(--surface);border-radius:var(--radius);
  padding:40px;max-width:460px;width:calc(100% - 40px);
  text-align:center;position:relative;
}
.exit-modal h2{font-size:26px;margin-bottom:12px;}
.exit-modal p{color:var(--muted);margin-bottom:24px;}
.exit-modal__close{
  position:absolute;top:16px;right:20px;
  background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);
}
.exit-modal__cta{
  display:inline-block;padding:14px 28px;
  background:var(--accent);color:#fff;border-radius:999px;
  font-weight:600;font-size:16px;
}

/* Divider */
hr.lp-divider{border:none;border-top:1px solid var(--border);margin:0;}

/* Coach meta strip */
.coach-strip{
  padding:16px 20px;background:var(--surface);border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:12px;
}
.coach-strip__logo{width:36px;height:36px;border-radius:8px;object-fit:cover;}
.coach-strip__name{font-weight:600;font-size:15px;}
.coach-strip__biz{font-size:13px;color:var(--muted);}

/* Playfair Display via preload (non-render-blocking) */
</style>
<!-- Preload Playfair Display after paint — non-blocking via preload + onload trick -->
<link rel="preload" as="style"
  href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;700&family=Inter:wght@400;500;600&display=swap"
  onload="this.rel='stylesheet'" />
<noscript>
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;700&family=Inter:wght@400;500;600&display=swap" />
</noscript>
</head>
<body>
${body}

<!-- Sticky mobile CTA bar -->
<div class="sticky-cta" aria-label="Quick action">
  <a href="${escAttr(primaryCtaHref)}">${esc(primaryCtaLabel)}</a>
</div>

<!-- Exit intent overlay (desktop only) -->
<div id="exit-intent" role="dialog" aria-modal="true" aria-label="Before you go">
  <div class="exit-modal">
    <button class="exit-modal__close" onclick="document.getElementById('exit-intent').classList.remove('active')" aria-label="Close">&times;</button>
    <h2>Before you go…</h2>
    <p>Still thinking it over? Take the next step — it starts with a conversation.</p>
    <a class="exit-modal__cta" href="${escAttr(primaryCtaHref)}">${esc(primaryCtaLabel)}</a>
  </div>
</div>

<script>
// Exit intent — desktop only (no touch, no mobile)
(function(){
  if('ontouchstart' in window || window.innerWidth < 768) return;
  var shown = false;
  document.addEventListener('mouseleave', function(e){
    if(shown || e.clientY > 20) return;
    shown = true;
    var el = document.getElementById('exit-intent');
    if(el) el.classList.add('active');
  });
  document.getElementById('exit-intent').addEventListener('click', function(e){
    if(e.target === this) this.classList.remove('active');
  });
})();
</script>
</body>
</html>`;
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderHero(payload: Record<string, unknown>, page: CoachLandingPage, coachSlug: string, pageSlug: string): string {
  const headline = String(payload.headline || page.headline || '');
  const sub = String(payload.subheadline || page.subheadline || '');
  const imgUrl = String(payload.hero_image_url || page.hero_image_url || '');
  const ctaLabel = esc(page.primary_cta_label || 'Get Started');
  const ctaHref = escAttr(`/p/${coachSlug}/${pageSlug}/checkout`);
  // Use an <img> element instead of background-image:url('…') to avoid the
  // CSS string-injection attack: `escAttr` HTML-escapes apostrophes to &#39;
  // but the browser's HTML attribute decoder restores them before the CSS
  // parser runs, allowing a coached-supplied URL to break out of the url()
  // context.  An <img src="…"> attribute is fully contained — escAttr already
  // rejects non-http(s) / non-relative URLs by substituting '#', and there is
  // no secondary CSS string decoding step.
  const bgImg = imgUrl
    ? `<img class="hero__bg" src="${escAttr(imgUrl)}" alt="" aria-hidden="true" />`
    : '';

  return `
<section class="hero lp-section--full" aria-label="Hero">
  ${bgImg}
  <div class="hero__content">
    <h1>${nl2br(headline)}</h1>
    ${sub ? `<p class="hero__sub">${nl2br(sub)}</p>` : ''}
    <a class="hero__cta" href="${ctaHref}">${ctaLabel}</a>
  </div>
</section>`;
}

function renderBeforeAfter(payload: Record<string, unknown>): string {
  const pairs = Array.isArray(payload.pairs) ? payload.pairs as any[] : [];
  return `
<section class="lp-section">
  <p class="section-label">Transformations</p>
  <h2 class="section-heading">Real results from real clients</h2>
  ${pairs.map((pair) => `
  <div class="ba-grid">
    <div class="ba-pair">
      <img class="ba-pair__img" src="${escAttr(pair.before_url)}" alt="Before" loading="lazy" />
      <div class="ba-pair__label">Before · ${esc(pair.date_label)}</div>
    </div>
    <div class="ba-pair">
      <img class="ba-pair__img" src="${escAttr(pair.after_url)}" alt="After" loading="lazy" />
      <div class="ba-pair__label">After · ${esc(pair.date_label)}</div>
    </div>
  </div>
  ${pair.caption ? `<p class="ba-caption">${esc(pair.caption)}</p>` : ''}`).join('')}
</section>`;
}

function renderTestimonials(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? payload.items as any[] : [];
  return `
<section class="lp-section" style="background:var(--paper)">
  <p class="section-label">What clients say</p>
  <h2 class="section-heading">Results that speak</h2>
  <div class="testimonials-grid">
    ${items.map((item) => `
    <div class="testimonial-card">
      <div class="testimonial-card__header">
        ${item.photo_url
          ? `<img class="testimonial-card__avatar" src="${escAttr(item.photo_url)}" alt="${esc(item.name)}" loading="lazy" />`
          : `<div class="testimonial-card__avatar"></div>`}
        <div>
          <div class="testimonial-card__name">${esc(item.name)}</div>
          <div class="testimonial-card__metric">${esc(item.result_metric)}</div>
        </div>
      </div>
      <p class="testimonial-card__quote">${esc(item.quote)}</p>
    </div>`).join('')}
  </div>
</section>`;
}

function renderPricing(payload: Record<string, unknown>, packages: CoachPackage[], coachSlug: string, pageSlug: string): string {
  const highlightedId = String(payload.highlighted_id || '');
  return `
<section class="lp-section" id="pricing">
  <p class="section-label">Pricing</p>
  <h2 class="section-heading">Choose your path</h2>
  <div class="pricing-grid">
    ${packages.map((pkg) => {
      const isHighlighted = pkg.id === highlightedId;
      const priceDisplay = `$${(pkg.amount_cents / 100).toFixed(pkg.amount_cents % 100 === 0 ? 0 : 2)}`;
      const interval = pkg.billing_type === 'recurring' ? `/${pkg.interval ?? 'mo'}` : '';
      const checkoutUrl = `/p/${coachSlug}/${pageSlug}/checkout?tier=${pkg.id}`;
      return `
    <div class="pricing-card${isHighlighted ? ' pricing-card--highlighted' : ''}">
      ${isHighlighted ? `<div class="pricing-card__badge">Most popular</div>` : ''}
      <div class="pricing-card__name">${esc(pkg.name)}</div>
      <div class="pricing-card__price">${priceDisplay}</div>
      <div class="pricing-card__interval">${pkg.billing_type === 'recurring' ? `per ${pkg.interval ?? 'month'}` : 'one-time'}</div>
      ${pkg.description ? `<p class="pricing-card__desc">${esc(pkg.description)}</p>` : ''}
      <a class="pricing-card__cta" href="${escAttr(checkoutUrl)}">Get started</a>
    </div>`;
    }).join('')}
  </div>
</section>`;
}

function renderFaq(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? payload.items as any[] : [];
  return `
<section class="lp-section">
  <p class="section-label">FAQ</p>
  <h2 class="section-heading">Common questions</h2>
  <div class="faq-list" role="list">
    ${items.map((item) => `
    <details class="faq-item" role="listitem">
      <summary>${esc(item.question)}</summary>
      <div class="faq-item__answer">${markdownLight(item.answer)}</div>
    </details>`).join('')}
  </div>
</section>`;
}

function renderLeadForm(payload: Record<string, unknown>, coachSlug: string, pageSlug: string): string {
  const fields = Array.isArray(payload.fields) ? payload.fields as string[] : ['name', 'email'];
  const ctaLabel = String(payload.cta_label || 'Send me info');
  const formAction = `/p/${coachSlug}/${pageSlug}/leads`;

  const fieldHtml = fields.map((f) => {
    switch (f) {
      case 'name':
        return `<div class="lead-form__group"><label for="lf-name">Your name</label><input id="lf-name" name="name" type="text" autocomplete="name" placeholder="Jane Smith" /></div>`;
      case 'email':
        return `<div class="lead-form__group"><label for="lf-email">Email address <span style="color:var(--accent)">*</span></label><input id="lf-email" name="email" type="email" autocomplete="email" required placeholder="jane@example.com" /></div>`;
      case 'phone':
        return `<div class="lead-form__group"><label for="lf-phone">Phone number</label><input id="lf-phone" name="phone" type="tel" autocomplete="tel" placeholder="+1 (555) 000-0000" /></div>`;
      case 'goal':
        return `<div class="lead-form__group"><label for="lf-goal">What's your main goal?</label><input id="lf-goal" name="goal" type="text" placeholder="e.g. lose 20 lbs, build muscle…" /></div>`;
      default:
        return '';
    }
  }).join('');

  return `
<section class="lp-section" id="contact">
  <div class="lead-form" role="form" aria-label="Contact form">
    <h2 class="lead-form__title section-heading">Ready to start?</h2>
    <p class="lead-form__sub">Fill in your details and we'll be in touch within 24 hours.</p>
    <form id="lead-form-el" action="${escAttr(formAction)}" method="POST">
      ${fieldHtml}
      <button class="lead-form__submit" type="submit">${esc(ctaLabel)}</button>
    </form>
    <div class="lead-form__success" id="lead-success">
      <h3>You're on the list!</h3>
      <p>Check your inbox — we'll be in touch soon.</p>
    </div>
  </div>
</section>
<script>
(function(){
  var form = document.getElementById('lead-form-el');
  var success = document.getElementById('lead-success');
  if(!form) return;
  form.addEventListener('submit', function(e){
    e.preventDefault();
    var data = new FormData(form);
    var body = {};
    data.forEach(function(v,k){ body[k]=v; });
    fetch(form.action, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }).then(function(r){
      if(r.ok || r.status === 200){
        form.style.display='none';
        success.style.display='block';
        if('vibrate' in navigator) navigator.vibrate([30,10,30]);
      }
    }).catch(function(){});
  });
})();
</script>`;
}

function renderOfferStack(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? payload.items as any[] : [];
  const total = items.reduce((sum: number, item: any) => sum + (item.value_dollars || 0), 0);
  return `
<section class="lp-section">
  <p class="section-label">What's included</p>
  <h2 class="section-heading">Everything you get</h2>
  <div class="offer-list">
    ${items.map((item) => `
    <div class="offer-item">
      <div class="offer-item__text">
        <div class="offer-item__title">${esc(item.title)}</div>
        <div class="offer-item__value">${esc(item.value_line)}</div>
      </div>
      ${item.value_dollars ? `<div class="offer-item__dollars">$${item.value_dollars}</div>` : ''}
    </div>`).join('')}
  </div>
  ${total > 0 ? `<p style="text-align:right;margin-top:16px;font-size:14px;color:var(--muted)">Total value: <strong style="color:var(--ink)">$${total.toLocaleString()}</strong></p>` : ''}
</section>`;
}

function renderGuarantee(payload: Record<string, unknown>): string {
  const days = payload.days ? Number(payload.days) : null;
  return `
<section class="lp-section">
  <div class="guarantee-card">
    ${days ? `<div class="guarantee-card__days">${days}</div><p style="color:var(--muted);font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:16px">Day Guarantee</p>` : ''}
    <h2 class="guarantee-card__title">${esc(String(payload.title || ''))}</h2>
    <p class="guarantee-card__body">${markdownLight(String(payload.body || ''))}</p>
  </div>
</section>`;
}

function renderSection(
  section: CoachLandingPageSection,
  page: CoachLandingPage,
  packages: CoachPackage[],
  coachSlug: string,
  pageSlug: string,
): string {
  const payload = (section.payload as Record<string, unknown>) || {};
  switch (section.kind) {
    case 'hero':
      return renderHero(payload, page, coachSlug, pageSlug);
    case 'before_after':
      return renderBeforeAfter(payload);
    case 'testimonials':
      return renderTestimonials(payload);
    case 'pricing':
      return renderPricing(payload, packages, coachSlug, pageSlug);
    case 'faq':
      return renderFaq(payload);
    case 'lead_form':
      return renderLeadForm(payload, coachSlug, pageSlug);
    case 'offer_stack':
      return renderOfferStack(payload);
    case 'guarantee':
      return renderGuarantee(payload);
    default:
      return '';
  }
}

// ─── Not Found ────────────────────────────────────────────────────────────────

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Page not found</title>
<style>
  :root{--ink:#1a1612;--paper:#faf8f5;--muted:#6b6259;--border:#e7e1d6;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    min-height:100vh;display:grid;place-items:center;padding:32px 20px;}
  .card{max-width:400px;width:100%;background:#fff;border:1px solid var(--border);border-radius:18px;padding:48px 32px;text-align:center;}
  .kicker{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-bottom:12px;}
  h1{font-family:"Playfair Display","Iowan Old Style",Georgia,serif;font-size:28px;font-weight:500;margin-bottom:12px;}
  p{color:var(--muted);font-size:15px;line-height:1.6;}
</style>
</head>
<body>
<div class="card">
  <p class="kicker">Coach landing page</p>
  <h1>This page isn't available.</h1>
  <p>The link may have expired or the coach has paused this page. Reach out to them directly for more information.</p>
</div>
</body>
</html>`;
}

// ─── Public page renderer ─────────────────────────────────────────────────────

export function renderPublicPage(
  page: PageWithContext,
  packages: CoachPackage[],
  coachSlug: string,
  baseUrl: string,
): string {
  const coach = page.coach;
  const profile = coach.coach_profile;
  const accent = sanitizeColor(page.accent_color || profile?.branding_accent_color);
  const canonicalUrl = `${baseUrl}/p/${coachSlug}/${page.slug}`;
  const businessName = profile?.business_name ?? null;
  const coachName = coach.name;

  const title = `${esc(page.headline)} — ${esc(businessName || coachName)}`;
  const description = page.subheadline || `Work with ${coachName} to reach your goals.`;

  // Schema.org JSON-LD — use safeJsonLd (not JSON.stringify) to prevent
  // </script> breakout inside the <script type="application/ld+json"> block.
  const jsonLd = safeJsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        name: coachName,
        jobTitle: 'Fitness Coach',
        url: canonicalUrl,
      },
      ...(businessName
        ? [
            {
              '@type': 'LocalBusiness',
              name: businessName,
              description: profile?.bio ?? undefined,
              url: canonicalUrl,
            },
          ]
        : []),
    ],
  });

  // Coach meta strip
  const logoHtml = profile?.branding_logo_url
    ? `<img class="coach-strip__logo" src="${escAttr(profile.branding_logo_url)}" alt="${esc(coachName)}" />`
    : '';
  const coachStrip = `
<header class="coach-strip">
  ${logoHtml}
  <div>
    <div class="coach-strip__name">${esc(coachName)}</div>
    ${businessName ? `<div class="coach-strip__biz">${esc(businessName)}</div>` : ''}
  </div>
</header>`;

  // Derive primary CTA href
  const primaryCtaHref =
    page.primary_cta_type === 'lead_form'
      ? '#contact'
      : page.primary_cta_type === 'checkout' && packages.length > 0
      ? `/p/${coachSlug}/${page.slug}/checkout?tier=${packages[0]?.id}`
      : '#pricing';

  // Render all sections
  const sectionsHtml = page.sections
    .map((s) => renderSection(s, page, packages, coachSlug, page.slug))
    .join('<hr class="lp-divider">');

  const body = `${coachStrip}${sectionsHtml}`;

  return baseDocument({
    title,
    description,
    accent,
    canonicalUrl,
    ogImage: page.hero_image_url,
    coachName,
    businessName,
    jsonLd,
    body,
    primaryCtaLabel: page.primary_cta_label,
    primaryCtaHref,
    template: page.template,
  });
}
