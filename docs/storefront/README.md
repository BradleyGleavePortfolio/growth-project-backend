# Wave 9 — Storefront Block Builder + Funnel Analytics

Status: DRAFT spec. Docs only. No runtime, no migrations, no schema applied. All Prisma deltas in this directory are illustrative, fenced inside `.md` files.

Branch: `docs/wave-9-storefront-builder`
Base: `main`
Owner: Platform/Storefront squad
Reviewers: Platform tech lead, Coach-experience PM, Trust & Safety
Cross-repo deps: `growth-project-mobile` (preview-only), `tgp-finance-app` (checkout block routing).

---

## 1. Purpose

This wave specifies the **public coach storefront block builder** and the **funnel analytics** that attribute every storefront visitor through to application or checkout. It closes the no-code page-builder gap with Whop AI's coach-page surface.

Concretely, Wave 9 ships the spec for:

- A **drag-and-drop block editor** for coaches to compose their public storefront page (`/c/<slug>`), no code required, mobile-responsive by default, with undo/redo, autosave, and an optimistic edit lock.
- A **canonical block-type catalog** (Hero, Pricing-Table, Testimonial, FAQ, Embed, CTA, About, Programs-Grid, Reviews-Display, Schedule-Widget, Custom-Block) with per-type JSON Schema, max-instance rules, and image/embed policies.
- A **publishing & versioning** pipeline (draft -> preview -> publish), version history (last 30 publishes), one-click rollback, SSR/ISR rendering, sitemap and meta generation.
- A **funnel analytics** event taxonomy and contract (`page.view` -> `block.impression` -> `block.click` -> `cta.click` -> `application.start` -> `application.submit` -> `checkout.start` -> `checkout.complete`), block-level CTR, server-side conversion ledger.
- An **app-block integration** contract: how a Wave 6 app manifest can declare a custom block, how the iframe sandbox loads it, the postMessage protocol, permission scopes, and failure modes.

The deliverable is a senior-engineer-grade implementation spec. A staff engineer should be able to read this directory on Monday and start cutting code Monday afternoon.

---

## 2. Non-goals (v1)

The following are explicitly out of scope for v1 and must be enforced as hard rejects in validation, not soft warnings:

