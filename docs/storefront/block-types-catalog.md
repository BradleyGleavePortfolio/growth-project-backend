# Block Types Catalog

Wave 9 / Storefront. Status: DRAFT. Docs only.

The canonical list of block types, their TypeScript shapes, JSON Schema, default values, max-instances per page, validation rules, and per-breakpoint behaviour. The block registry on both server and client must conform to this catalog; the registry hash (`block-editor-spec.md` Section 18.15) is computed from the contents of this file.

Companion files:
- `block-editor-spec.md` — editor that consumes the registry.
- `publishing-and-versioning.md` — how a tree of these blocks becomes a live page.
- `funnel-analytics.md` — per-block events.
- `integration-with-apps.md` — Custom-Block protocol.

---

## 1. Common shapes

Every block conforms to:

```ts
interface BaseBlock<P> {
  id: string;          // ULID
  type: BlockType;
  props: P;
  breakpointOverrides?: Partial<Record<Breakpoint, Partial<P>>>;
  visibility: { mobile: boolean; tablet: boolean; desktop: boolean };
  editScopeTag: string | null;
  analytics: boolean;
}
```

Each block type defines a `Props` interface and a corresponding JSON Schema for runtime validation.

### 1.1 Color values

All colors are 6-digit hex `^#[0-9a-fA-F]{6}$`. Colors are ALWAYS validated for 4.5:1 contrast against the page surface — block-level color overrides that fail contrast reject autosave with `BLOCK_PROPS_INVALID` (path `/props/color` or similar).

### 1.2 Money values

Per-block monetary fields use:

```ts
interface MoneyValue {
  amount: string;      // Decimal(14,2) as string, e.g. "29.00"
  currency: string;    // ISO-4217, e.g. "USD", "GBP", "EUR"
}
```

The page's `theme.locale` provides the formatting; the renderer uses ICU `NumberFormat`.

### 1.3 Image refs

```ts
interface ImageRef {
  imageId: string;        // Cloudflare Images id
  alt: string;            // <= 200 chars; required
  caption?: string;       // <= 200 chars; optional
  focalPoint?: { x: number; y: number };  // 0-1, for crop centroid
}
```

### 1.4 Link refs

```ts
interface LinkRef {
  href: string;           // Internal `/c/...` or absolute https
  label: string;          // <= 80 chars
  newTab: boolean;        // if true, renders `target=_blank rel="noopener noreferrer"`
  /** Tracked as cta.click in analytics if true. */
  trackCta: boolean;
}
```

### 1.5 Icon refs

```ts
type IconName =
  | "check" | "x" | "star" | "arrow-right" | "calendar"
  | "shield" | "trophy" | "user" | "zap" | "lock"
  | "play" | "heart" | "sparkles";
```

A fixed enum; v1 does not allow uploaded icons. Lucide icons under MIT.

### 1.6 Schema version annotation

Every block's `props` carries an internal `__schemaVersion: number` field. Clients should not edit it; the registry inserts it on insert and migrators bump it.

---

## 2. Hero

A primary above-the-fold block with headline, subhead, optional background image, optional CTA.

### Props

```ts
interface HeroProps {
  __schemaVersion: 1;
  headline: string;        // <= 120 chars
  subhead?: string;        // <= 240 chars
  background: {
    kind: "color" | "image" | "gradient";
    color?: string;        // when kind === "color" or "gradient"
    colorTo?: string;      // for "gradient" — second stop
    image?: ImageRef;      // when kind === "image"
    overlay?: { color: string; opacity: number };  // 0..1
  };
  alignment: "left" | "center";
  cta?: LinkRef | null;
  size: "sm" | "md" | "lg" | "xl";   // affects vertical padding & headline size
}
```

### JSON Schema (excerpt)

```json
{
  "type": "object",
  "required": ["__schemaVersion", "headline", "background", "alignment", "size"],
  "properties": {
    "__schemaVersion": { "const": 1 },
    "headline": { "type": "string", "minLength": 1, "maxLength": 120 },
    "subhead":  { "type": "string", "maxLength": 240 },
    "background": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": { "enum": ["color", "image", "gradient"] },
        "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "colorTo": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
        "image": { "$ref": "#/$defs/ImageRef" },
        "overlay": {
          "type": "object",
          "properties": {
            "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
            "opacity": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        }
      }
    },
    "alignment": { "enum": ["left", "center"] },
    "cta": { "anyOf": [{ "$ref": "#/$defs/LinkRef" }, { "type": "null" }] },
    "size": { "enum": ["sm", "md", "lg", "xl"] }
  }
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  headline: "Your transformation starts here.",
  subhead: "1:1 coaching for serious clients.",
  background: { kind: "color", color: "#0E1116" },
  alignment: "left",
  cta: { href: "#apply", label: "Apply", newTab: false, trackCta: true },
  size: "lg",
}
```

### Mobile defaults

`size: "md"` (smaller headline on mobile by default), `alignment: "left"` (centered headlines look cramped on 375px).

### Validation rules (cross-field)

