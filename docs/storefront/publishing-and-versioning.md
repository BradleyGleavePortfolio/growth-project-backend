# Publishing and Versioning

Wave 9 / Storefront. Status: DRAFT. Docs only.

This file specifies the lifecycle: draft -> preview -> publish, version snapshots, rollback, SSR/ISR rendering, sitemap, robots, OG/Twitter cards, favicon, and the cache invalidation contract that keeps `/c/{slug}` fast and fresh at 10k coach scale.

Companion files:
- `block-editor-spec.md` — what feeds the publish pipeline.
- `block-types-catalog.md` — what each block renders to.
- `funnel-analytics.md` — what fires when a published page is viewed.

---

## 1. Lifecycle overview

```
DRAFT  --(autosave 5s debounced)-->  DRAFT'  --(Preview)-->  PREVIEW (read-only iframe)
                                           --(Publish)-->   PUBLISHED v_n  -- live at /c/{slug}
PUBLISHED v_n --(Rollback to v_k)-->  new PUBLISHED v_{n+1} (=copy of v_k)
```

States:

- **DRAFT** — the latest autosaved tree. Lives in `StorefrontPage.draftTree`. Edited by the coach. Visible only via `/api/.../preview` and the editor.
- **PREVIEW** — same tree as DRAFT but rendered through the public renderer pipeline. NO analytics, NO checkouts, NO PII capture.
- **PUBLISHED** — an immutable snapshot in `StorefrontVersion`. The `StorefrontPage.publishedVerId` points at the latest published version. The public route `/c/{slug}` reads from it.

Hard rule: editing the draft does NOT affect the published page until the coach pressed Publish. There is no "auto-publish on save" mode.

---

## 2. Publish pipeline