1. **No arbitrary HTML / JS injection.** Coaches cannot paste raw `<script>`, `<iframe>` (except via the embed block's allowlist), or arbitrary HTML strings. This is a security non-negotiable; XSS in a coach storefront becomes XSS for that coach's clients.
2. **No paid SEO manipulation.** No keyword-stuffing automation, no auto-generated doorway pages, no AI-spun copy variants pushed to live SEO without explicit publish.
3. **No fake-review widgets.** The Reviews-Display block reads only from `Review` rows that are authenticated to a real `Client` purchase. No "Loved by 1,000+ clients" counters that aren't backed by row counts. (Doctrine: TGP forbids social-proof manipulation.)
4. **No block-level A/B test in v1.** v1 supports page-level A/B (two variants of the whole page split 50/50 on first visit, sticky by visitor cookie). Block-level A/B (vary one block while holding others constant) is v2. See `OWNER_DECISION-2`.
5. **No multi-page sites in v1.** Each coach has one storefront page (`/c/<slug>`) plus optional sub-pages for individual programs (`/c/<slug>/p/<program-slug>`). No arbitrary page tree, no "blog", no nav editor. v2.
6. **No custom domains in v1.** v1 storefronts live at `growthproject.app/c/<slug>`. Custom domains (`coach.com`) are v2 — they require DNS verification, certificate provisioning, SNI, and are a separate spec.
7. **No e-commerce cart in v1.** The Pricing-Table block links to a single-program checkout (Stripe Connect, owned by Wave 5). No multi-item cart, no cross-sell at checkout. v2.
8. **No collaborative real-time editing.** v1 enforces an optimistic edit lock — only one editor per page at a time. Real-time multiplayer (CRDT, Yjs-style) is explicitly v2+.
9. **No public CMS-style "themes" marketplace.** A coach picks from a fixed set of base themes (light, dark, brand-color-driven). User-generated themes are v3.
10. **No on-page comment widgets, no "live chat" embeds in v1** unless added explicitly through an allowlisted embed provider in `block-types-catalog.md`.

Anything not on this list and not specified below is also out of scope; ship the smallest correct surface first.

---

## 3. OWNER decisions

These are unresolved choices that need a one-line owner sign-off before implementation begins. Each carries a recommendation; the spec is written assuming the recommendation is accepted, but is structured so the alternative requires only a localised change.

### OWNER_DECISION-1: Custom-HTML escape policy

Three options:

- **A.** No raw HTML at all. All content is structured (text, image-ref, link). Embeds limited to the allowlist defined in `block-types-catalog.md` Section 11.
- **B.** Allow raw HTML inside a `RichText` block, sanitised through DOMPurify with a strict allowlist (`p, ul, ol, li, h2..h6, a, strong, em, blockquote`). No `script`, no `iframe`, no `style`, no `on*` attributes.
- **C.** Full raw HTML for OWNER-tier accounts only.

**Recommendation: A** for v1. Move to **B** when a real coach use case forces it; C is a permanent no.

### OWNER_DECISION-2: A/B test scope in v1

- **A.** Page-level only — two whole-page variants, 50/50, sticky by `tgp_visitor_id` cookie. (Recommended.)
- **B.** Block-level — vary one block while pinning others. More valuable, much more complex (requires per-block exposure events, conversion attribution to specific block).

**Recommendation: A.** Block-level is a v2 deliverable; the event taxonomy in `funnel-analytics.md` is forward-compatible.

### OWNER_DECISION-3: SEO render strategy

- **A.** SSR every request — fresh, but slow at scale; 10k coaches, 100 req/s sustained = significant origin load.
- **B.** Static export at publish time — fastest, but stale meta if e.g. price changes mid-day without republish.
- **C.** ISR (incremental static regeneration) — render at publish, revalidate on demand or every 5 min, fall back to last-known-good if origin slow.

**Recommendation: C (ISR)** with on-demand revalidation triggered by publish events.

### OWNER_DECISION-4: Image CDN provider

- **A.** Cloudflare Images — bundled with our existing CF stack, $5/100k images stored, automatic WebP/AVIF, signed URLs. (Recommended.)
- **B.** imgix — best transform pipeline, more expensive at scale.
- **C.** In-house pipeline on S3 + Lambda@Edge — full control, much higher engineering cost.

**Recommendation: A.** All `block-types-catalog.md` examples assume Cloudflare Images URL conventions.

### OWNER_DECISION-5: Version retention depth

- **A.** Last 10 published versions.
- **B.** Last 30 published versions. (Recommended.)
- **C.** Unbounded with monthly compaction.

**Recommendation: B.** Storage cost trivial (page tree is JSON, ~50KB typical, 30 versions = 1.5MB/coach * 10k coaches = 15GB — easy). 30 covers ~6 months of weekly publishes which is the realistic ceiling.

---

## 4. Dependency graph

Wave 9 depends on:

- **Wave 6 (custom blocks via app manifest)** — the `Custom-Block` type in `block-types-catalog.md` resolves only if the page's owning coach has installed an app whose manifest declares a `block` capability. The iframe sandbox contract in `integration-with-apps.md` is the authoritative protocol; Wave 6's manifest spec must reference it.
- **Wave 7 (buyer funnel attribution)** — `funnel-analytics.md` cross-links the per-block CTR/conversion events into the same server-side ledger Wave 7 defined for Discover -> coach-page -> application. The `attribution_token` defined in Wave 7 propagates through all Wave 9 events.
- **Wave 5 (Stripe Connect, sub-coach billing split)** — the `Pricing-Table` block's `Buy` CTA initiates a Stripe Checkout in the coach's connected account; revenue split is owned by Wave 5.
- **Wave 3 (admin data-feed scope-stack)** — funnel analytics dashboards in the admin console respect the same scope-stack (org / cohort / coach / client) and capability-hash cache keys.
- **Wave 2 (Coach, Program, Cohort entities)** — `Programs-Grid` block reads `Program` rows; `Schedule-Widget` reads `Cohort` rows.

Wave 9 is depended on by:

- **Wave 10 (community / engagement layer)** — community widgets are surfaced as embed blocks in v2.
- **Mobile (`growth-project-mobile`)** — mobile is preview-only for v1; the mobile storefront route renders the published page tree with the same SSR contract but no editor.

---

## 5. File map

```
docs/storefront/
  README.md                       (this file, ~220 lines)
  block-editor-spec.md            (~1,800-2,000 lines) — drag/drop, autosave, undo/redo, lock, accessibility, breakpoints, failure modes
  block-types-catalog.md          (~1,300-1,500 lines) — every canonical block type, schema, validation, image/embed policy
  publishing-and-versioning.md    (~900-1,100 lines)   — draft/preview/publish, version history, rollback, SSR/ISR, sitemap, OG cards
  funnel-analytics.md             (~1,000-1,200 lines) — event taxonomy, block CTR, conversion ledger, perf budgets, sampling
  integration-with-apps.md        (~700-900 lines)     — Wave 6 manifest -> custom block, iframe sandbox, postMessage, scopes
  PERP_HANDOFF.md                 (~150 lines)         — session log
```

Reading order for a new senior engineer joining the squad:

1. `README.md` (this file) — get the shape.
2. `block-editor-spec.md` Sections 1-4 — data model, basic editor flows.
3. `block-types-catalog.md` — what blocks exist.
4. `publishing-and-versioning.md` — how a draft becomes live.
5. `funnel-analytics.md` — how we measure success.
6. `integration-with-apps.md` — how third-party blocks plug in.
7. `block-editor-spec.md` Sections 5-12 — accessibility, failure modes, perf budgets, test plan.

---

## 6. Personas and permission matrix

| Action                               | OWNER | COACH | SUB_COACH | CLIENT | ADMIN |
|--------------------------------------|:-----:|:-----:|:---------:|:------:|:-----:|
| View own storefront editor           | yes   | yes   | scoped    | no     | yes   |
| Edit own storefront                  | yes   | yes   | scoped (1)| no     | yes   |
| Publish own storefront               | yes   | yes   | no (2)    | no     | yes   |
| Roll back to prior version           | yes   | yes   | no        | no     | yes   |
| View public storefront               | yes   | yes   | yes       | yes    | yes   |
| View funnel analytics dashboard      | yes   | yes   | scoped    | no     | yes   |
| Configure custom-block scopes        | yes   | yes   | no        | no     | yes   |
| Override embed allowlist             | no    | no    | no        | no     | yes   |
| Force-unlock another editor's lock   | yes   | no    | no        | no     | yes   |

Notes:

1. SUB_COACH edit scope is bounded to the cohort / program slice their `SubCoach` row owns; they can edit only the blocks tagged with that scope, never the page-level (theme, slug, meta) settings. Detail in `block-editor-spec.md` Section 6.
2. SUB_COACH can save a draft but not publish — only the OWNER COACH (or ADMIN) presses Publish. This avoids accidental brand-damaging publishes.

---

## 7. Day-1 implementation order

1. Schema (`StorefrontPage`, `StorefrontVersion`, `StorefrontEditLock`, `BlockEvent`) — see `publishing-and-versioning.md` Section 3 and `funnel-analytics.md` Section 5.
2. Editor data-model serialiser/deserialiser + JSON-Schema validator gate. No UI yet.
3. Autosave endpoint + optimistic edit-lock endpoint.
4. Block-type registry (server-side) — must match TS types in `block-types-catalog.md`.
5. Public renderer (read-only) for a published version. SSR, no ISR yet.
6. Editor UI (Hero, Text, CTA, Image first — minimum useful set).
7. Publishing pipeline + version snapshot.
8. Event ingestion (`page.view`, `cta.click` only first).
9. Rollback flow.
10. Remaining block types (Pricing-Table, Programs-Grid, Schedule-Widget, FAQ, Testimonial, Reviews-Display, About, Embed).
11. Custom-Block iframe + postMessage (depends on Wave 6 shipping its manifest format).
12. ISR + on-demand revalidation.
13. Page-level A/B + cohort comparisons in dashboard.

Each step gates on its predecessor; do not parallelise step 4 against step 2.

---

## 8. Out-of-band notes for reviewers

- The doctrine constraint matters: every block that displays "social proof" (Testimonial, Reviews-Display) MUST source from authenticated rows. No free-text "claim a 5-star review" path. This is enforced at schema level, not at editor level.
- All money in Pricing-Table is `Decimal(14,2)` with currency stored on the row. Display formatting comes from the coach's locale.
- All PII (visitor email captured by an Application CTA) goes through the same audit pipeline as everything else; no PII is ever sent to PostHog or any third-party analytics.
- The block-event ingestion p95 budget (50ms) is the same primitive Wave 7 uses; do not introduce a second event bus.
- The custom-block iframe sandbox is the same primitive that Wave 6 specs for app surfaces; the `permissions` claim shape MUST be reused.

End of README.