- `background.kind === "image"` requires `background.image.imageId`. Else 422.
- `background.kind === "gradient"` requires both `color` and `colorTo`. Else 422.
- `headline` must not be empty whitespace.
- If `cta` is set, `cta.label` must be present.
- `size === "xl"` rejected on mobile breakpoint override (too tall on a 667px screen).

### Max instances per page

1 per page (one Hero, the first impression). Attempting to add a second 422s `BLOCK_TYPE_LIMIT`.

### Render notes

- SSR: emits a `<section>` with `aria-labelledby` referencing the headline `<h1>`.
- Headline uses `<h1>` if it's the first Hero on the page; subsequent uses become `<h2>` (only one h1 per page for SEO).
- Background image is responsive — `srcset` with three widths matching breakpoints.

---

## 3. CTA

A standalone call-to-action block. Different from `Hero.cta` in that it stands alone; useful below testimonials or pricing.

### Props

```ts
interface CtaProps {
  __schemaVersion: 1;
  label: string;        // <= 80 chars
  href: string;         // internal or absolute https
  variant: "primary" | "secondary" | "ghost";
  size: "sm" | "md" | "lg";
  alignment: "left" | "center" | "right";
  newTab: boolean;
  /** Optional descriptor below the button. <= 160 chars. */
  caption?: string;
  /** Optional icon left of label. */
  icon?: IconName;
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  label: "Apply",
  href: "/c/<slug>/apply",  // resolved at render time using the page's slug
  variant: "primary",
  size: "md",
  alignment: "center",
  newTab: false,
}
```

### Max instances per page