```
1. Coach presses Publish.
2. Server validates the entire tree at "publish strictness":
     - All schema validation passes (same as autosave).
     - Cross-field validation passes.
     - Page-level publish gates pass:
        - Theme contrast 4.5:1.
        - Hero block exists.
        - Slug not on the phishing-adjacent list.
        - All Image refs have non-empty `imageId` and `alt` (a11y).
        - All Pricing-Table tiers with `ctaKind: "buy"` have valid `stripePriceIds`.
        - All Embed URLs match the allowlist.
        - All `programIds` (Programs-Grid) belong to the coach.
3. Server INSERT into StorefrontVersion: { id, pageId, versionNumber: prevMax + 1, tree, meta, theme, publishedBy, publishedAt }.
4. Server UPDATE StorefrontPage: publishedVerId = newVersionId, publishedAt = now().
5. Emit event publish.completed -> { coachId, pageId, versionId, slug }.
6. Cache invalidation:
     - Edge KV: SET `storefront:{slug}` -> serialised tree, TTL 5min.
     - Edge: PURGE every cached HTML at `/c/{slug}` and `/c/{slug}/p/*` (sub-pages).
     - CDN purge for OG image (Cloudflare Images cache).
     - Sitemap regenerator triggers.
     - 301 chain check: if slug changed since prior publish, write a 301 row in StorefrontSlugRedirect for old -> new (90-day retention).
7. Server returns 200 with publicUrl: https://growthproject.app/c/{slug}.
```

If step 2 fails, no version is written, no cache change. Returns 422 with the failure list.

If step 6 partially fails (e.g. cache-purge service offline), the publish is still considered succeeded — the next request to `/c/{slug}` will read the fresh KV value, not the stale CDN HTML, after the natural 5-min TTL. SREs are alerted; manual cache-purge is the recovery path.

---

## 3. Schema (illustrative)

The schema deltas from `block-editor-spec.md` Section 18.1 are repeated and extended here. Wave 9 (this PR) does NOT touch `prisma/schema.prisma`.

```prisma
model StorefrontPage {
  id              String   @id @default(cuid())
  coachId         String
  slug            String   @unique
  meta            Json
  theme           Json
  draftTree       Json
  draftCycleVer   Int      @default(0)
  publishedVerId  String?
  publishedAt     DateTime?
  deletedAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  coach           Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  publishedVer    StorefrontVersion? @relation("PublishedVersion", fields: [publishedVerId], references: [id])
  versions        StorefrontVersion[] @relation("AllVersions")
  locks           StorefrontEditLock[]
  redirects       StorefrontSlugRedirect[] @relation("OwnerPage")

  @@index([coachId])
  @@index([slug])
  @@index([deletedAt])
}

model StorefrontVersion {
  id              String   @id @default(cuid())
  pageId          String
  versionNumber   Int
  tree            Json
  meta            Json
  theme           Json
  publishedBy     String
  publishedAt     DateTime @default(now())
  rolledBackFromId String?
  note            String?

  page            StorefrontPage @relation("AllVersions", fields: [pageId], references: [id], onDelete: Cascade)
  publishedFor    StorefrontPage[] @relation("PublishedVersion")

  @@unique([pageId, versionNumber])
  @@index([pageId, publishedAt])
}

model StorefrontSlugRedirect {
  id              String   @id @default(cuid())
  pageId          String
  oldSlug         String
  newSlug         String
  createdAt       DateTime @default(now())
  expiresAt       DateTime  // createdAt + 90 days

  page            StorefrontPage @relation("OwnerPage", fields: [pageId], references: [id], onDelete: Cascade)

  @@index([oldSlug])
  @@index([expiresAt])
}
```

GDPR cascade: deleting a coach cascades to `StorefrontPage`, `StorefrontVersion`, `StorefrontEditLock`, `StorefrontSlugRedirect`. The slug becomes available again after the redirect's `expiresAt`. The published page returns 410 Gone immediately.

---

## 4. Version retention

Per OWNER_DECISION-5: keep the last 30 published versions per page.

Nightly job `prune_storefront_versions`:

```sql
WITH ranked AS (
  SELECT id, pageId, versionNumber,
         ROW_NUMBER() OVER (PARTITION BY pageId ORDER BY versionNumber DESC) AS rn
  FROM "StorefrontVersion"
)
UPDATE "StorefrontVersion"
SET "deletedAt" = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 30) AND "deletedAt" IS NULL;

DELETE FROM "StorefrontVersion"
WHERE "deletedAt" < NOW() - INTERVAL '30 days';
```

(Soft delete first, hard delete after 30 days. This buys a recovery window if a coach later needs an older version.)

The currently-published version is NEVER pruned, even if its versionNumber is far below the cutoff. (Edge case: a coach who publishes once and never publishes again has v=1; v=1 is preserved indefinitely.)

---

## 5. Preview

```
GET /api/storefront/pages/{pageId}/preview
Auth: coach session OR signed preview URL.
Response: full SSR HTML render of draftTree.
```

Preview is gated behind auth. Coaches share preview links via signed URLs:

```
POST /api/storefront/pages/{pageId}/preview/share
Auth: coach session.
Response: { url: "https://growthproject.app/preview/<token>", expiresAt: "..." }
```

- Token = JWT, signed with platform secret, claims: `{ pageId, cycleVersion, expiresAt }`.
- TTL: 24 hours from creation.
- Audit: `editor.preview.shared { pageId, byUserId, expiresAt }`.
- Preview pages emit `noindex, nofollow` meta and have `X-Robots-Tag: noindex` header. Crawlers MUST not index preview URLs.

Preview URLs work even for SUB_COACH (so they can show OWNER COACH their proposed change). They do NOT bypass any analytics opt-out — preview pages emit no analytics events at all.

---

## 6. Rollback

```
POST /api/storefront/pages/{pageId}/rollback
Body: { toVersionId: "v_K_id" }
Auth: storefront:publish.
Response: { newVersionId: "v_(N+1)_id", versionNumber: N+1, rolledBackFromId: "v_K_id" }
```

Mechanics:

1. Look up version `v_K`.
2. Migrate its tree to current schema (run all migrators forward).
3. INSERT a new version `v_{N+1}` with `tree = v_K.tree (migrated)`, `rolledBackFromId = v_K.id`, `note = "Rolled back to version K"`.
4. Update `StorefrontPage.publishedVerId = v_{N+1}.id`.
5. Same cache invalidation as a normal publish.

Why not just point `publishedVerId` back at `v_K`? Two reasons:

- Schema migrations may have invalidated the historical tree shape; we need a freshly-migrated copy.
- An auditable "current published version is N+1" is cleaner than "we time-travelled".

Audit: `editor.rollback { pageId, fromVersionId, toVersionId }`.

UI: version-history dropdown in editor (Section 18.27 of block-editor-spec) shows last 30 with publishedAt and publisher; clicking shows a confirmation modal "Roll back to version 12 (3 weeks ago, by Bradley)? This creates a new published version with that content."

---

## 7. SSR + ISR strategy (OWNER_DECISION-3 = C)

Choices:
- **A.** SSR every request — fresh, expensive at scale.
- **B.** Static export at publish — fast, stale on data changes (e.g. new program).
- **C.** ISR — render at publish, revalidate every 5 min OR on-demand on publish event. (Recommended.)

Implementation sketch (Cloudflare Workers + KV):

```ts
// edge worker pseudocode
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const slug = new URL(req.url).pathname.replace(/^\/c\//, "");
    const cacheKey = `storefront:${slug}`;
    const cached = await env.KV.get(cacheKey, "stream");
    if (cached) {
      // Serve cached HTML; stale-while-revalidate.
      const cacheTime = await env.KV.get(`${cacheKey}:t`);
      if (cacheTime && Date.now() - parseInt(cacheTime) < 5 * 60 * 1000) {
        return new Response(cached, { headers: HTML_HEADERS });
      }
      // Stale — kick off background refetch, serve stale.
      env.WORKER_QUEUE.send({ slug, kind: "refresh" });
      return new Response(cached, { headers: HTML_HEADERS });
    }
    // Cold cache — fetch from origin, store, serve.
    const origin = await fetch(`${env.ORIGIN}/internal/storefront/render?slug=${slug}`);
    const html = await origin.text();
    await env.KV.put(cacheKey, html, { expirationTtl: 600 });
    await env.KV.put(`${cacheKey}:t`, Date.now().toString(), { expirationTtl: 600 });
    return new Response(html, { headers: HTML_HEADERS });
  }
}
```

On publish, the origin pushes a KV write directly:

```ts
await env.KV.put(`storefront:${slug}`, freshHtml, { expirationTtl: 600 });
await env.KV.put(`storefront:${slug}:t`, Date.now().toString());
```

This way the next request after publish reads the fresh HTML; no 5-minute lag.

ISR fallback: if origin is down for a refresh, serve stale up to 1 hour (graceful degradation). Beyond 1 hour stale, serve a static "we're updating, back in a moment" page.

### 7.1 Cache key composition

`storefront:{slug}` is enough for the home page. Sub-pages: `storefront:{slug}:p:{programSlug}`. Variant cache keys for A/B (page-level OWNER_DECISION-2):

`storefront:{slug}:variant:{a|b}` — visitor cookie `tgp_storefront_variant` decides which to serve.

### 7.2 Headers

```
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=3600
X-Robots-Tag: <as per page meta>
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: <see Section 11>
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
```

---

## 8. Public render contract

The renderer produces:

```html
<!doctype html>
<html lang="<page.locale>">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><meta.title></title>
  <meta name="description" content="<meta.description>" />
  <link rel="canonical" href="<meta.canonical || derived>" />
  <link rel="icon" href="<meta.favicon || default>" />
  <meta name="robots" content="<derived from meta.noindex>" />
  <!-- OG / Twitter -->
  <meta property="og:title" content="<meta.title>" />
  <meta property="og:description" content="<meta.description>" />
  <meta property="og:image" content="<meta.ogImage || hero.image>" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="<derived url>" />
  <meta property="twitter:card" content="summary_large_image" />
  <!-- structured data -->
  <script type="application/ld+json"><schema.org/Person + Service objects></script>
  <!-- styles -->
  <style>:root { --color-brand: #ff7a00; ... }</style>
  <link rel="stylesheet" href="/static/storefront.css" />
</head>
<body>
  <main class="tgp-page">
    <!-- sections / blocks rendered server-side -->
  </main>
  <script src="/static/storefront-runtime.js" defer></script>
</body>
</html>
```

Hydration is partial — runtime JS hydrates only blocks that need interactivity (FAQ accordion, Pricing-Table cadence toggle, Schedule-Widget). Static blocks (RichText, Image, Hero, Testimonial, About) are SSR-only with zero client JS.

---

## 9. Sitemap

`/sitemap.xml` is a concatenation of:

- The home page `/`.
- Every published coach storefront `/c/<slug>`.
- Every published per-program sub-page `/c/<slug>/p/<programSlug>` (for active programs).

Generation:

- A scheduled job rebuilds `/sitemap.xml` every 30 minutes from the current published-version index.
- On any publish, a fast-path "sitemap delta" updates only the affected slug entry. (A coach republishing should not trigger a 10k-row regeneration.)

Sitemap format:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://growthproject.app/c/bradley-g-fitness</loc>
    <lastmod>2026-05-01T12:34:56Z</lastmod>
    <changefreq>weekly</changefreq>
  </url>
  ...
</urlset>
```

Pages with `meta.noindex: true` are excluded.
Pages whose coach has `accountStatus: "suspended"` are excluded.

If a coach's slug changed in the last 90 days, the sitemap also lists the old slug as a `<url>` with a 301 redirect — search engines pick this up to update their index.

---

## 10. Robots

`/robots.txt`:

```
User-agent: *
Disallow: /admin/
Disallow: /coach/
Disallow: /api/
Disallow: /preview/
Allow: /

Sitemap: https://growthproject.app/sitemap.xml
```

Per-page `meta.noindex: true` adds `<meta name="robots" content="noindex,nofollow">` to that page only.

Preview routes ALWAYS noindex+nofollow regardless of page meta.

---

## 11. CSP and security headers (public render)

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha256-<inline-script-hash>' https://js.stripe.com;
  style-src 'self' 'unsafe-inline';   // unsafe-inline only for theme-token CSS variables; we sandbox via nonce in v2
  img-src 'self' https://imagedelivery.net data:;
  font-src 'self';
  connect-src 'self' https://api.posthog.com;   // analytics ingestion
  frame-src https://www.youtube.com https://player.vimeo.com https://www.loom.com https://calendly.com https://*.typeform.com;
  frame-ancestors 'self';
  base-uri 'self';
  form-action 'self' https://checkout.stripe.com;
  object-src 'none';
```

The CSP is generated per-page based on which embeds are present — a page without an embed has a tighter `frame-src 'none'`.

Other headers per Section 7.2.

---

## 12. Initial slug squat

When Wave 9 ships, every existing coach gets a `StorefrontPage` row with `slug = coach.slug`, `draftTree = default empty-state tree`, `publishedVerId = null`. This prevents another coach from claiming an existing coach's slug between Wave 9 ship and that coach's first edit.

The pre-created page is in DRAFT state (never published). `/c/<slug>` for never-published pages returns:

```
HTTP/1.1 200 OK
<HTML serving a "Coming soon — <coach name> is setting up their page" placeholder>
```

This is INTENTIONALLY not a 404 — the slug is reserved, and SEO-wise we don't want that URL to look broken to crawlers.

---

## 13. Page-level A/B testing (OWNER_DECISION-2 = A)

A coach can run one A/B at a time on their published page. The mechanism:

```
StorefrontPage.publishedVerId   // variant A
StorefrontPage.publishedVerIdB  // variant B (optional)
```

When `publishedVerIdB` is set:

- First-time visitor (`tgp_visitor_id` cookie absent or no `tgp_storefront_variant` cookie) is randomly assigned A or B (50/50), sticky for 30 days.
- Subsequent visits: same variant.
- Analytics fires `page.view` with `variant: "a" | "b"`.
- Conversion attribution carries the `variant` through to `application.submit` and `checkout.complete`.
- Coach can see per-variant CTR and conversion in the funnel-analytics dashboard.

A/B end conditions:

- Coach manually picks a winner -> `publishedVerIdB` cleared, `publishedVerId` may be reassigned to the winner's version.
- Time cap: 30 days; then the platform sends "Pick a winner" email; auto-end after 60 days defaults to A.

A/B does NOT operate at block granularity in v1 (Section 1, non-goal #4).

---

## 14. OG / Twitter card generation

If `meta.ogImage` is set, use it. Else:

- If a Hero block has a `background.image`, use that with the headline rendered on it (server-side composes a 1200x630 image via Cloudflare Images variants).
- If no Hero image, generate a default brand card (theme `colorBrand` background, coach name + headline) at 1200x630.

OG cards are fetched separately from the page; cache 24 hours.

---

## 15. Custom domains (v2 placeholder, NOT v1)

Out of scope per non-goal #6 of README. v2 contract sketch:

- Coach adds a custom domain in their settings.
- We provision a TXT record for verification, then a CAA + A/CNAME pointing at our edge.
- Cloudflare-on-Cloudflare SaaS for cert provisioning.
- Slug remains internal; the public render serves the same content, just at a different host.

This is captured here so v1 doesn't accidentally couple to the platform domain in a way that v2 can't undo.

---

## 16. Failure modes

### F-Pub-1: Validation fails at publish

- Detection: Section 2 step 2 returns 422.
- Recovery: Surface the failing rule(s) in the editor; coach fixes; retries.

### F-Pub-2: Cache invalidation partial failure

- Detection: KV write fails or CDN purge times out.
- Recovery: Publish marked succeeded (DB row written); SREs see alert. Stale HTML serves from CDN until natural 5-min TTL; manual purge available. Coach is not blocked.

### F-Pub-3: Sitemap regen fails

- Detection: Job alerts.
- Recovery: Last-known sitemap continues to serve. Crawlers eventually pick up new pages on their next sitemap fetch (24h cache typical).

### F-Pub-4: Slug change without redirect

- Detection: Should never happen — Section 2 step 6 always writes a redirect row.
- Recovery: If a redirect row is missing, manual SQL insert; impact minimal beyond the missing 301.

### F-Pub-5: Schema migration during render

- Detection: A version's tree fails to parse against current schema (rolled-back row mid-migrator deploy).
- Recovery: Renderer falls through migrators; if any throw, render an error page (HTTP 500, monitored). Page is not marked broken, just transient. SREs roll the migrator forward.

### F-Pub-6: Origin slow during cold cache

- Detection: Origin response p95 > 1.2s.
- Recovery: Edge worker times out at 3s, returns last-known-stale (up to 1h); beyond that, "we're updating" placeholder. Auto-recovers when origin recovers.

### F-Pub-7: A/B variant cookie tampering

- Detection: Cookie value not in `["a", "b"]`.
- Recovery: Re-randomise; emit warning telemetry. No impact on legit users.

---

## 17. Test plan

- Unit: publish gate validators (every rule from Section 2 step 2).
- Integration: publish -> KV write -> public read returns new HTML; rollback creates new version pointing at old tree.
- e2e: Playwright — publish, navigate to /c/{slug}, verify content; press rollback, verify content reverts.
- Load: 1k publishes/min spike — cache writes don't fall behind (queue depth < 100); public reads at 200 RPS sustain p95 < 30ms.
- a11y: rendered page passes axe-core for every block-types-catalog block.
- Security: CSP doesn't break the page (no console errors for any allowlisted embed); preview URLs noindex; signed-preview JWT tampered -> 401.

---

## 18. Senior-engineer onboarding checklist

- [ ] Read this file.
- [ ] Read `block-editor-spec.md` Section 18.1 for schema.
- [ ] Read `block-types-catalog.md` Section 3 / 6 for Hero and Pricing-Table publish gates.
- [ ] Run `pnpm publish:dryrun --pageId=<id>` locally to see the publish path with logging.
- [ ] Inspect a real published version JSON.
- [ ] Read the edge worker source (Section 7).

---

## 19.1 Detailed publish flow with timestamps

To be concrete about latency expectations, here is what the publish path looks like for a typical page (medium tree, ~50KB):

```
T+000ms  Coach clicks Publish in editor.
T+010ms  Client POST /publish reaches origin LB.
T+015ms  Origin handler authenticates session.
T+020ms  Begin DB transaction.
T+025ms  Run schema validation (Ajv compiled). [~5ms]
T+030ms  Run cross-field validation. [~3ms]
T+033ms  Run page-level publish gates (contrast, hero presence, ...). [~10ms]
T+045ms  INSERT StorefrontVersion row.
T+080ms  UPDATE StorefrontPage.publishedVerId.
T+090ms  COMMIT.
T+095ms  Push to event bus: publish.completed.
T+100ms  Async: KV write to edge cache.
T+200ms  Async: CDN purge dispatched.
T+250ms  Async: Sitemap delta job triggered.
T+300ms  Async: OG card regen dispatched.
T+105ms  Origin returns 200 to client.
```

(Async tasks happen in parallel; the client sees ~100ms response time. KV write completes in 100-300ms typical. CDN purge completes in 1-3s typical.)

Editor UX: between clicking Publish and seeing "Live in seconds", the client shows a brief spinner. The "Visit your live page" button on success links to `/c/<slug>` which by then has a fresh HTML in KV.

---

## 19.2 Publish gates — rule catalog

The full list of gates that block publish but NOT autosave:

| Gate                                        | Path                              | Code                  |
|---------------------------------------------|-----------------------------------|-----------------------|
| Theme contrast 4.5:1                        | `/theme`                          | `CONTRAST_FAIL`       |
| Hero block exists                           | `/sections/*/blocks` filter type  | `HERO_MISSING`        |
| Slug not on phishing-adjacent list          | `/slug`                           | `PHISHING_SLUG`       |
| All Image refs have non-empty `imageId`     | `/sections/*/blocks/*/props/.../imageId` | `IMAGE_MISSING` |
| All Image refs have non-empty `alt`         | same                              | `IMAGE_ALT_MISSING`   |
| All Buy-CTA tiers have stripePriceIds       | `/sections/*/blocks/*/props/tiers/*` | `STRIPE_PRICE_MISSING` |
| All Embed URLs match allowlist              | `/sections/*/blocks/*/props/url`  | `EMBED_NOT_ALLOWED`   |
| All Programs-Grid programIds owned by coach | `/sections/*/blocks/*/props/programIds` | `PROGRAM_NOT_OWNED` |
| Page has at least one section               | `/sections`                       | `EMPTY_PAGE`          |
| Total tree size <= 256KB                    | (whole tree)                      | `PAGE_TOO_LARGE`      |
| All custom-block manifestIds installed      | `/sections/*/blocks/*/props`      | `APP_NOT_INSTALLED`   |
| All `cohortIds` (Schedule) belong to coach  | `/sections/*/blocks/*/props`      | `COHORT_NOT_OWNED`    |
| Slug uniqueness                             | `/slug`                           | `SLUG_TAKEN`          |
| Meta title length 1..60                     | `/meta/title`                     | `META_TITLE_LENGTH`   |
| Meta description length 1..160              | `/meta/description`               | `META_DESC_LENGTH`    |

A 422 response from publish surfaces the full failure list, not just the first; the editor highlights each failing field and scrolls the canvas to the first.

---

## 19.3 Cache invalidation contract

Cache layers for the public route:

```
Layer 0: browser cache (Cache-Control: max-age=300)         — visitor's browser
Layer 1: edge HTML cache (Cloudflare CDN)                   — per region
Layer 2: edge KV (Cloudflare Workers KV)                    — globally replicated
Layer 3: origin Postgres                                     — primary
```

On publish, invalidations propagate top-down (origin -> KV -> CDN -> browser):

- Origin: writes new `StorefrontVersion` and updates `publishedVerId`.
- KV: write `storefront:{slug}` immediately to the new HTML.
- CDN: purge URL `/c/{slug}` and `/c/{slug}/*`.
- Browser: 5-min TTL means a returning visitor within 5 minutes still sees the old HTML; this is acceptable for a coach's storefront (eventual consistency, not financial transaction).

For high-impact publishes (theme change, new pricing) where coaches want immediate freshness, the `Cache-Control` header on the publish-triggered HTML is changed to `max-age=0, must-revalidate, public, s-maxage=300`. This tells the browser "don't cache locally" while still allowing edge caching. Implementation note: this is a per-publish toggle, not always-on, because aggressive client cache busting hurts repeat-visit perf.

---

## 19.4 Public render — block hydration tree

```
SSR-only blocks: Hero, RichText, Image, Testimonial, About, Reviews-Display
Hydrated blocks: FAQ (accordion state), Pricing-Table (cadence toggle), Schedule-Widget (calendar interactivity), Embed (iframe lazy mount)
Custom-Block: per-manifest; the host hydrates the iframe wrapper.
```

The hydration JS bundle:

```
storefront-runtime.js                   ~25KB gzip   includes FAQ + Pricing-Table + Schedule + Embed glue
storefront-runtime-custom-block.js      ~10KB gzip   loaded lazily if any custom-block on page
```

Total bundle on a typical page (no custom-block): ~25KB gzip. Public TTI on M2 Air mid-3G: ~600ms.

---

## 19.5 OG card generation pipeline

```
1. On publish, server enqueues a job: generateOgCard(pageId, versionId).
2. Job runs in 1-3s typical:
   a. Read meta.ogImage; if set, use as is.
   b. If meta.ogImage is null, find the first Hero block's background.image; use as base.
   c. If no hero image, generate a brand card (Cloudflare Workers + OffscreenCanvas).
   d. Compose 1200x630 PNG. Upload to Cloudflare Images with id `og-{pageId}-{versionId}`.
3. Cache OG image URL in StorefrontVersion.ogCardUrl.
4. Updates PageMeta retrieval to use this URL.
```

Cold-path (first request after publish): the meta tag falls back to a default brand card while the OG generator runs; subsequent requests get the generated card. Slack/Twitter card-fetch happens within 5-30 seconds of the first share, so this is fine.

---

## 19.6 ISR refresh choreography

The "stale-while-revalidate" pattern at the edge:

```
1. Request comes in for /c/{slug}.
2. Worker reads cacheKey from KV.
3. If cacheKey exists AND age < 5 min:
     -> serve cached, return.
4. If cacheKey exists AND age >= 5 min:
     -> serve cached (don't block).
     -> enqueue a background refresh.
5. If cacheKey absent:
     -> fetch from origin (blocking).
     -> store in KV.
     -> serve.
```

Background refresh has its own deduplication: a per-slug "refresh in flight" flag prevents thundering-herd refreshes during a sudden viral moment. If the flag is set, subsequent stale-serves don't enqueue more refreshes.

---

## 19.7 Failure handling at the edge

Edge worker degradation cascade:

```
Origin healthy?
  yes -> normal flow.
  no  -> serve last-known-good from KV (up to 1h stale).
       -> if KV stale > 1h or empty:
            -> serve a static "we're updating, back in a moment" page (minimal HTML, 200 OK).
            -> emit metric edge.degraded_serve.
```

Static fallback content:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Updating</title></head>
<body><main><h1>We're updating this page</h1>
<p>This coach's storefront is being refreshed. Please check back in a moment.</p>
</main></body>
</html>
```

This is a 200 OK (not 503) intentionally — search engines don't penalise a 200 with thin content the way they do for repeated 503s.

---

## 19.8 Per-program sub-pages

A coach with programs has sub-pages at `/c/<slug>/p/<programSlug>`. These render the program's *own* storefront tree (a separate `StorefrontPage` row of type `program`). The publish + version pipeline is identical; only the rendering URL differs.

Per-program tree typically contains: Hero, About-the-program (RichText or About), Pricing-Table specific to that program, FAQ specific to that program, CTA.

Sitemap includes per-program sub-pages. The OG card per sub-page is generated separately.

---

## 19.9 Slug change UX

When a coach changes their slug:

```
1. Editor PUT validates uniqueness.
2. On publish, a new StorefrontSlugRedirect row is written.
3. Old slug serves 301 to new slug for 90 days.
4. After 90 days, the redirect row is purged; the old slug is free for re-registration.
5. The old slug is also flagged "recently freed" for 30 days post-redirect-expiry — a different coach claiming it gets a soft warning "This slug was used by another coach until 30 days ago."
```

The 90-day window is generous on purpose — coaches have shared the old URL on social, and we want their followers to land on the new page.

---

## 19.10 Audit log entries (publishing/versioning)

```
publish.attempt           { pageId, byUserId, cycleVersion }
publish.completed         { pageId, fromVersionId, toVersionId, slug }
publish.failed            { pageId, code, details }
rollback.attempt          { pageId, fromVersionId, toVersionId, byUserId }
rollback.completed        { pageId, newVersionId, byUserId }
slug.changed              { pageId, oldSlug, newSlug, byUserId }
preview.share.created     { pageId, byUserId, expiresAt }
preview.share.viewed      { pageId, viewerIp, signedTokenJti }
ogcard.regen              { pageId, versionId, success, durationMs }
sitemap.regen             { duration, urlCount }
ab.start                  { pageId, variantA, variantB, byUserId }
ab.end                    { pageId, winner, byUserId, conversionA, conversionB }
```

All entries include `actorIp, actorUserId, occurredAt, requestId`.

---

## 19.11 Performance budgets at scale

| Surface                           | Budget                      | At 100 coaches | At 1k coaches | At 10k coaches    |
|-----------------------------------|-----------------------------|----------------|---------------|-------------------|
| `/c/{slug}` p95 cache hit         | <= 30ms                     | comfortable    | comfortable   | requires 95%+ hit |
| `/c/{slug}` p95 cache miss (cold) | <= 1.2s                     | comfortable    | comfortable   | comfortable       |
| Publish round-trip                | <= 800ms p95                | comfortable    | comfortable   | comfortable       |
| KV write (publish)                | <= 300ms p95                | comfortable    | comfortable   | comfortable       |
| Sitemap full regen                | <= 30s                      | trivial        | ~5s           | ~30s              |
| Sitemap delta (per publish)       | <= 200ms                    | trivial        | trivial       | trivial           |
| OG card gen p95                   | <= 3s                       | trivial        | trivial       | needs queue depth |
| Storage: pages + versions         |                             | ~5MB           | ~50MB         | ~500MB            |
| Storage: BlockEvents (18mo)       |                             | ~1GB           | ~10GB         | ~100GB            |

---

## 19.12 Migration from a never-existed-before state

Wave 9 ships net-new — no prior storefront builder existed. Migration:

1. SQL one-shot: for every existing coach, INSERT a `StorefrontPage` row with default tree, slug = coach.slug, publishedVerId = null. (Section 12.)
2. No data backfill of old "static coach pages" — those don't exist in production.
3. `/c/<slug>` route: pre-Wave-9, this 404'd. Post-Wave-9, it serves the placeholder for never-published pages and the rendered version for published ones.

Rollback (if Wave 9 has to be reverted): drop the new tables; the route falls back to 404. No data is lost outside the storefront pipeline.

---

## 19.13 Senior-engineer onboarding checklist (this file)

- [ ] Read Section 1 (lifecycle).
- [ ] Read Section 2 (publish pipeline) end-to-end.
- [ ] Read Section 7 (ISR strategy) and the worker pseudocode.
- [ ] Run `pnpm storefront:render --slug=<slug>` locally to see SSR output.
- [ ] Inspect a real `StorefrontVersion.tree` JSON.
- [ ] Read `funnel-analytics.md` Section 5 to understand `BlockEvent` writes during render.

---

## 19. Open questions

None unresolved beyond OWNER decisions in README.

End of publishing-and-versioning.