10 per page. (Many CTAs hurt conversion; we don't enforce a smaller cap, but the content guidance in editor recommends 1-3.)

### Validation

- `href` matches one of:
  - `^/.*` (relative internal)
  - `^https://...$` (absolute https; host not on the blocklist)
  - `#<id>` (fragment, scrolls to a same-page section)
- `label.trim().length >= 1`.
- `variant === "primary"` MUST contrast 4.5:1 against `theme.colorSurface`; this is checked at publish time.
- If `href` is absolute and `newTab === false`, editor surfaces a soft warning "External links usually open in a new tab"; not a hard reject.

### Render notes

- Renders as `<a class="...">` with theme tokens.
- Click fires `cta.click` event with `{blockId, label, href}`.

---

## 4. RichText

A formatted text block. The only block type that supports inline formatting beyond the field-level structure.

### Props

```ts
interface RichTextProps {
  __schemaVersion: 1;
  /** Sanitised HTML. Allowed tags: p, ul, ol, li, h2-h6, a, strong, em, blockquote. */
  html: string;
  /** Visible alignment. */
  alignment: "left" | "center";
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  html: "<p>Tell your story here.</p>",
  alignment: "left",
}
```

### Validation

- `html.length <= 10000` chars.
- Server-side: re-runs DOMPurify with the strict allowlist. Any disallowed tag/attr is stripped silently and the block is saved with the sanitised content.
- No `<style>`, no inline `style=`, no `on*=`, no `javascript:` hrefs.
- `<a href>` must be relative or absolute https.
- Image tags `<img>` are NOT allowed in RichText; use the Image block.

### Max instances per page

10 per page.

### Render notes

- SSR escapes once; client never re-parses.
- Headings auto-numbered for SEO landmarks (h2 / h3 / h4 sequence preserved).

---

## 5. Image

A standalone image. Used for inline content, brand shots, screenshots.

### Props

```ts
interface ImageProps {
  __schemaVersion: 1;
  image: ImageRef;
  /** Display width — % of section. */
  width: "25" | "50" | "75" | "100";
  /** Aspect ratio; null = native. */
  aspect: "1:1" | "4:3" | "16:9" | "3:4" | null;
  /** Optional click target. */
  link?: LinkRef | null;
  /** Optional caption rendered below. <= 200 chars. */
  caption?: string;
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  image: { imageId: "", alt: "" }, // editor flags imageId === "" as "needs upload"
  width: "100",
  aspect: null,
}
```

### Validation

- `image.imageId.length > 0` at autosave time? — NO. Empty image is a valid draft state. Publish-time however requires `imageId !== ""`.
- `image.alt.length >= 1` required at PUBLISH time. Decorative-image case is supported by `alt: ""` but the editor flags it as "is this image decorative?" before allowing publish. (a11y hard requirement.)
- Max upload 2 MB; pre-flight client-side. See `block-editor-spec.md` Section 18.6.

### Max instances per page

20 per page.

### Render notes

- `<img loading="lazy" decoding="async" srcset="..." sizes="..." alt="...">`.
- Renderer composes Cloudflare Images URL with width matching breakpoint.
- If `link` set, wrapped in an `<a>` with click tracking.

---

## 6. Pricing-Table

A pricing table with one or more tiers. Connects to Stripe Checkout via Wave 5.

### Props

```ts
interface PricingTableProps {
  __schemaVersion: 1;
  /** 1-3 tiers. */
  tiers: PricingTier[];
  /** Toggle to show monthly vs annual. */
  cadenceToggle: boolean;
  /** Default cadence if toggle hidden. */
  defaultCadence: "monthly" | "annual";
  /** Section heading. */
  heading?: string;       // <= 80
  subheading?: string;    // <= 200
}

interface PricingTier {
  id: string;             // ULID, stable per tier
  name: string;           // e.g. "Starter", "Pro"
  description?: string;   // <= 200
  /** Prices keyed by cadence. */
  prices: {
    monthly?: MoneyValue;
    annual?: MoneyValue;
  };
  /** Stripe Price IDs (one per cadence). */
  stripePriceIds: {
    monthly?: string;
    annual?: string;
  };
  /** Bullet-list features. */
  features: { icon: IconName; text: string }[];   // 1-15
  /** Optional badge above the tier. */
  badge?: string;         // <= 24
  /** "Buy" or "Apply" — see render notes. */
  ctaKind: "buy" | "apply";
  /** Override the CTA label. */
  ctaLabel?: string;
  /** Highlight as the "recommended" tier. */
  highlighted: boolean;
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  tiers: [
    {
      id: "01HXTIER1...",
      name: "Coaching",
      description: "1:1 coaching with weekly checkins.",
      prices: { monthly: { amount: "297.00", currency: "USD" } },
      stripePriceIds: {},
      features: [
        { icon: "check", text: "Weekly 1:1 video call" },
        { icon: "check", text: "Custom programme" },
        { icon: "check", text: "Direct messaging support" },
      ],
      ctaKind: "apply",
      highlighted: true,
    },
  ],
  cadenceToggle: false,
  defaultCadence: "monthly",
}
```

### Validation

- 1-3 tiers per block.
- Each tier requires at least one of `prices.monthly` or `prices.annual`.
- `prices.monthly.currency === prices.annual.currency` (no mixed-currency tier).
- `prices.annual.amount >= prices.monthly.amount * 10` is a SOFT warning (not a reject) — encourages a real annual discount but doesn't enforce.
- `ctaKind === "buy"` requires `stripePriceIds[<cadence>]` to be set; else publish 422.
- `ctaKind === "apply"` does not need Stripe.
- `features.length` between 1 and 15.

### Max instances per page

3 per page.

### Render notes

- SSR emits `<table>` semantics ONLY if 2+ tiers; single tier is `<article>`.
- "Buy" CTA constructs `https://checkout.stripe.com/...` URL via Stripe Connect; URL includes `attribution_token` from the visitor cookie (Wave 7).
- "Apply" CTA links to `/c/<slug>/apply?tier=<tierId>` — the application form is then pre-filled with the tier.
- Cadence toggle is a client-side state; both monthly and annual prices are SSR-rendered, hidden via CSS.

---

## 7. Testimonial

A single testimonial. Multiple Testimonial blocks form a "wall".

### Props

```ts
interface TestimonialProps {
  __schemaVersion: 1;
  quote: string;          // 20..600 chars
  authorName: string;     // <= 80
  authorTitle?: string;   // <= 120 — e.g. "Squat coach client, 6 months"
  authorImage?: ImageRef; // small avatar
  /** Optional star rating (1-5). */
  rating?: 1 | 2 | 3 | 4 | 5;
  /** Optional verification badge. */
  verified: boolean;
  layout: "card" | "quote-block" | "minimal";
}
```

### Defaults

```ts
{
  __schemaVersion: 1,
  quote: "Working with this coach changed how I approach training.",
  authorName: "First L.",
  rating: 5,
  verified: false,
  layout: "card",
}
```

### Validation

- `quote.length >= 20` required (avoid one-word "noise" testimonials).
- `verified === true` ALLOWED only if the testimonial is sourced from a `Review` row — see Section 14 (Reviews-Display) for the data shape. Setting `verified: true` without a backing row 422s `TESTIMONIAL_NOT_VERIFIED`.
- `authorImage` optional but recommended; renders default initials avatar if missing.

### Max instances per page

20 per page.

### Render notes

- Verified badge renders only when `verified: true` AND the audit confirmed at publish time. Otherwise the badge silently drops (no editor error, but also no badge — coaches see the block in editor with the badge ghosted).
- Doctrine: this block does NOT support fake-quote auto-fill. Editor inputs are blank by default and require the coach to type the real quote.

---

## 8. FAQ

Accordion of question/answer pairs.

### Props

```ts
interface FaqProps {
  __schemaVersion: 1;
  heading?: string;
  items: { id: string; question: string; answer: string }[];   // 1-50
  /** Default open state. */
  defaultOpen: "first" | "all" | "none";
  /** Layout. */
  variant: "accordion" | "two-column";
}
```

### Validation

- `items.length` 1..50.
- `question.length` <= 200.
- `answer.length` <= 1500. Plain text only (no rich text in v1; if rich text needed, use RichText block above the FAQ).
- All `id`s unique within the block.

### Max instances per page

5 per page.

### Render notes

- SSR emits `<details><summary>` for kbd/screen-reader friendliness.
- Each Q is wrapped with `itemtype="https://schema.org/FAQPage"` for SEO.
- Auto-emits `cta.click` with `kind="faq.expand"` on item open, if `analytics: true`.

---

## 9. Programs-Grid

A grid of `Program` rows owned by the coach. Reads live from `Program` table.

### Props

```ts
interface ProgramsGridProps {
  __schemaVersion: 1;
  heading?: string;
  /** Filter — null = all programs. */
  programIds: string[] | null;
  /** Sort order. */
  order: "manual" | "newest" | "popular" | "alphabetical";
  /** Items per row at desktop. */
  columns: 2 | 3 | 4;
  /** Card style. */
  cardVariant: "image-top" | "image-side";
  /** Show price on card. */
  showPrice: boolean;
  /** CTA label per card. */
  ctaLabel: string;
  /** Filter to active programs only. */
  activeOnly: boolean;
}
```

### Validation

- If `order === "manual"` then `programIds` must be a non-null ordered list of programs.
- All `programIds` must reference programs the coach actually owns at publish time; mismatched ids 422 `PROGRAM_NOT_OWNED`.
- `columns: 4` rejected if `cardVariant === "image-side"` (cards too narrow).

### Max instances per page

3 per page.

### Render notes

- Renderer reads programs from a cached view (`coach_programs_view`, 5-min TTL). On publish, view is refreshed for that coach.
- Card click goes to `/c/<slug>/p/<program-slug>` — the per-program sub-page (also a storefront-rendered tree owned by the coach).

---

## 10. Schedule-Widget

Live-availability calendar widget. Reads cohort start dates from Wave 2's `Cohort` rows.

### Props

```ts
interface ScheduleWidgetProps {
  __schemaVersion: 1;
  heading?: string;
  /** Cohorts to surface. */
  cohortIds: string[];
  /** How far ahead to show. */
  windowDays: 30 | 60 | 90;
  /** Time zone displayed. null = visitor's local tz. */
  displayTimezone: string | null;     // IANA, e.g. "America/New_York"
  /** What clicking a slot does. */
  onSlotClick: "apply" | "book";
  /** Booking provider URL — Calendly et al. */
  bookingUrl?: string;
  /** Layout. */
  variant: "compact" | "calendar";
}
```

### Validation

- `cohortIds` <= 5 items; >5 starts to look noisy.
- All cohorts must belong to the coach.
- If `onSlotClick === "book"` then `bookingUrl` must be set, must match the embed allowlist (see Section 16).
- If `displayTimezone` set, must be a valid IANA TZ name.

### Max instances per page

2 per page.

### Render notes

- SSR with the visitor's tz inferred from `Accept-Language` and IP geolocation; CSR upgrade on hydrate using `Intl.DateTimeFormat`.
- Cohort start dates fetched at SSR time and cached 5 minutes per coach.
- "Apply" mode submits a form with `cohortId` pre-filled.

---

## 11. About

A coach-bio block. Text + image.

### Props

```ts
interface AboutProps {
  __schemaVersion: 1;
  heading?: string;
  body: string;        // plain text, <= 2000 chars; for RichText use the RichText block alongside
  image?: ImageRef;
  layout: "image-left" | "image-right" | "image-top" | "no-image";
  /** Optional credentials — bullet list. */
  credentials?: { icon: IconName; text: string }[];   // <= 8
  /** Optional CTA. */
  cta?: LinkRef | null;
}
```

### Validation

- `body.length >= 1`.
- If `layout` includes "image-*" then `image.imageId` must be set at publish time.

### Max instances per page

2 per page.

---

## 12. Reviews-Display

Reads from authenticated `Review` rows; this is the only "social proof" surface that supports verified badges.

### Props

```ts
interface ReviewsDisplayProps {
  __schemaVersion: 1;
  heading?: string;
  /** Optional filter — by program. */
  programId?: string;
  /** Number to show. */
  limit: 3 | 5 | 10 | 20;
  /** Sort. */
  order: "newest" | "highest" | "most-relevant";
  /** Layout. */
  layout: "carousel" | "grid" | "list";
  /** Whether to show the rating in a header (e.g. "4.9 / 5 — 87 reviews"). */
  showSummary: boolean;
}
```

### Data source

`Review` rows joined to `Client` rows joined to `Purchase` rows. A review without a backing purchase is invisible — not just hidden, but the block treats it as if it doesn't exist. This is enforced server-side: the renderer's data fetcher filters `WHERE Purchase.id IS NOT NULL AND Purchase.refundedAt IS NULL`.

### Validation

- `programId` must be owned by the coach if set.
- `limit <= 20`.

### Max instances per page

2 per page.

### Render notes

- "4.9 / 5 — 87 reviews" header derived from the same query, no inflation.
- If 0 reviews exist, the block renders empty (zero space, not even a heading). This avoids "we have no reviews yet" being a flag for skepticism.
- Doctrine: there is NO ability to "feature a review" or hide bad reviews per-block. If a coach wants to hide a 1-star review, they appeal at the platform-level (separate flow, not Wave 9).

---

## 13. Embed

Embed allowlisted third-party content.

### Props

```ts
interface EmbedProps {
  __schemaVersion: 1;
  /** Provider key — drives the iframe parameters. */
  provider:
    | "youtube"
    | "vimeo"
    | "loom"
    | "calendly"
    | "stripe-checkout"
    | "typeform";
  /** The provider-specific URL or id. */
  url: string;
  /** Aspect ratio; provider-default if null. */
  aspect: "16:9" | "4:3" | "1:1" | null;
  /** Section heading. */
  heading?: string;
}
```

### Allowlist (server-side enforced)

| provider          | URL pattern                                                    |
|-------------------|----------------------------------------------------------------|
| youtube           | `^https://(www\.)?youtube\.com/embed/[A-Za-z0-9_-]+$`          |
| vimeo             | `^https://player\.vimeo\.com/video/\d+$`                       |
| loom              | `^https://(www\.)?loom\.com/embed/[a-f0-9]+$`                  |
| calendly          | `^https://calendly\.com/[A-Za-z0-9_-]+(/.+)?$`                 |
| stripe-checkout   | `^https://buy\.stripe\.com/[A-Za-z0-9_-]+$`                    |
| typeform          | `^https://.+\.typeform\.com/to/[A-Za-z0-9_-]+$`                |

Out-of-allowlist URLs return `EMBED_NOT_ALLOWED`. The editor surfaces the same allowlist as a hint when the user starts typing.

### Validation

- `provider` and `url` must match.
- `url` does not contain `<script>`, `javascript:`, etc. (defence in depth, even though pattern matches.)

### Max instances per page

5 per page.

### Render notes

- Each `<iframe>` carries `loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
- Wave 9 enforces `sandbox`; YouTube and Vimeo work with this set.
- Stripe-checkout is rendered as a `<a href>` not an iframe (Stripe doesn't support iframe checkout cleanly).

---

## 14. Custom-Block

A Wave 6 app-declared custom block. Loaded in an iframe sandbox; postMessage protocol per `integration-with-apps.md`.

### Props

```ts
interface CustomBlockProps {
  __schemaVersion: 1;
  /** App manifest id. */
  manifestId: string;
  /** Per-app schema; opaque to the catalog. */
  appProps: Record<string, unknown>;
  /** Permission scopes — must subset the manifest's declared scopes. */
  permissions: string[];
}
```

### Validation

- `manifestId` must be installed for this coach (see `Coach.installed_apps`).
- `permissions` must subset `manifest.declared_permissions`.
- `appProps` must validate against the manifest's `propsSchema` (delegated to the apps platform).

### Max instances per page

10 per page; the apps platform may further constrain via `manifest.maxInstancesPerPage`.

### Render notes

- See `integration-with-apps.md` Section 4 for the iframe sandbox contract.
- If the iframe fails to load or postMessage handshake times out, render a fallback `<div>App {name} unavailable</div>`. Coach is notified via the broken-link nightly job (Section F6 of editor spec).

---

## 15. Block matrix summary

| type             | maxPerPage | required by publish-time?            | analytics-default | mobile-friendly?    |
|------------------|-----------:|--------------------------------------|-------------------|---------------------|
| hero             | 1          | yes (default exists)                 | true              | yes (size: md)      |
| cta              | 10         | no                                   | true              | yes                 |
| rich-text        | 10         | no                                   | true              | yes                 |
| image            | 20         | no                                   | true              | yes                 |
| pricing-table    | 3          | no, but recommended for conversion   | true              | yes (stacks)        |
| testimonial      | 20         | no                                   | true              | yes                 |
| faq              | 5          | no                                   | true              | yes                 |
| programs-grid    | 3          | no (renders empty if 0 programs)     | true              | yes (1-col)         |
| schedule-widget  | 2          | no                                   | true              | yes (compact)       |
| about            | 2          | no                                   | true              | yes                 |
| reviews-display  | 2          | no                                   | true              | yes                 |
| embed            | 5          | no                                   | true              | yes (16:9 default)  |
| custom-block     | 10         | no                                   | per-manifest      | per-manifest        |

---

## 16. Image policy (cross-cutting)

- Allowed types: JPEG, PNG, WebP, AVIF, GIF (static or animated). Server transcodes everything to WebP + AVIF on upload.
- Max bytes: 2 MB original. Server-side rejects >4 MB; client pre-flight rejects >2 MB and offers compression.
- Max dimensions: 4096x4096. Larger rejected (`IMAGE_DIM_TOO_LARGE`).
- Animated GIFs allowed in Image and Hero blocks; auto-converted to silent autoplay-loop MP4 by Cloudflare for size win.
- All images served via Cloudflare Images signed-URL conventions (OWNER_DECISION-4).

EXIF: Cloudflare strips EXIF on upload. No GPS coords in storefront images.

---

## 17. Embed policy (cross-cutting)

- Allowlist enforced server-side; client UX surfaces the same.
- All iframes sandboxed; `allow-scripts allow-same-origin allow-forms allow-popups` is the only allowed sandbox set.
- No `allow-top-navigation`. Embedded providers cannot navigate the storefront window.
- Embed `<iframe>` carries `referrerpolicy="strict-origin-when-cross-origin"` to avoid leaking the storefront URL beyond what the provider needs.
- `Content-Security-Policy: frame-src` lists exactly the allowlisted hosts.

---

## 18. Color policy (cross-cutting)

- Theme `colorBrand` MUST contrast 4.5:1 against `theme.colorSurface`. Otherwise publish rejected with `CONTRAST_FAIL`.
- Per-block color overrides (e.g. CTA `variant: "primary"` background) inherit theme tokens; coaches CANNOT pick arbitrary per-block colors. v2 may relax this; v1 keeps brand-coherent storefronts.
- Reviews-Display rating stars use theme `colorBrand` if present, else fall back to a neutral gold.

---

## 19. Per-breakpoint behaviours summary

For brevity, behaviours are described per type:

- **Hero** — image background full-width on desktop; on mobile, image gets `object-fit: cover` cropping to focal point. Headline auto-resizes via `clamp()`.
- **CTA** — full-width on mobile (cap 480px); auto-width on tablet/desktop.
- **RichText** — same on all breakpoints; line-length capped at 72ch on desktop.
- **Image** — `width: "50"` becomes 100% on mobile (50% on tablet & desktop).
- **Pricing-Table** — 3 tiers stack vertically on mobile; 2 tiers side-by-side on tablet; up to 3 side-by-side on desktop.
- **Testimonial** — `layout: "card"` stacks; `layout: "quote-block"` keeps fontSize but reduces padding on mobile.
- **FAQ** — `variant: "two-column"` falls back to single-column on mobile.
- **Programs-Grid** — `columns: 4` becomes 2 on tablet, 1 on mobile.
- **Schedule-Widget** — `variant: "calendar"` becomes `compact` on mobile (calendar takes too much screen).
- **About** — `layout: "image-left/right"` becomes `image-top` on mobile.
- **Reviews-Display** — `layout: "grid"` becomes `list` on mobile.
- **Embed** — aspect preserved; width 100%.
- **Custom-Block** — fully delegated to the iframe's own responsiveness; the host enforces a min/max height set by the manifest.

---

## 20. Migration index

Each block type has a `__schemaVersion`. As of this spec, all blocks are at version 1. The migrator registry (per-type) is:

```ts
type Migrator = (props: any) => any;
const migrators: Record<BlockType, Record<number, Migrator>> = {
  hero: { 1: identity },
  cta: { 1: identity },
  "rich-text": { 1: identity },
  image: { 1: identity },
  "pricing-table": { 1: identity },
  testimonial: { 1: identity },
  faq: { 1: identity },
  "programs-grid": { 1: identity },
  "schedule-widget": { 1: identity },
  about: { 1: identity },
  "reviews-display": { 1: identity },
  embed: { 1: identity },
  "custom-block": { 1: identity },
};
```

When a block schema bumps, add the new migrator and bump the `__schemaVersion` in the registry. Editor `block-editor-spec.md` Section 18.45 walks through an example.

---

## 21. Test plan

- Schema-validation unit tests: every required-field reject and every allowed-field round-trip.
- Cross-field validation: every rule in this catalog has a positive and negative test.
- Migration: identity migrators trivially pass; future migrators are tested with frozen JSON fixtures.
- Render: snapshot tests per block type at all 3 breakpoints, light + dark theme.
- a11y: each block, when rendered alone, passes axe core.
- Embed allowlist: 50 hostile URLs (variants of allowlisted providers, near-hits) — all rejected.

---

## 22. Common pitfalls per block

### 22.1 Hero
- "Hero with no background and no CTA looks empty." -> Editor surfaces a soft warning; not a reject.
- Coaches over-stuff the headline. The 120-char cap is generous but the editor shows a "shorter wins" tooltip past 80 chars.
- Mobile: a 16:9 hero image at 100% width on a 375px screen is 211px tall. Coaches who upload portrait photos see the focal point auto-applied.

### 22.2 CTA
- The default `href: "/c/<slug>/apply"` resolves at render time using the page's slug. Coaches who edit the slug after dragging a CTA do NOT need to re-edit the CTA's href; the renderer always substitutes.
- Three CTAs in a row above the fold = bad pattern; editor shows a non-blocking nudge.
- `variant: "ghost"` on a low-contrast theme is hard to see — the contrast check at publish time covers this.

### 22.3 RichText
- Pasting from Google Docs frequently brings inline `style=` and `<span class="font-...">`. DOMPurify strips these silently. Coaches sometimes complain that "it doesn't look the same" — the editor shows a one-time toast on first paste.
- Headings should start at h2 (page already has h1 from Hero). Editor's heading dropdown only offers h2-h6.
- Do not embed `<img>` in RichText; the resulting alt-text is not auditable. Use an Image block.

### 22.4 Image
- Coaches upload phone photos with EXIF GPS. We strip on upload. (Privacy.)
- Animated GIFs auto-convert to MP4. A coach who drags a 3MB GIF gets a 200KB silent looping video — usually wins.
- Setting `width: "100"` and `aspect: "16:9"` on a portrait photo crops aggressively. Editor shows the focal-point picker.

### 22.5 Pricing-Table
- "Why is my Buy CTA 422?" — `stripePriceIds` not set. Editor surfaces this as a yellow chip on the tier card.
- Cadence toggle hides one of the prices via CSS at runtime; SSR delivers both. SEO sees both prices, which is correct.
- A coach who changes their currency after first save: the editor blocks save with `MIXED_CURRENCY` until all tiers agree.

### 22.6 Testimonial
- "Verified" badge requires a backing `Review`. Coaches without reviews use unverified testimonials; this is fine but the editor surfaces a soft "consider asking real clients" nudge.
- Quote >600 chars truncates with "Read more" affordance on mobile.
- Doctrine: the editor will NOT auto-fill a testimonial from an LLM. Coaches type the real words.

### 22.7 FAQ
- Long answers (>1500 chars) reject. Editor surfaces this in real time.
- Two-column layout looks empty with <4 items; editor recommends accordion below 4.
- Auto-emit of `cta.click` on item open is opt-in (`analytics: true`); some coaches turn it off because their FAQ items don't represent intent.

### 22.8 Programs-Grid
- "Manual" order means the coach drags programs into a sequence. Adding a new program after publish requires republish. The editor shows "1 program added — drag to position then publish."
- 4 columns on a 1280px desktop = 320px / column = tight. Editor shows a preview-warning.

### 22.9 Schedule-Widget
- Cohort dates change. The renderer reads live; the SSR cache has 5-min TTL so a coach changing a cohort date sees it within 5 minutes (or immediately if they republish).
- Booking via Calendly: the editor pre-fills `bookingUrl` if the coach has connected Calendly via Wave 6 manifest.

### 22.10 About
- `layout: "no-image"` is fine but the editor recommends an image; coach photos increase conversion.
- `body` is plain text; coaches asking for bullet lists get nudged to RichText block above the About.

### 22.11 Reviews-Display
- Empty state is silent (no "Reviews coming soon" placeholder). This is intentional — see Section 12.
- `programId` filter when the program has zero reviews: same silent empty state. Editor shows "0 reviews match" in the inspector so the coach knows.

### 22.12 Embed
- `https://youtu.be/...` short URLs FAIL the allowlist (only `youtube.com/embed/...`). Editor auto-rewrites short URLs to embed form.
- `https://calendly.com/<user>` works; the iframe pulls in the schedule.
- Stripe-checkout: the rendered link goes to the Stripe-hosted page; we do NOT iframe Stripe Checkout.

### 22.13 Custom-Block
- `manifestId` not installed -> 422 at autosave. Editor offers "Install <app>" link.
- Permission scope mismatch -> 422; editor surfaces what scopes the manifest declares vs. what the block requests.
- Iframe load timeout -> placeholder. Coach is notified to re-test or remove.

---

## 23. Worked example: a typical coach storefront tree

```jsonc
{
  "id": "01HXPAGE...",
  "coachId": "01HXCOACH...",
  "slug": "bradley-g-fitness",
  "meta": {
    "title": "Bradley G Fitness — 1:1 strength coaching",
    "description": "Custom strength programmes for serious lifters. 12-week minimums, weekly checkins.",
    "ogImage": "img_OG123",
    "canonical": null,
    "favicon": "img_FAV1",
    "noindex": false
  },
  "theme": {
    "colorBrand": "#FF7A00",
    "colorText": "#0E1116",
    "colorSurface": "#FFFFFF",
    "font": "inter",
    "radius": "md",
    "density": "comfortable"
  },
  "sections": [
    {
      "id": "01HXSECT1",
      "layout": "single-column",
      "background": { "kind": "solid", "value": "#0E1116" },
      "visibility": { "mobile": true, "tablet": true, "desktop": true },
      "blocks": [
        {
          "id": "01HXBLOCK1",
          "type": "hero",
          "props": {
            "__schemaVersion": 1,
            "headline": "Build the strongest version of yourself.",
            "subhead": "12-week strength programmes. 1:1 coaching. Weekly video calls.",
            "background": { "kind": "image", "image": { "imageId": "img_HERO", "alt": "Coach Bradley spotting a deadlift" } },
            "alignment": "left",
            "size": "lg",
            "cta": { "href": "#apply", "label": "Apply now", "newTab": false, "trackCta": true }
          },
          "visibility": { "mobile": true, "tablet": true, "desktop": true },
          "editScopeTag": null,
          "analytics": true
        }
      ]
    },
    {
      "id": "01HXSECT2",
      "layout": "single-column",
      "background": { "kind": "solid", "value": "#FFFFFF" },
      "visibility": { "mobile": true, "tablet": true, "desktop": true },
      "blocks": [
        {
          "id": "01HXBLOCK2",
          "type": "about",
          "props": {
            "__schemaVersion": 1,
            "heading": "About me",
            "body": "I've coached 800+ lifters in the last 6 years. I focus on big-three lifts and structured progression.",
            "image": { "imageId": "img_ABOUT", "alt": "Coach Bradley in the gym" },
            "layout": "image-left",
            "credentials": [
              { "icon": "trophy", "text": "USAPL national qualifier" },
              { "icon": "shield", "text": "NSCA-CPT" }
            ]
          },
          "visibility": { "mobile": true, "tablet": true, "desktop": true },
          "editScopeTag": null,
          "analytics": true
        }
      ]
    },
    {
      "id": "01HXSECT3",
      "layout": "single-column",
      "background": { "kind": "solid", "value": "#F4F5F7" },
      "visibility": { "mobile": true, "tablet": true, "desktop": true },
      "blocks": [
        {
          "id": "01HXBLOCK3",
          "type": "pricing-table",
          "props": {
            "__schemaVersion": 1,
            "heading": "Pick your level",
            "tiers": [
              {
                "id": "01HXTIER_S",
                "name": "Starter",
                "description": "Self-led plan with monthly check-ins.",
                "prices": { "monthly": { "amount": "97.00", "currency": "USD" } },
                "stripePriceIds": { "monthly": "price_S1" },
                "features": [
                  { "icon": "check", "text": "12-week programme" },
                  { "icon": "check", "text": "Monthly form review" }
                ],
                "ctaKind": "buy",
                "highlighted": false
              },
              {
                "id": "01HXTIER_P",
                "name": "Pro 1:1",
                "description": "Weekly 1:1 with full programme customisation.",
                "prices": { "monthly": { "amount": "297.00", "currency": "USD" } },
                "stripePriceIds": {},
                "features": [
                  { "icon": "check", "text": "Weekly 1:1 video call" },
                  { "icon": "check", "text": "Custom programming" },
                  { "icon": "check", "text": "Direct messaging" }
                ],
                "ctaKind": "apply",
                "highlighted": true
              }
            ],
            "cadenceToggle": false,
            "defaultCadence": "monthly"
          },
          "visibility": { "mobile": true, "tablet": true, "desktop": true },
          "editScopeTag": null,
          "analytics": true
        }
      ]
    }
  ],
  "cycleVersion": 17,
  "updatedAt": "2026-05-01T12:34:56Z",
  "locale": "en-US",
  "editScope": null
}
```

A senior engineer reading this should see: theme tokens live at page level; sections segregate visual chunks; each block is typed and validated independently; ids are ULIDs; nothing is rendered without going through a registered renderer.

---

## 24. Block-action analytics impacts

| Block             | Default events fired (when `analytics: true`)                        |
|-------------------|----------------------------------------------------------------------|
| hero              | `block.impression`; CTA fires `cta.click`.                           |
| cta               | `block.impression`, `cta.click` on click.                            |
| rich-text         | `block.impression`.                                                  |
| image             | `block.impression`; if `link` set, `cta.click` on click.             |
| pricing-table     | `block.impression`, `pricing.cadence_toggle` if toggled, `cta.click` per tier. |
| testimonial       | `block.impression`.                                                  |
| faq               | `block.impression`, `faq.expand` per item if `analytics`.            |
| programs-grid     | `block.impression`, `cta.click` per card.                            |
| schedule-widget   | `block.impression`, `schedule.slot_click`.                           |
| about             | `block.impression`; CTA fires `cta.click`.                           |
| reviews-display   | `block.impression`.                                                  |
| embed             | `block.impression`, `embed.play` when supported (YouTube, Vimeo).    |
| custom-block      | per-manifest contract; minimum `block.impression`.                   |

See `funnel-analytics.md` Section 4 for the full event taxonomy and payloads.

---

## 25. Editor inspector field maps (per block)

For implementation reference; field types defined in `block-editor-spec.md` Section 18.28.

### Hero
- `headline` -> `text`
- `subhead` -> `textarea`
- `background.kind` -> `enum`
- `background.color` -> `color`
- `background.image` -> `image`
- `cta.href` -> `link`
- `cta.label` -> `text`
- `size` -> `enum`
- `alignment` -> `enum`

### CTA
- `label` -> `text`
- `href` -> `link`
- `variant` -> `enum`
- `size` -> `enum`
- `alignment` -> `enum`
- `newTab` -> `boolean`
- `caption` -> `text`
- `icon` -> `enum`

### RichText
- `html` -> rich-text editor (Tiptap with the strict schema)
- `alignment` -> `enum`

### Image
- `image` -> `image`
- `width` -> `enum`
- `aspect` -> `enum`
- `link` -> `link` (optional)
- `caption` -> `text`

### Pricing-Table
- per-tier card with sub-form: name (text), description (textarea), prices.monthly (money), prices.annual (money), features (repeating row of icon + text), ctaKind (enum), stripePriceIds.monthly (text), stripePriceIds.annual (text)
- `cadenceToggle` -> `boolean`
- `defaultCadence` -> `enum`

### Testimonial
- `quote` -> `textarea`
- `authorName` -> `text`
- `authorTitle` -> `text`
- `authorImage` -> `image`
- `rating` -> `enum`
- `verified` -> `boolean` (disabled if no backing review row)
- `layout` -> `enum`

(Other blocks follow the same pattern; for brevity, see the source-of-truth registry.)

---

## 26. CSS class map (high-level)

Public renderer emits stable BEM-ish class names so coaches with Custom-Block CSS overrides can target them:

```
.tgp-page
  .tgp-section
    .tgp-block.tgp-block--hero
      .tgp-hero__headline
      .tgp-hero__subhead
      .tgp-hero__cta
    .tgp-block.tgp-block--pricing-table
      .tgp-pricing-table__tier
        .tgp-pricing-table__name
        .tgp-pricing-table__price
        .tgp-pricing-table__features
        .tgp-pricing-table__cta
    ...
```

Coaches do NOT have a stylesheet override surface in v1; class names exist for our own SSR/CSR consistency. Wave 6 custom-blocks live in iframes and have their own DOM.

---

## 27. Open questions

None explicit to this catalog beyond the parent README OWNER decisions.

End of block-types-catalog.

