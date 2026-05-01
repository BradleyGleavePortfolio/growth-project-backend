# Block Editor Spec

Wave 9 / Storefront. Status: DRAFT. Docs only.

This file specifies the drag-and-drop block editor: data model, validation, undo/redo, autosave, edit lock, accessibility, mobile breakpoints, state-transition table, failure modes, performance budgets, security/audit, and test plan.

Companion files:
- `block-types-catalog.md` — the typed schema for every block.
- `publishing-and-versioning.md` — what happens when the editor presses Publish.
- `funnel-analytics.md` — what events fire when a published page is viewed.
- `integration-with-apps.md` — how a Wave 6 custom block plugs into the editor.

---

## 1. Editor surface and audience

The editor is a logged-in surface served at:

```
GET  /coach/storefront/edit              — the editor for the current coach's primary storefront page
GET  /coach/storefront/edit?page=<id>    — explicit page id (future-proof for multi-page in v2)
```

Audience: COACH (always) + SUB_COACH (scoped — see `README.md` Section 6) + ADMIN (full).

The editor is a single-page React surface. It is NOT mobile-editable in v1 — coaches edit on desktop/tablet (>= 1024px). Mobile preview is rendered in-editor; the mobile RN app (`growth-project-mobile`) does not have an editor.

Hard constraint: the editor must never directly render unsanitised content. Every block instance is run through the registry's `render` function with strict typed props; raw HTML is never `dangerouslySetInnerHTML`-ed except inside the `RichText` block (which is sanitised — see `block-types-catalog.md` Section 4 and OWNER_DECISION-1 in README).

---

## 2. Data model — the page tree

A storefront page is a JSON tree shaped:

```ts
// src/storefront/types.ts (NOT IMPLEMENTED — illustrative)

export type Locale = "en-US" | "en-GB" | "fr-FR" | string;

export interface StorefrontPage {
  /** Stable id, ULID. */
  id: string;
  /** Owning coach id (denormalised for cache key). */
  coachId: string;
  /** URL slug, kebab-case. */
  slug: string;
  /** Page-level metadata. */
  meta: PageMeta;
  /** Tree: ordered Sections. */
  sections: Section[];
  /** Theme tokens (colors, fonts) — see Section 11. */
  theme: ThemeTokens;
  /** Current edit-cycle version, integer, monotonic, +=1 on every autosave. */
  cycleVersion: number;
  /** Wall-clock of last autosave. */
  updatedAt: string; // ISO-8601
  /** Locale used for ICU formatting in defaults. */
  locale: Locale;
  /** Scope for sub-coach edits — null means whole page (only OWNER COACH). */
  editScope: EditScope | null;
}

export interface PageMeta {
  /** SEO title — <= 60 chars. */
  title: string;
  /** SEO description — <= 160 chars. */
  description: string;
  /** Open Graph image URL (Cloudflare Images signed). */
  ogImage: string | null;
  /** Canonical URL — auto-generated if null. */
  canonical: string | null;
  /** Favicon ref. */
  favicon: string | null;
  /** noindex flag — true if the page is unlisted (e.g. lead-magnet). */
  noindex: boolean;
}

export interface Section {
  id: string;             // ULID
  /** Layout container — affects responsive breakpoints. */
  layout: "single-column" | "two-column" | "three-column" | "grid-2x2";
  /** Background tokens. */
  background: SectionBackground;
  /** Children blocks, ordered. */
  blocks: Block[];
  /** Per-breakpoint visibility. */
  visibility: BreakpointVisibility;
}

export interface Block {
  id: string;             // ULID
  /** Discriminator for catalog lookup. */
  type: BlockType;
  /** Block-type-specific props — validated against the type's JSON Schema. */
  props: unknown;
  /** Per-breakpoint overrides — see Section 7. */
  breakpointOverrides?: Partial<Record<Breakpoint, unknown>>;
  /** Per-breakpoint visibility. */
  visibility: BreakpointVisibility;
  /** Edit-scope tag — sub-coach edits filtered by this. */
  editScopeTag: string | null;
  /** Analytics opt-in — block.impression / block.click only fire if true. */
  analytics: boolean;
}

export type Breakpoint = "mobile" | "tablet" | "desktop";

export interface BreakpointVisibility {
  mobile: boolean;
  tablet: boolean;
  desktop: boolean;
}

export type BlockType =
  | "hero"
  | "rich-text"
  | "cta"
  | "image"
  | "pricing-table"
  | "testimonial"
  | "faq"
  | "embed"
  | "about"
  | "programs-grid"
  | "reviews-display"
  | "schedule-widget"
  | "custom-block"; // resolved against installed-app manifests

export interface ThemeTokens {
  colorBrand: string;     // hex
  colorText: string;
  colorSurface: string;
  font: "system" | "inter" | "geist" | "lora";
  radius: "none" | "sm" | "md" | "lg";
  density: "compact" | "comfortable";
}

export interface EditScope {
  /** Sub-coach scope shape — exactly one of programId or cohortId is set. */
  programId?: string;
  cohortId?: string;
}

export interface SectionBackground {
  kind: "solid" | "gradient" | "image";
  value: string;          // hex / gradient stops / signed image URL
  overlay?: { color: string; opacity: number } | null;
}
```

### 2.1 Tree invariants (must be enforced server-side at autosave)

- `sections.length` <= 30 per page.
- `blocks.length` <= 25 per section.
- Total page tree byte size (UTF-8 JSON) <= 256 KB.
- Every `Block.id` and `Section.id` MUST be unique per page.
- `Block.type` MUST resolve in the server-side block registry. Unknown types are rejected with `BLOCK_TYPE_UNKNOWN` (see Section 12).
- `Block.props` MUST validate against `BlockRegistry[Block.type].schema` (Ajv-compiled JSON Schema). Failed validation rejects the autosave with `BLOCK_PROPS_INVALID` and the field-path-list of failures.
- `Block.editScopeTag`, if set, MUST be a tag the editing identity has permission for. SUB_COACH attempting to mutate a block tagged with a scope they don't own returns `403 EDIT_SCOPE_DENIED`.
- `PageMeta.title.length` <= 60; `description.length` <= 160. Hard reject on overflow.

### 2.2 Identifiers

All ids are ULIDs (Crockford base32, 26 chars, monotonic per ms). Reasoning: lexicographic ordering = chronological ordering, useful for the operation log.

---

## 3. Block registry (server + client)

Both the editor (browser) and the autosave endpoint (server) hold a block registry shaped:

```ts
// src/storefront/registry.ts (illustrative)

export interface BlockDefinition<P> {
  type: BlockType;
  schema: JSONSchemaType<P>;          // Ajv-compatible
  defaults: () => P;                  // factory for new instances
  maxPerPage: number | null;          // null = unbounded
  /** Pure function: validate semantics beyond schema (cross-field, e.g. priceMonthly < priceAnnual). */
  validate?: (p: P, ctx: ValidationContext) => ValidationError[];
  /** Mobile-default rules. */
  mobileDefaults?: Partial<P>;
  /** SSR render — server-side. */
  renderSSR: (p: P, ctx: RenderContext) => string;
  /** CSR render — client React component. */
  renderCSR: React.FC<{ props: P; ctx: RenderContext }>;
}
```

Versioning:

```ts
export interface BlockSchemaVersion {
  type: BlockType;
  /** Integer, monotonic. */
  version: number;
  /** When the block was rolled out. */
  releasedAt: string;
  /** Deprecated since (older clients can still read, but autosave migrates). */
  deprecatedSince?: string;
}
```

Migration: when a block type's schema gains a new required field, the registry MUST ship a migrator `(oldProps) => newProps`. On autosave, every block whose `props.__schemaVersion` is below the registry's current version is migrated server-side. The editor then receives the migrated tree on next read. See Section 12 failure mode F2 for the mid-edit case.

---

## 4. Editor session lifecycle

### 4.1 State-transition table

| From          | Event                                  | To            | Side effects                                                          |
|---------------|----------------------------------------|---------------|-----------------------------------------------------------------------|
| BOOTING       | initial load OK                        | LOCK_ACQUIRED | Acquire optimistic edit lock; emit audit `editor.session.start`.      |
| BOOTING       | initial load fails                     | ERROR         | Show retry; emit `editor.session.boot_fail`.                          |
| LOCK_ACQUIRED | local edit                             | DIRTY         | Push op to undo stack; mark autosave-pending.                         |
| LOCK_ACQUIRED | another user took lock                 | LOCK_LOST     | Show "another editor took over" modal; freeze edits.                  |
| DIRTY         | autosave timer fires (5s)              | SAVING        | POST page tree + cycleVersion.                                        |
| SAVING        | server 200                             | LOCK_ACQUIRED | Update cycleVersion; clear autosave-pending; emit `editor.autosave.ok`.|
| SAVING        | server 409 (cycleVersion conflict)     | CONFLICT      | Show conflict modal; offer rebase or discard.                         |
| SAVING        | server 422 (invalid props)             | LOCAL_INVALID | Highlight offending block; revert that block's edit.                  |
| SAVING        | server 5xx                             | DIRTY         | Backoff (1s/3s/9s); leave dirty; show toast.                          |
| CONFLICT      | user picks "rebase"                    | DIRTY         | Re-fetch latest tree; replay local ops on top; surface unmergeable ops.|
| CONFLICT      | user picks "discard"                   | LOCK_ACQUIRED | Drop local ops; load server tree.                                     |
| LOCK_ACQUIRED | user clicks Preview                    | LOCK_ACQUIRED | Open preview (read-only) in new tab — see `publishing-and-versioning.md` Section 5. |
| LOCK_ACQUIRED | user clicks Publish                    | PUBLISHING    | POST publish; freeze edits during snapshot.                           |
| PUBLISHING    | server 200                             | LOCK_ACQUIRED | New version stored; toast success; emit `editor.publish.ok`.          |
| PUBLISHING    | server failure                         | LOCK_ACQUIRED | Show error; allow retry.                                              |
| LOCK_ACQUIRED | tab close / nav away                   | LOCK_RELEASED | Send beacon to release lock; emit `editor.session.end`.               |
| LOCK_LOST     | user clicks "force unlock"             | LOCK_ACQUIRED | OWNER COACH or ADMIN only; ADMIN action audited as `editor.lock.force_release`. |
| ERROR         | retry                                  | BOOTING       | —                                                                     |

States: BOOTING, LOCK_ACQUIRED, DIRTY, SAVING, CONFLICT, LOCAL_INVALID, PUBLISHING, LOCK_LOST, LOCK_RELEASED, ERROR.

### 4.2 Edit lock contract

The lock prevents two coaches (or a coach and a sub-coach) from editing the same page concurrently. v1 uses an optimistic lock, not a pessimistic one:

```
POST /api/storefront/pages/{pageId}/lock/acquire
Body: {}
Response 200:
  {
    "lock": {
      "lockId": "01HXYZ...",
      "heldBy": { "userId": "...", "displayName": "...", "role": "COACH" },
      "acquiredAt": "2026-05-01T12:00:00Z",
      "ttlSeconds": 300
    },
    "page": { ... StorefrontPage ... }
  }
Response 409:
  {
    "error": {
      "code": "LOCK_HELD",
      "message": "Another editor is currently editing this page.",
      "details": {
        "heldBy": { "userId": "...", "displayName": "Bradley G.", "role": "COACH" },
        "acquiredAt": "...",
        "expiresAt": "..."
      }
    }
  }
```

- TTL: 5 minutes; refreshed on every successful autosave.
- Stale lock auto-expires; another editor can pick it up.
- A `LOCK_HELD` response surfaces the holder's display name and `expiresAt` so the client can show "wait 4m and try again".
- Force-unlock (`/lock/force-release`) is restricted to OWNER COACH on their own page or ADMIN; both paths audit `editor.lock.force_release`.
- Heartbeat: client pings `POST /lock/refresh` every 60s while the editor is active.

### 4.3 Autosave contract

```
PUT /api/storefront/pages/{pageId}
Body:
  {
    "cycleVersion": 17,
    "tree": { ...StorefrontPage... }
  }
Headers:
  Idempotency-Key: <ULID>     # to dedupe accidental double-fires
Response 200:
  { "cycleVersion": 18, "savedAt": "2026-05-01T12:00:05Z" }
Response 409:
  { "error": { "code": "CYCLE_VERSION_CONFLICT", "details": { "serverCycleVersion": 22 } } }
Response 422:
  { "error": { "code": "BLOCK_PROPS_INVALID", "details": { "errors": [ { "path": "/sections/2/blocks/0/props/headline", "message": "<= 80 chars required" } ] } } }
```

- Debounced 5s after last edit. Coalesces multiple keystrokes into one POST.
- If `cycleVersion` doesn't match, server returns 409; client transitions to CONFLICT.
- Idempotency-Key dedupes if the network retries; server stores `(pageId, idempotencyKey)` -> result for 24h.
- Autosave only persists *valid* trees. The editor never sends an invalid tree; client-side validation runs first using the same JSON Schema as the server. (Belt-and-braces — server still re-validates.)

---

## 5. Undo / redo — operation log

### 5.1 Why an operation log, not a snapshot stack

A snapshot stack (push the full tree on every edit) is simple but expensive: 50 snapshots * 50KB tree = 2.5MB / page open. With sustained editing this allocates aggressively and pressures GC.

We use an operation log instead: each user edit is one `Operation` object that knows how to apply forward and reverse. Undo/redo is replay, not restore.

### 5.2 Operation shape

```ts
export type Operation =
  | { kind: "section.insert"; at: number; section: Section }
  | { kind: "section.remove"; at: number }
  | { kind: "section.move"; from: number; to: number }
  | { kind: "section.update"; at: number; patch: Partial<Section> }
  | { kind: "block.insert"; sectionId: string; at: number; block: Block }
  | { kind: "block.remove"; sectionId: string; blockId: string }
  | { kind: "block.move"; from: { sectionId: string; index: number }; to: { sectionId: string; index: number } }
  | { kind: "block.update"; blockId: string; patch: { props?: unknown; visibility?: BreakpointVisibility; analytics?: boolean } }
  | { kind: "page.meta.update"; patch: Partial<PageMeta> }
  | { kind: "page.theme.update"; patch: Partial<ThemeTokens> }
  | { kind: "block.breakpoint.override"; blockId: string; breakpoint: Breakpoint; patch: unknown };
```

### 5.3 Buffer

- Buffer size: 50 operations.
- Eviction: FIFO — pushing a 51st op evicts op #1.
- Buffer is per editor session, not persisted. (Reload = clean undo history.)
- Redo stack is cleared on any new edit (standard Word-style behaviour).

### 5.4 Apply / inverse

Every Operation has:

```ts
applyForward(tree, op) -> tree'
applyInverse(tree, op) -> tree    // requires the captured "before" payload
```

For inverse to be cheap, every op captures the minimal "before" payload at the time of forward apply. E.g. `block.update` records the previous `props` in a side-table keyed by op id. This means the buffer is op + before-payload pairs.

### 5.5 Undo and autosave

- Undo is local-only until autosave fires.
- Undo updates `cycleVersion` like any other edit; the autosave debounce timer resets.
- If autosave fires mid-undo (user undoes 5 ops then waits 5s), the resulting tree is what gets persisted.

### 5.6 Edge cases

- Undo of `block.insert` after the block emitted an analytics impression does NOT retract the impression — analytics are append-only.
- Undo of `section.remove` restores the section verbatim including the ids; this is fine because ids are immutable per session.
- Undo crossing the autosave boundary: if a user undoes back to a state earlier than the last autosave, the editor still permits it; on the next autosave the earlier tree is what goes to the server. The cycleVersion still increments.
- Redo after a fresh edit is impossible: the redo stack is wiped.

---

## 6. Sub-coach scoped editing

A SUB_COACH can be granted edit rights to a slice of a coach's storefront — typically one program or one cohort. The mechanism:

1. The page tree contains blocks tagged `editScopeTag: "program:<id>"` or `"cohort:<id>"`.
2. The editor session resolves the SUB_COACH's `EditScope` from their `SubCoachAssignment` row.
3. The editor renders the whole page (so they have context) but greys out and locks every block whose `editScopeTag` doesn't match.
4. Page-level settings (theme, slug, meta, sections-add/remove) are always read-only for SUB_COACH.
5. Autosave server-side re-checks: a request from a SUB_COACH that mutates a block outside their scope returns `403 EDIT_SCOPE_DENIED`. (Belt-and-braces — client greys out, but server is the authority.)

Permission audit: every SUB_COACH save logs `editor.subcoach.save` with `{ pageId, blockIds, scope }`. ADMIN can see this in the audit panel (Wave 1).

A SUB_COACH cannot publish. They can save drafts (autosave normally), but the Publish action is disabled. The next time the OWNER COACH opens the editor, they see a "1 sub-coach has unpublished changes" banner.

---

## 7. Mobile breakpoints

### 7.1 The three breakpoints

| Name    | Range (CSS px) | Editor preview width | Notes                                      |
|---------|----------------|----------------------|--------------------------------------------|
| mobile  | 0 – 767        | 375 (iPhone 13)      | One-column layouts only.                   |
| tablet  | 768 – 1023     | 834 (iPad)           | Two-column allowed.                        |
| desktop | 1024 +         | 1280                 | All layouts.                               |

The editor has a breakpoint switcher in the top bar — the canvas shows the chosen breakpoint and the user can edit per-breakpoint overrides without leaving the desktop session.

### 7.2 Per-breakpoint overrides

Each Block carries an optional `breakpointOverrides: Partial<Record<Breakpoint, unknown>>` — if a key is set, those props override the base props at that breakpoint. The override is merged shallowly on the server before SSR and on the client before CSR. Override deltas are validated against the same JSON Schema as the base props.

Hard rules:
- Override deltas are partial. A block whose `props` defines `headline, subhead, image` can override `headline` for mobile while leaving `subhead, image` from the base.
- Override deltas may not change the block `type` or `id`.
- An override that fails JSON Schema validation rejects the autosave (same path as base props validation — see Section 4.3 422 case).

### 7.3 Per-breakpoint visibility

`Block.visibility = { mobile: true, tablet: true, desktop: true }`. Setting `mobile: false` causes the block to render-skip on mobile breakpoint. Useful for e.g. a "Watch a 2-min video" block that's irrelevant on mobile.

Section-level visibility behaves identically; if a Section is hidden at a breakpoint, its blocks are also hidden.

### 7.4 Default behaviours per block type

Each block type provides `mobileDefaults` in the registry — sensible defaults the editor applies when a block is dragged onto the canvas. E.g. `hero.mobileDefaults = { titleSize: "lg" }` (smaller than the desktop default `xl`). Coaches can override but rarely need to.

### 7.5 Editor canvas behaviour on resize

If the editor browser window is resized below the chosen-breakpoint preview width, the preview canvas stays the chosen width and the surrounding chrome scrolls. Reasoning: switching breakpoints implicitly because the user dragged a window edge would cause confusion and lost focus state.

---

## 8. Drag and drop

### 8.1 Library choice

Use `@dnd-kit/core` + `@dnd-kit/sortable`. Reasoning: tree-shake-friendly, accessibility primitives built in (kbd nav, screen-reader announcements), no jQuery legacy.

NOT React DnD (older API, larger bundle, weaker a11y). NOT a hand-rolled HTML5 DnD wrapper (a11y is hard).

### 8.2 Drag interactions

| Action                           | Source                  | Target                       | Result                                    |
|----------------------------------|-------------------------|------------------------------|-------------------------------------------|
| Drag a block from the side panel | Block-type catalog item | Section drop zone            | Block inserted with type defaults.        |
| Drag an existing block           | Block in canvas         | Same section, new index      | `block.move` op.                          |
| Drag an existing block           | Block in canvas         | Different section            | `block.move` cross-section op.            |
| Drag a Section                   | Section header          | Page-level reorder zone      | `section.move` op.                        |

### 8.3 Keyboard equivalents

A user must be able to do every drag operation without a mouse:

- Tab to a block.
- Press Space to pick up.
- Arrow keys to move (Up/Down within a section, PgUp/PgDn across sections).
- Press Space to drop, Esc to cancel.

Screen reader announcement on pick up: `"Block hero picked up. Position 2 of 5 in Section 1 of 3."` On drop: `"Block hero moved to position 4 of 5 in Section 2 of 3."`

### 8.4 Focus management

After drop, focus returns to the dropped block. After delete, focus moves to the next sibling (or previous if last). After undo, focus returns to the block affected.

---

## 9. Accessibility (WCAG 2.2 AA)

The editor is an internal tool but must still meet WCAG 2.2 AA. The PUBLIC RENDERED storefront must also meet AA — that is enforced separately in the per-block-type render (see `block-types-catalog.md`).

### 9.1 Keyboard

- Every interactive element reachable by Tab order.
- No keyboard traps. Esc always exits modals.
- Skip link at the top: "Skip to canvas".
- Block-action shortcuts: D = duplicate, Del = remove, ArrowUp/Down = move (when block focused).

### 9.2 ARIA

- Canvas root: `role="application" aria-label="Storefront page editor"`.
- Each block wrapper: `role="group" aria-label="<block-type-label> block"`.
- Drop zones: `role="region" aria-label="Drop zone for block <n>"`.
- Modals: `role="dialog" aria-modal="true"` and focus trap.
- Live region: `aria-live="polite"` for autosave status ("Saved 12s ago").

### 9.3 Color contrast

- Editor chrome: 4.5:1 minimum for normal text, 3:1 for >= 18pt or 14pt bold.
- Selected-block outline: 3:1 against any background, drawn with a 2px ring AND a small icon (do not rely on color alone).

### 9.4 Reduced motion

Respect `prefers-reduced-motion: reduce` — disable drag-handle bounce, disable autosave pulse animation, fall back to instant transitions.

### 9.5 Screen reader

Tested against NVDA + Firefox, VoiceOver + Safari, JAWS + Chrome on the per-release QA pass. Failures block release.

### 9.6 Audit checklist (per release)

- All interactive elements have an accessible name (axe rule `aria-allowed-role`, `button-name`, `link-name`).
- No `tabindex > 0`.
- Color-contrast lint passes.
- Focus visible on every focusable element.
- Drag-and-drop has a kbd equivalent and an SR announcement.

---

## 10. Performance budgets

### 10.1 Editor (browser)

| Metric                                           | Budget                  | Measurement                          |
|--------------------------------------------------|-------------------------|--------------------------------------|
| First contentful paint after route change        | <= 800ms p95 on M2 Air  | RUM — `performance.timing`.          |
| Time to interactive                              | <= 1.5s p95             | RUM.                                 |
| Drag pick-up latency                             | <= 16ms (one frame)     | Synthetic in CI (Puppeteer trace).   |
| Autosave round trip                              | <= 250ms p95            | Server log + RUM.                    |
| Preview render (in iframe)                       | <= 600ms p95            | Synthetic.                           |
| Editor JS bundle size (gzipped)                  | <= 220KB                | CI gate — fails if exceeded.         |
| Memory after 1h editing session                  | <= 200MB                | Manual longevity test once per release.|

### 10.2 Server (autosave / lock / publish)

| Endpoint                                | p50    | p95   | Read replica? | Cache TTL          |
|-----------------------------------------|--------|-------|---------------|--------------------|
| `GET  /pages/{id}` (editor read)        | 30ms   | 100ms | replica       | none (always fresh)|
| `POST /pages/{id}/lock/acquire`         | 20ms   | 70ms  | primary       | none               |
| `PUT  /pages/{id}` (autosave)           | 60ms   | 200ms | primary       | invalidate edge    |
| `POST /pages/{id}/publish`              | 200ms  | 800ms | primary       | invalidate edge    |
| `GET  /c/{slug}` (public, ISR)          | 5ms    | 30ms  | edge          | 5min ISR + revalidate-on-publish |

Budgets at 100 / 1k / 10k coach scale; the autosave path is the hot path (debounced 5s, but still). A coach-side admin console with 1k coaches means up to 200 concurrent editor sessions during peak (US 7-9pm), so the autosave path handles ~40 req/s sustained, ~200 burst. PostgreSQL primary handles 1k writes/s comfortably; the edge cache is invalidated only on publish, not on autosave.

### 10.3 Public render

The public storefront `/c/{slug}` is the highest-volume surface. Wave 9 must hit:

- p95 <= 250ms TTFB at edge for 10k coach scale, 100 req/s peak.
- ISR cache hit rate >= 95% under steady-state.
- Cold-start (no cache): p95 <= 1.2s for full SSR.

Strategy: the renderer runs at the edge (Cloudflare Workers or equivalent), reads the published version JSON from KV (5-min TTL with stale-while-revalidate), assembles SSR HTML, returns. On publish, the edge cache key is invalidated; the next request rebuilds. See `publishing-and-versioning.md` Section 8.

---

## 11. Theming

Each storefront page has a `ThemeTokens` object. v1 ships:

```ts
interface ThemeTokens {
  colorBrand: string;         // hex; renders as primary CTA color, link color, accent.
  colorText: string;          // hex; default text.
  colorSurface: string;       // hex; page background.
  font: "system" | "inter" | "geist" | "lora";
  radius: "none" | "sm" | "md" | "lg";   // 0 / 4 / 8 / 12 px
  density: "compact" | "comfortable";   // padding scale 0.85x / 1x
}
```

Hard rules:
- `colorBrand` MUST pass 4.5:1 contrast against `colorSurface`. The editor surfaces a contrast warning live; the validator rejects publish if contrast fails.
- `font` is one of four; arbitrary Google Fonts are NOT allowed (privacy and perf risk — Wave 9 doesn't ship a font picker beyond the 4 bundled).
- `density` is binary, not a slider — picking from an enum simplifies the design audit.

Tokens render as CSS variables on the public page. The block-type render functions read CSS variables — they never read raw hex; this allows the future "theme switcher" without touching block code.

---

## 12. Failure modes

The editor must handle at least these failure modes. Each has detection and recovery.

### F1. Autosave conflict (cycleVersion mismatch)

- **Cause:** Two tabs open in the same browser; user edits in tab A then tab B; tab A autosaves last with a stale cycleVersion.
- **Detection:** Server returns 409 `CYCLE_VERSION_CONFLICT`.
- **Client recovery:** Show a CONFLICT modal: "Your changes haven't saved because another tab modified this page. (Rebase / Discard / Open the other tab)". On Rebase, fetch latest tree, run client-side three-way merge: any op whose target id still exists is replayed; ops on deleted targets are dropped and listed. On Discard, drop local ops. On "Open the other tab", broadcast a cross-tab message to focus the other tab (BroadcastChannel API).
- **Audit:** `editor.autosave.conflict { pageId, lostOps: <count> }`.

### F2. Schema migration mid-edit

- **Cause:** A block type's schema bumps version while the editor session is open. The autosave server-side migrator rewrites the tree; the client now holds an out-of-date tree.
- **Detection:** Server response includes `migratedSchemaVersions: [{ blockType, from, to }]`.
- **Client recovery:** Show a non-blocking toast: "Some blocks were upgraded to a new format. Refresh to see the latest." Client reloads the tree; any in-flight local ops are replayed against the migrated tree. Ops on fields that no longer exist are silently dropped (the user gets a non-blocking summary).
- **Audit:** `editor.schema.migrate { pageId, blockTypes: [...] }`.

### F3. Browser crash mid-edit

- **Cause:** Tab killed (OS OOM, browser crash, accidental close).
- **Detection:** No detection at the moment of crash; on reopen, the editor compares server `cycleVersion` against the locally cached one in IndexedDB.
- **Client recovery:** If localCycleVersion > serverCycleVersion (i.e. local was ahead — autosave hadn't fired), the editor shows "Recover unsaved changes from <timestamp>?" and offers to replay the local op log. The IndexedDB op log persists every op as it's pushed (cheap; ULID-keyed; best-effort). On crash recovery, ops are filtered: ops on blocks that no longer exist server-side are dropped.
- **Audit:** `editor.recover.from_local { pageId, opCount }`.

### F4. Concurrent editor (lock contention)

- **Cause:** SUB_COACH and OWNER COACH open editor at the same time; the second to arrive sees `LOCK_HELD`.
- **Detection:** 409 on `lock/acquire`.
- **Client recovery:** Show "Bradley G. is editing now. Their session expires at 3:45pm." with a "Notify when free" button. Notification = client polls `/lock/acquire` every 30s, transitions when 200. OWNER COACH (only) can force-unlock; this audits as `editor.lock.force_release` with the displaced editor's id.
- **Audit:** `editor.lock.contended { pageId, requesterId, holderId }`.

### F5. Oversize image upload

- **Cause:** Coach drags a 12MB raw camera photo into an Image block.
- **Detection:** Pre-flight: file size checked client-side; >2MB rejected before upload starts. Belt-and-braces: server-side multipart parser caps at 4MB.
- **Client recovery:** Surface "Image too large (12MB). Max is 2MB. Want me to compress it?" — if yes, run client-side `canvas.toBlob` at 0.85 JPEG until <= 2MB; if it can't, suggest the coach use Cloudflare Images upload-from-URL with the original bucket. Never upload the original.
- **Audit:** `editor.image.oversize { pageId, originalBytes, action: "compress" | "reject" }`.

### F6. Broken external link

- **Cause:** A CTA block's `href` points to a 404 or a host that's been blocklisted.
- **Detection:** Daily background job hits each external `href` with HEAD; flags 4xx / 5xx / blocklisted host. Editor displays a yellow exclamation on the block; tooltip explains.
- **Client recovery:** Coach can fix the link or accept the warning. Publish is NOT blocked by a broken link warning; only schema/contrast failures block publish.
- **Audit:** `editor.link.broken { pageId, blockId, href, status }`.

### F7. Browser localStorage / IndexedDB quota exceeded

- **Cause:** Editor's op log + tree cache + image-thumb cache fills the origin's quota.
- **Detection:** `QuotaExceededError` on IDB write.
- **Client recovery:** Evict thumbnails first (LRU), then op log entries older than the most recent autosave (after autosave succeeds, older ops are unrecoverable anyway). If still failing, fall back to memory-only mode and surface a warning "Clear browser cache for editor to reliably recover from crashes".
- **Audit:** Client-side telemetry only (no server audit) — this is a client failure surface.

### F8. Hostile rich-text paste

- **Cause:** Coach pastes `<script>alert(1)</script>` into a RichText block.
- **Detection:** Paste handler runs DOMPurify with the strict allowlist BEFORE the content reaches the model.
- **Client recovery:** Sanitised content is what's stored. Coach sees what they pasted minus the hostile bits; a one-time toast "Some unsupported formatting was removed."
- **Audit:** `editor.richtext.sanitised { pageId, blockId, removedTagCount }`.

### F9. Custom-block iframe load failure

- **Cause:** A `custom-block` (Wave 6) iframe times out, errors, or is from an untrusted origin.
- **Detection:** See `integration-with-apps.md` Section 6 — handshake timeout (5s), origin mismatch, version mismatch.
- **Client recovery:** Editor renders a fallback placeholder block "App `<name>` failed to load." Publish is allowed (the public renderer applies the same fallback if it fails at render time).
- **Audit:** `editor.custom_block.load_fail { pageId, blockId, manifestId, reason }`.

### F10. Slug collision

- **Cause:** Coach edits the page slug to one already taken.
- **Detection:** `PUT /pages/{id}` validates uniqueness against `StorefrontPage.slug` index.
- **Client recovery:** 422 `SLUG_TAKEN`. Editor highlights the slug field, suggests `<slug>-<n>` alternatives.

---

## 13. Security

### 13.1 Threat model

| Threat                               | Mitigation                                                              |
|--------------------------------------|-------------------------------------------------------------------------|
| XSS via raw HTML paste               | DOMPurify on every RichText paste + Block validator rejects `<script>`. |
| XSS via image alt text               | Alt text stored as plain string; renderer escapes.                      |
| Stored XSS via custom-block payload  | Custom blocks rendered in `<iframe sandbox>`; postMessage origin pinned.|
| CSRF on autosave                     | SameSite=Lax cookie + double-submit token.                              |
| IDOR (edit another coach's page)     | Server checks `pageId.coachId == session.coachId` (or admin override).  |
| Privilege escalation via lock force  | Force-unlock requires `OWNER` role on that page; audit logged.          |
| SSRF via embed URL                   | Embed URLs allowlisted; only providers in `block-types-catalog.md` Section 11.|
| Phishing via misleading slug         | Slug rejected if it matches a list of phishing-adjacent words ("login", "verify", "stripe", "wallet"). |
| Open redirect via CTA href           | CTA `href` may be relative (internal) or absolute https; absolute hosts not on a blocklist; `target=_blank` always paired with `rel=noopener noreferrer`.|

### 13.2 Audit log entries

Every mutation surfaces:

```
editor.session.start         { pageId, userId, role }
editor.session.end           { pageId, userId, durationMs }
editor.autosave.ok           { pageId, cycleVersion, byteSize }
editor.autosave.conflict     { pageId, requestCycleVersion, serverCycleVersion }
editor.publish.ok            { pageId, fromVersion, toVersion }
editor.publish.fail          { pageId, reason }
editor.lock.acquire          { pageId, lockId }
editor.lock.refresh          { pageId, lockId }
editor.lock.force_release    { pageId, displacedUserId, byUserId }
editor.subcoach.save         { pageId, subCoachId, blockIds, scope }
editor.schema.migrate        { pageId, blockTypes }
editor.richtext.sanitised    { pageId, blockId, removedTagCount }
editor.image.oversize        { pageId, originalBytes, action }
editor.link.broken           { pageId, blockId, href, status }
editor.custom_block.load_fail { pageId, blockId, manifestId, reason }
```

All audit rows include `actorUserId, actorRole, actorIp, occurredAt, requestId`. PII (email, raw IP) is hashed where the audit consumer doesn't strictly need it.

### 13.3 Per-action authorisation matrix

| Action                          | Required scope                                         |
|---------------------------------|--------------------------------------------------------|
| `GET  /pages/{id}`              | `storefront:read` AND owns the page (or admin)         |
| `PUT  /pages/{id}`              | `storefront:write` AND owns OR sub-coach scope matches |
| `POST /pages/{id}/lock/acquire` | `storefront:write`                                     |
| `POST /pages/{id}/lock/force-release` | `storefront:owner` (i.e. OWNER COACH) OR admin   |
| `POST /pages/{id}/publish`      | `storefront:publish` (OWNER COACH or admin only)       |
| `POST /pages/{id}/rollback`     | `storefront:publish`                                   |

Scopes derive from the role+entity binding model (Wave 1 admin-console). A SUB_COACH never has `storefront:publish`.

---

## 14. Telemetry (editor)

The editor itself emits client-side telemetry (RUM-like) with NO PII. Events:

```
editor.boot.start          { pageId }
editor.boot.ok             { pageId, durationMs }
editor.boot.fail           { pageId, reason }
editor.op.applied          { pageId, opKind, latencyMs }
editor.autosave.attempt    { pageId, byteSize }
editor.autosave.result     { pageId, ok, latencyMs, code? }
editor.lock.contention     { pageId }
editor.preview.open        { pageId }
editor.publish.attempt     { pageId }
editor.publish.result      { pageId, ok, latencyMs }
```

Sample rate: 100% (these are coach-internal volumes, not client visitor volumes).
Storage: PostHog under the `coach_internal` project, separate from the public-funnel project (which is what `funnel-analytics.md` covers).

NEVER ship PII. Page slug is fine (already public). Block content is NOT shipped — only kind/count/byte-size aggregates.

---

## 15. Test plan

### 15.1 Unit

- Block registry: every block type has tests for `defaults()`, `schema` round-trip, `validate()` cross-field rules, `mobileDefaults` merge.
- Operation log: `applyForward` then `applyInverse` is identity for every op kind, on a representative tree.
- JSON Schema validator: rejects every invariant in Section 2.1.
- Three-way merge (CONFLICT recovery): rebase test cases for every op kind crossing every other op kind.

### 15.2 Integration

- Autosave + lock: editor session, edit, autosave fires, server returns 200, cycleVersion advances. Repeat with two simulated tabs to drive the 409 path.
- SUB_COACH scope enforcement: simulate a SUB_COACH editing a non-scoped block; expect 403.
- Schema migration mid-session: bump a block schema version, autosave, expect migrated response.

### 15.3 e2e (Playwright)

- Coach opens editor, drags Hero block, edits headline, drags Pricing-Table block, edits price, hits Publish. Public route serves the new content within 5 seconds.
- Coach opens editor on iPad, edits at tablet breakpoint, switches to mobile preview, sets `visibility.mobile: false` on a block, publishes; mobile public render hides the block.
- SUB_COACH attempts to publish — Publish button disabled; manual API call returns 403.
- Conflict path: open editor in two tabs, edit in both, observe 409 modal with recovery flow.

### 15.4 Load

- 200 concurrent autosaves (1k coach editor scale): p95 <= 250ms.
- 1k concurrent public reads on `/c/{slug}` with ISR warm cache: p95 <= 30ms.
- 1k concurrent public reads with cold cache (post-publish): p95 <= 1.2s, no error budget burn > 1%.

### 15.5 Accessibility

- axe-core run on the editor route: zero violations of `serious` or `critical` severity.
- Keyboard-only navigation pass: every interactive element reachable and operable.
- Screen reader smoke: NVDA+Firefox + VOiceOver+Safari pass per release.

### 15.6 Security

- Paste-XSS test: the 50-payload OWASP XSS cheat-sheet through the RichText block; zero stored XSS.
- IDOR fuzzer: random page-id rotation in autosave requests; expect 100% 403.
- Embed allowlist test: every off-allowlist URL returns 422 `EMBED_NOT_ALLOWED`.

---

## 16. Senior-engineer onboarding checklist

A staff engineer joining the squad should be able to:

- [ ] Read this file and `block-types-catalog.md` end-to-end.
- [ ] Run `pnpm dev:storefront-editor` and load `/coach/storefront/edit?page=demo`.
- [ ] Open the block registry and walk through `hero`, `cta`, `pricing-table`.
- [ ] Run `pnpm test:storefront` and read the failing-skip list.
- [ ] Read `publishing-and-versioning.md` Section 3 to understand the version table.
- [ ] Read `funnel-analytics.md` Section 2 to understand events.
- [ ] Read `integration-with-apps.md` to understand custom blocks.
- [ ] Review the latest published-version JSON of any 2 demo pages.
- [ ] Run a Playwright spec end-to-end locally.

---

## 17. Migration / backfill

There is no Wave 9 backfill — coaches without a storefront page get a default `StorefrontPage` row created on first visit to `/coach/storefront/edit`. The default is a one-section page with a Hero block (title = coach display name) and a CTA block (label = "Apply", href = `/c/<slug>/apply`).

Future migrations (block schema bumps) follow Section 3.x — server-side migrator on autosave, no offline batch needed.

---

## 18. Rollback

If Wave 9 ships and a critical bug is found in the editor:

1. Feature flag `storefront.editor.enabled = false` — editor route returns "Editor temporarily unavailable; published pages still work."
2. Public route is unaffected — published pages live in their own pipeline.
3. If the bug is in the public renderer, flag `storefront.public.use_legacy = true` — falls back to the previous "static one-page" renderer (which existed pre-Wave-9).
4. If the bug is in publish (corrupting versions), disable `Publish` button via `storefront.publish.enabled = false`; coaches can still edit drafts but not push live.

Rollback to the previous deployable: `helm rollback storefront <REL-N-1>`. The schema is additive — no destructive migration is part of Wave 9, so rollback is safe.

---

## 18.1 Detailed schema deltas (illustrative)

The following Prisma deltas are illustrative — Wave 9 does NOT touch `prisma/schema.prisma` in this PR. They live here as a contract that the implementing PR must match.

```prisma
// ----- StorefrontPage: the "head" row, points at the current draft + current published version.
model StorefrontPage {
  id              String   @id @default(cuid())
  coachId         String
  slug            String   @unique
  meta            Json     // PageMeta
  theme           Json     // ThemeTokens
  // Draft tree (latest autosave). Published trees live in StorefrontVersion rows.
  draftTree       Json
  draftCycleVer   Int      @default(0)
  // The version id currently live at /c/{slug}; null if never published.
  publishedVerId  String?
  // Soft delete for GDPR cascade.
  deletedAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  coach           Coach    @relation(fields: [coachId], references: [id], onDelete: Cascade)
  publishedVer    StorefrontVersion? @relation("PublishedVersion", fields: [publishedVerId], references: [id])
  versions        StorefrontVersion[] @relation("AllVersions")
  locks           StorefrontEditLock[]

  @@index([coachId])
  @@index([slug])
  @@index([deletedAt])
}

// ----- StorefrontVersion: immutable snapshot per publish.
model StorefrontVersion {
  id              String   @id @default(cuid())
  pageId          String
  // Integer, monotonic per pageId, +=1 on each publish.
  versionNumber   Int
  // Full tree at publish time — JSON.
  tree            Json
  meta            Json
  theme           Json
  // Who pressed Publish.
  publishedBy     String
  publishedAt     DateTime @default(now())
  // For rollback: the version this was rolled back from, if any.
  rolledBackFromId String?
  // Optional release note.
  note            String?

  page            StorefrontPage @relation("AllVersions", fields: [pageId], references: [id], onDelete: Cascade)
  publishedFor    StorefrontPage[] @relation("PublishedVersion")

  @@unique([pageId, versionNumber])
  @@index([pageId, publishedAt])
}

// ----- StorefrontEditLock: optimistic edit lock.
model StorefrontEditLock {
  id              String   @id @default(cuid())
  pageId          String
  heldByUserId    String
  acquiredAt      DateTime @default(now())
  refreshedAt     DateTime @default(now())
  expiresAt       DateTime
  // For audit on force-release.
  releasedBy      String?
  releasedAt      DateTime?
  releaseReason   String?  // "expired" | "ttl" | "force" | "session_end"

  page            StorefrontPage @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@unique([pageId, releasedAt])  // only one un-released lock per page
  @@index([heldByUserId])
}
```

GDPR delete: deleting a coach cascades to `StorefrontPage` (`onDelete: Cascade`); the cascade then nukes versions, locks, and any `BlockEvent` rows that point at the page (defined in `funnel-analytics.md`). The coach's published page goes 410 Gone; no remembrance. (See `audit-and-gdpr.md` for the canonical contract.)

Audit fields: every model includes `createdAt`. Mutations write to the `AuditLog` table per the Wave 1 contract.

## 18.2 API contract (TypeScript)

```ts
// src/storefront/contracts.ts (illustrative)

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface GetPageRequest { pageId: string }
export interface GetPageResponse {
  page: StorefrontPage;
  lock: { heldByUserId: string; expiresAt: string } | null;
  publishedVersion: { id: string; versionNumber: number; publishedAt: string } | null;
}

export interface AcquireLockRequest { pageId: string }
export interface AcquireLockResponse {
  lock: { id: string; heldByUserId: string; expiresAt: string };
  page: StorefrontPage;
}

export interface AutosavePageRequest {
  pageId: string;
  cycleVersion: number;
  tree: StorefrontPage;
  // For idempotency on retry.
  idempotencyKey: string;  // ULID
}
export interface AutosavePageResponse {
  cycleVersion: number;
  savedAt: string;
  // If the server migrated any block schemas mid-save:
  migrated?: { type: BlockType; from: number; to: number }[];
}

export interface PublishRequest {
  pageId: string;
  cycleVersion: number;
  note?: string;
}
export interface PublishResponse {
  versionId: string;
  versionNumber: number;
  publishedAt: string;
  publicUrl: string;
}

export interface RollbackRequest {
  pageId: string;
  toVersionId: string;
}
export interface RollbackResponse {
  newVersionId: string;
  versionNumber: number;
  rolledBackFromId: string;
}
```

Standard error codes:

| Code                       | HTTP | Meaning                                                |
|----------------------------|------|--------------------------------------------------------|
| `LOCK_HELD`                | 409  | Lock contention.                                       |
| `LOCK_EXPIRED`             | 410  | Caller's lock TTL passed; reacquire.                   |
| `CYCLE_VERSION_CONFLICT`   | 409  | Autosave conflict, see F1.                             |
| `BLOCK_TYPE_UNKNOWN`       | 422  | Server registry doesn't know this type.                |
| `BLOCK_PROPS_INVALID`      | 422  | JSON Schema or cross-field validation failed.          |
| `EMBED_NOT_ALLOWED`        | 422  | Embed URL not on allowlist.                            |
| `IMAGE_TOO_LARGE`          | 413  | > 2MB.                                                 |
| `EDIT_SCOPE_DENIED`        | 403  | SUB_COACH editing outside scope.                       |
| `PUBLISH_NOT_ALLOWED`      | 403  | Caller lacks `storefront:publish`.                     |
| `SLUG_TAKEN`               | 422  | Slug uniqueness collision.                             |
| `PHISHING_SLUG`            | 422  | Slug rejected by phishing-adjacent word filter.        |
| `CONTRAST_FAIL`            | 422  | Theme contrast below 4.5:1 — publish-time only.        |
| `BAD_REQUEST`              | 400  | Catch-all for malformed payloads.                      |
| `INTERNAL`                 | 500  | Unhandled.                                             |

## 18.3 Route surface

| Verb | Path                                        | Auth scope            | Rate-limit class       |
|------|---------------------------------------------|-----------------------|------------------------|
| GET  | `/api/storefront/pages/{id}`                | `storefront:read`     | `editor:read` (60/min) |
| PUT  | `/api/storefront/pages/{id}`                | `storefront:write`    | `editor:write` (30/min)|
| POST | `/api/storefront/pages/{id}/lock/acquire`   | `storefront:write`    | `editor:lock` (10/min) |
| POST | `/api/storefront/pages/{id}/lock/refresh`   | `storefront:write`    | `editor:lock` (60/min) |
| POST | `/api/storefront/pages/{id}/lock/release`   | `storefront:write`    | `editor:lock` (10/min) |
| POST | `/api/storefront/pages/{id}/lock/force-release` | `storefront:owner` | `admin:write` (5/min)  |
| POST | `/api/storefront/pages/{id}/publish`        | `storefront:publish`  | `publish` (5/min)      |
| POST | `/api/storefront/pages/{id}/rollback`       | `storefront:publish`  | `publish` (5/min)      |
| GET  | `/api/storefront/pages/{id}/versions`       | `storefront:read`     | `editor:read`          |
| GET  | `/api/storefront/pages/{id}/preview`        | `storefront:read`     | `editor:read`          |
| POST | `/api/storefront/pages/{id}/upload`         | `storefront:write`    | `upload` (10/min)      |
| GET  | `/c/{slug}`                                 | public                | `public:storefront` (200/min/IP) |

`storefront:owner` is implied for any action where `coachId == session.coachId AND session.role == "COACH"`; `storefront:write` is also granted to `SUB_COACH` rows whose `EditScope` matches the page; `storefront:publish` is `OWNER COACH` or `ADMIN`.

## 18.4 Autosave debounce details

The 5s debounce window is computed client-side as: 5000ms after the last user-visible op. The window resets on every op. Pending ops are coalesced into a single PUT. If `op.kind === "block.update"` is followed by another `block.update` on the same `blockId` within the window, the later op replaces the earlier — there is no benefit to sending intermediate states.

If the browser is going to navigate away (`beforeunload`), the editor flushes immediately via `navigator.sendBeacon` — best-effort, doesn't block nav, doesn't surface errors. If sendBeacon fails or returns false, the unsaved state is in IndexedDB for crash recovery (Section 12 F3).

## 18.5 Three-way merge details

When the editor receives 409 CYCLE_VERSION_CONFLICT, it does:

1. Fetch latest tree.
2. Compute the local op log (operations in `[lastSyncedCycleVersion, currentCycleVersion]`).
3. For each local op, attempt to apply against the latest tree:
   - `block.update` on a block that no longer exists in latest -> drop op, log to "lost ops" list.
   - `block.update` on a block whose `props` schema version differs -> attempt prop-merge: if the patch's keys are still valid keys in the new schema, apply; else drop.
   - `section.move` / `block.move` -> reapply with index recomputation; if target index is out of range, clamp to end.
   - `section.remove` / `block.remove` -> reapply if the target still exists, idempotent.
   - `section.insert` / `block.insert` -> always reapply (new content).
4. Show the user the lost-ops list with a "see what was dropped" expandable detail; user can copy the lost content out.

This is a deterministic algorithm; no LLM-based merge in v1. The lost-ops list is the escape hatch — the user always has a path to recover information manually.

## 18.6 Image upload pipeline

The Image block (and any block-prop that takes an image, e.g. Hero `backgroundImage`) flows through a three-step upload:

```
1. Client requests signed upload URL:
   POST /api/storefront/pages/{id}/upload
   Body: { contentType: "image/jpeg", byteSize: 1234567 }
   Response 200: { uploadUrl: "https://upload.imagedelivery.net/...", imageId: "abc123" }
   Response 413: { error: { code: "IMAGE_TOO_LARGE", details: { max: 2097152 } } }

2. Client PUTs to uploadUrl directly (Cloudflare Images).

3. Client confirms upload:
   POST /api/storefront/pages/{id}/upload/confirm
   Body: { imageId: "abc123", variants: ["thumb", "card", "full"] }
   Response 200: { url: "https://imagedelivery.net/<account>/abc123/<variant>" }
```

The storefront stores `imageId` only — the URL is built per breakpoint by the renderer:

- `mobile` -> `<account>/abc123/w=375,format=auto,quality=85`
- `tablet` -> `<account>/abc123/w=834,...`
- `desktop` -> `<account>/abc123/w=1280,...`

This is Cloudflare-Images-flavoured (OWNER_DECISION-4). Switching to imgix changes only the URL pattern, not the schema.

Signed URLs: in v1, all storefront images are public (a published storefront IS public). Signed URLs become relevant in v2 if "members-only" content is added. For v1, the signing in step 1 is for upload only.

## 18.7 Embed URL allowlist (editor-side enforcement)

The editor's Embed block field validates the URL on every keystroke:

```ts
const EMBED_ALLOWLIST = [
  /^https:\/\/(www\.)?youtube\.com\/embed\/[A-Za-z0-9_-]+/,
  /^https:\/\/player\.vimeo\.com\/video\/\d+/,
  /^https:\/\/(www\.)?loom\.com\/embed\/[a-f0-9]+/,
  /^https:\/\/calendly\.com\/[A-Za-z0-9_-]+/,
  /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+/,
  /^https:\/\/.+\.typeform\.com\/to\/[A-Za-z0-9_-]+/,
];
```

Out-of-allowlist URL pastes show a tooltip "We allow YouTube, Vimeo, Loom, Calendly, Stripe Checkout, Typeform. Need another? Email support.". The autosave server-side rejects with `EMBED_NOT_ALLOWED` if the client allows it through (defence in depth).

Custom embeds are explicitly NOT allowed in v1 (non-goal #1). The allowlist is the only way to embed third-party content that isn't a Wave 6 custom block.

## 18.8 Real-world editing scenarios

To stress-test the spec, three coach personas:

### Scenario A: Solo coach, daily-driver edits

- Coach Bradley opens the editor twice a week, makes minor copy edits (headline, testimonial swap).
- Mostly uses Hero, Pricing-Table, Testimonial blocks.
- Publishes 2-3x per week.
- Lock contention: never; single editor.
- Performance bias: low-latency autosave for snappy feel.

### Scenario B: Coach + 1 sub-coach managing one program

- Sub-coach Sarah edits the "Squat program" section (`editScopeTag: "program:sq-12wk"`).
- OWNER coach Bradley edits everything else.
- Sub-coach autosaves live; Bradley sees pending changes banner and presses Publish at end of week.
- Lock contention: when Sarah is editing, Bradley sees `LOCK_HELD`; he can wait or force-unlock (audited).

### Scenario C: Agency-style coach, 1 OWNER + 4 SUB_COACHes

- Multi-sub-coach editing across 4 programs, each scoped.
- Programs-Grid block always edited by OWNER; per-program detail blocks by the relevant SUB_COACH.
- Lock is per-page — only one editor at a time per page; programs don't conflict because edits are queued through the OWNER's review.
- Realistic peak: 3 sub-coaches in editor at once, but only 1 holds the lock; others see "Sarah is editing now".

In all three scenarios, the autosave path is the hot path; lock contention is rare for v1's single-page-per-coach model.

## 18.9 Editor preview (in-editor live preview)

The editor's right-pane preview is rendered inside an `<iframe>` pointing at `/api/storefront/pages/{id}/preview?cycleVersion=<n>`. The preview endpoint returns the SSR HTML for the *current draft tree*, not the published version. ETags allow the iframe to short-circuit re-renders if the tree hasn't changed.

Preview iframe responsibilities:

- Renders block-types-catalog blocks identical to public render.
- Stubs analytics — no `page.view` / `block.impression` events fire from preview.
- Stubs CTAs — clicking "Apply" in preview shows a modal "This is preview; the live page will navigate to the application form."
- Loads custom-blocks (Wave 6) in their real iframe sandbox — but with a `preview: true` flag so they can no-op writes.

Preview <-> editor message channel: the iframe can postMessage `{ kind: "preview.click.block", blockId }` to the parent so clicking a block in preview focuses it in the editor. (Optional UX nicety.)

## 18.10 Minor UI surfaces in the editor

These are documented for completeness; styles defer to the design system.

- **Block library side panel.** Categorised: Headline & Story (Hero, About, RichText), Conversion (CTA, Pricing-Table, Schedule-Widget), Social Proof (Testimonial, Reviews-Display), Education (FAQ, Programs-Grid), Embed (Embed, Custom-Block).
- **Inspector panel** (right side when a block is selected). Shows the block's prop fields; for fields with enum values, a select; for color, a color picker constrained to theme + 3 free-form swatches; for image, the upload pipeline above.
- **Layers panel** (collapsed by default). Shows the section/block tree, click to focus, drag to reorder.
- **Top bar.** Breakpoint switcher, Preview button, Publish button, lock indicator, autosave indicator (`Saved 12s ago`), version-history dropdown.
- **Version-history dropdown.** Lists last 30 versions: `<n> | <date> | <publisher> | <note?>`. Click for one-click rollback (confirmation modal).

## 18.11 Editor copy

All editor strings are localised through ICU. v1 ships en-US only; the framework is already in place via Wave 2's onboarding work.

A short list of copy strings to commit to:

```
editor.lock.held.title           = "Another editor is here"
editor.lock.held.body            = "{name} is editing this page now. Their session expires at {expiresAt}."
editor.lock.held.cta             = "Wait my turn"
editor.lock.held.force           = "Take over (audited)"

editor.autosave.saved            = "Saved {ago}"
editor.autosave.unsaved          = "Saving..."
editor.autosave.error            = "Couldn't save. Retrying."

editor.conflict.title            = "We found newer changes"
editor.conflict.body             = "Another editor saved while you were here. Want to merge your changes on top, or discard yours?"
editor.conflict.rebase           = "Merge mine on top"
editor.conflict.discard          = "Discard mine"

editor.publish.success           = "Live in seconds: {url}"
editor.publish.contrast_fail     = "Brand color is too low contrast against the page background. Pick a darker brand color."

editor.subcoach.scoped.title     = "You can only edit your assigned program"
editor.subcoach.scoped.body      = "{name}, you can edit blocks tagged for {programName}. Other blocks are read-only."
```

## 18.12 Editor metrics dashboard (internal)

A small admin dashboard at `/admin/storefront/health` shows internal-team-only metrics:

| Tile                              | Value                                    |
|-----------------------------------|------------------------------------------|
| Active editor sessions            | rolling 5min                             |
| Autosave success rate             | 24h, alert < 99.5%                       |
| Autosave p95 latency              | 24h, alert > 250ms                       |
| Lock contention events            | 24h count                                |
| Schema migration events           | 24h count, broken down by block type     |
| Conflict resolutions              | 24h count, broken down by `rebase` / `discard` |
| Image-upload errors               | 24h count                                |
| Custom-block load failures        | 24h count, broken down by manifest id    |
| Public-render p95                 | 24h                                      |
| ISR cache hit rate                | 24h                                      |

This is the "is the storefront editor healthy" view; SREs use it to triage issues before coach support tickets fire.

## 18.13 Detailed undo-redo edge cases

The op log model (Section 5) is conceptually clean but has practical edge cases that need explicit handling:

### Edge case A: Op on a block that was just removed by another op (same session)

Scenario: User adds a Hero, edits its headline, removes it, presses Undo.

Op log:
1. `block.insert` (Hero, id = H1, at section S1 index 0)
2. `block.update` (id = H1, props.headline = "Hello")
3. `block.update` (id = H1, props.headline = "Hello world")
4. `block.remove` (id = H1)

Undo from end:
- Undo 4 -> tree gets H1 back with the *captured-at-remove-time* state (i.e. headline = "Hello world").
- Undo 3 -> H1.headline reverts to "Hello".
- Undo 2 -> H1.headline reverts to (default).
- Undo 1 -> H1 removed.

For this to work, every op captures its own inverse payload AT FORWARD-APPLY TIME. The buffer entry shape is `{ op, inversePayload }`. `block.remove` captures the entire block state; `block.update` captures the previous `props`; `block.move` captures source coordinates.

### Edge case B: Move op that becomes invalid after an intermediate undo

Scenario: User has 5 sections, moves section #4 to position #1, then undoes once and tries to redo.

This isn't actually invalid — redo just re-applies. But: if between the undo and redo the user dragged in a new section (popping the redo stack), the redo is gone. Standard.

### Edge case C: Schema migration mid-session — undo of an op on a now-different schema

Scenario: User edits a `pricing-table` block's `priceMonthly` field; mid-session the schema bumps and `priceMonthly` is renamed to `monthlyPrice` with the migrator copying values across.

Op log holds `block.update { blockId: P1, patch: { priceMonthly: "29.00" } }`. After migration the block has `monthlyPrice: "29.00"` and no `priceMonthly` field.

Undo strategy: the op log entry's `inversePayload` is the *full previous props* (not the patch keys). So undoing rolls back the entire props object to before the edit; the migrator runs on the rolled-back tree at next autosave; the result is the migrated form of the old props.

This trades a tiny memory overhead (full props snapshot per op) for correctness across schema changes. Worth it.

### Edge case D: Cross-tab undo coherence

Two tabs open. Each has its own op log. If tab A undoes 3 ops then autosaves, tab B's log is now stale. Tab B's next autosave will 409 (cycle version conflict, see F1) and walk through the merge flow.

We do NOT try to share the op log across tabs. Reasoning: complexity-cost is high, and the conflict-resolution UI already handles it.

### Edge case E: Op log overflow during a long session

If a coach edits for 6 hours and accrues 5,000 ops, the buffer evicts 4,950 of them. Undo reaches a depth of 50 then stops; the UI greys out the Undo button. No silent data loss, just bounded history.

## 18.14 Cross-tab safety

The editor uses BroadcastChannel API to coordinate across tabs in the same browser:

```ts
const ch = new BroadcastChannel(`storefront-editor-${pageId}`);

ch.postMessage({ kind: "lock.acquired", lockId, sessionId });
ch.onmessage = (e) => {
  if (e.data.kind === "lock.acquired" && e.data.sessionId !== mySessionId) {
    // Another tab in this browser took the lock; this tab transitions to LOCK_LOST.
  }
};
```

This avoids one user fighting themselves: two tabs in one browser will negotiate cleanly, lock-holder is the most recent. The server still gives the canonical answer; BroadcastChannel is just a UX nicety to avoid the user clicking through "Lock held by yourself".

## 18.15 Server-side block registry and the registry hash

The server holds `BlockRegistry`, the same shape as the client. To prevent client-server drift:

- Both ship with a `REGISTRY_HASH` constant — sha256 over the sorted list of `(type, schemaVersion)`.
- On editor boot, client sends `X-Registry-Hash: <hash>` header.
- If server's hash differs (i.e. server is on a newer build), server responds with `426 Upgrade Required` and the client shows "The editor was updated. Refresh to continue."
- This avoids the case where the client is on a 1-week-old JS bundle (sticky service worker) and tries to push props that fail server validation cryptically.

## 18.16 Service worker policy

The editor IS a PWA-eligible surface but v1 disables service-worker caching of the editor JS:

- The editor JS bundle is served with `Cache-Control: public, max-age=300, must-revalidate`.
- Service worker is registered ONLY for offline notice ("You're offline; the editor needs internet to save").
- No offline editing in v1. Reasoning: operating an editor against an out-of-date tree without server reconciliation is a recipe for silent data loss.

The public storefront (`/c/{slug}`) DOES use a service worker for fast subsequent visits (separate concern, owned by `publishing-and-versioning.md`).

## 18.17 Internationalisation

v1 ships en-US copy strings. The string registry is structured for ICU with replaceable parts (`{name}`, `{ago}`). The block-types-catalog provides default content also in en-US; coaches can edit content into any language they want — the page's `locale` field affects only date/number formatting.

For RTL (Arabic, Hebrew): v1 does not ship RTL CSS overrides. v2 lists RTL as a separate feature, requires CSS logical properties throughout the public render. Editor remains LTR.

## 18.18 GDPR / data subject rights

A coach can request:

- **Export.** All `StorefrontPage`, `StorefrontVersion`, `BlockEvent` rows for that coach are exported as JSON to a signed URL valid for 24 hours. Export size cap: 100MB; over that, multi-part export. (Cap exists because BlockEvent rows can be large at 10k coach scale.)
- **Delete.** Coach delete cascades to all storefront rows. Public route `/c/{slug}` returns 410 Gone with a generic "This coach is no longer available." page. Sitemap regenerates without the slug. ISR cache for the slug is purged.

A storefront *visitor* (not a logged-in coach) does not own any rows in v1 — visitor identity is a `tgp_visitor_id` cookie, ULID, no PII attached. If the cookie is rotated, the old events are orphaned but not deletable per row (the cookie maps to no PII). For GDPR, a visitor can request "delete events for cookie X" via support; the event ledger has a `visitorId` column that supports a targeted delete.

## 18.19 Real-time preview vs. iframe-based preview

We chose iframe-based preview (Section 18.9) over a "live preview overlay in the same DOM tree" because:

- Iframe enforces style isolation — the editor chrome's CSS can't leak into the preview.
- Iframe runs the *real* SSR-then-CSR pipeline — what coaches see in preview is what the public page will look like.
- Iframe is sandbox-able — custom blocks (Wave 6) need it anyway.
- The 1-2-frame perceived latency penalty for postMessage is fine for an editing tool.

Live overlay was tried in a competitor product, has an entire class of bugs around CSS specificity and event-bubbling. Not worth it.

## 18.20 Editor analytics opt-in defaults

When a block is dragged onto the canvas, `analytics: true` by default — meaning `block.impression` and `block.click` events fire. Coaches can flip it off per block in the Inspector for blocks where impression tracking is irrelevant (e.g. an About block with no CTA).

`page.view` is always tracked (cannot be disabled).
`cta.click` is always tracked on CTA, Pricing-Table, Schedule-Widget — disabling these would defeat funnel analytics.

The opt-out granularity exists for "dressing" blocks (Image, RichText) where impression noise is undesirable. See `funnel-analytics.md` Section 4 for the canonical event contract.

## 18.21 Concurrent edit safety beyond the lock

The optimistic edit lock (Section 4.2) is the primary mechanism, but two safety nets layer on top:

1. **cycleVersion gate.** Even with the lock, every PUT carries `cycleVersion`. Mismatch = 409. This catches the case where a lock is force-released and the displaced user's stale request sneaks in before they realised they were displaced.
2. **CSRF double-submit.** Every editor action carries `X-CSRF-Token: <token>` matching a cookie value. Standard double-submit pattern. Without this, an attacker who has the user's cookie can autosave on their behalf — unlikely but cheap to defend.

A SUB_COACH being asked to refresh their browser when their lock is force-released is acceptable UX; we do NOT try to gracefully merge in this case (the OWNER intended to take over).

## 18.22 Editor JS bundle composition

```
editor-core.js          ~80KB gzip   React surface, dnd-kit, ICU
block-renderers.js      ~60KB gzip   per-block-type CSR components
inspector-fields.js     ~30KB gzip   field types (text, color, image-upload)
op-log.js               ~10KB gzip   undo/redo
sanitiser.js            ~20KB gzip   DOMPurify (only loaded when RichText is in tree)
custom-block-host.js    ~12KB gzip   iframe host glue (only loaded when custom-block is in tree)
total                   ~210KB gzip  base load (custom-block + sanitiser are lazy-imports)
```

Bundle gate (CI): `editor-core + block-renderers + inspector-fields + op-log` <= 220KB gzipped. Sanitiser and custom-block-host are lazy.

## 18.23 Validation depth

The validator runs in three passes:

1. **Schema** (Ajv-compiled JSON Schema). Fast (microseconds), rejects type / required / range failures.
2. **Cross-field** (`validate(props, ctx)` per block type). Examples: `priceAnnual >= priceMonthly * 10`, `headline.length + subheadline.length <= 200`, `embedUrl matches allowlist`.
3. **Page-level**. Examples: at most one Hero block per page, slug matches `^[a-z0-9-]{3,40}$`, contrast (theme.colorBrand vs theme.colorSurface) >= 4.5:1.

Pass 1 + 2 run on every autosave (cheap). Pass 3 runs on autosave AND on publish (publish is also gated by Pass 3 — autosave will accept a page with a contrast fail, but publish will reject). Reasoning: autosave should accept WIP states; publish must produce a page that will not embarrass the coach.

## 18.24 Detailed performance instrumentation

| Editor span                          | Tracer span name                    | Annotated attrs                               |
|--------------------------------------|-------------------------------------|-----------------------------------------------|
| Editor session boot                  | `storefront.editor.boot`            | `pageId, lockAcquired, treeBytes`             |
| Autosave PUT                         | `storefront.editor.autosave`        | `pageId, treeBytes, ops`                      |
| Server-side schema validation        | `storefront.editor.validate`        | `passes, durationMicros`                      |
| Server-side migrator                 | `storefront.editor.migrate`         | `blockType, fromVer, toVer`                   |
| Lock acquire                         | `storefront.editor.lock.acquire`    | `pageId, contended`                           |
| Publish                              | `storefront.editor.publish`         | `pageId, fromVersion, toVersion, treeBytes`   |

These are OpenTelemetry spans; they propagate to the existing collector (Wave 1 admin console infra).

## 18.25 Logging policy

Logs:

- Every server-side action logs at INFO with `requestId, sessionId, userId, pageId, action, latencyMs, statusCode`.
- Errors at WARN with the error code; 5xx at ERROR with stack.
- DO NOT log block content (PII risk via testimonials, application messages). Log shapes (e.g. `treeBytes`, `blockTypes: [...]`) only.
- Editor client-side errors flow to `editor.client.error` event with sanitised stack.

## 18.26 Production hardening checklist

Before flipping the editor on for the first paying coach:

- [ ] `EDITOR_ENABLED` flag default = false; flip per-coach allowlist first, then gradual.
- [ ] Public renderer `/c/{slug}` serves a "This coach is setting up their page" placeholder when `StorefrontPage.publishedVerId IS NULL`.
- [ ] Slug squat: pre-create slugs for all existing coaches at their `coach.slug` value. (See `publishing-and-versioning.md` Section 12.)
- [ ] Sentry / OpenTelemetry wired through.
- [ ] axe-core + Playwright a11y suite green.
- [ ] Load test against staging at 200 concurrent editor sessions; no p95 regression.

## 18.27 Editor toolbar reference

The top bar holds, left-to-right:

| Element                | State                                                                               |
|------------------------|-------------------------------------------------------------------------------------|
| Page title (slug)      | Editable inline; debounced save; uniqueness checked.                                |
| Breakpoint switcher    | Three-segmented control: Mobile / Tablet / Desktop. Keyboard: Cmd-1/2/3.            |
| Undo / Redo            | Shows count of available depth on hover; Cmd-Z / Cmd-Shift-Z.                       |
| Theme button           | Opens ThemeTokens drawer.                                                           |
| Version history        | Last 30 versions; click to roll back; admins see who published each.                |
| Lock indicator         | Green dot = lock held; orange = lock acquired by self <30s; red = lock lost.        |
| Autosave indicator     | "Saved 12s ago" / "Saving..." / "Last saved 2m ago — retrying".                     |
| Preview button         | Opens preview iframe in side pane.                                                  |
| Publish button         | Disabled if `publishGate` rejects (see 18.23 Pass 3).                               |

Keyboard shortcuts are listed in a help dialog accessible via `?`:

```
Cmd-S        Force autosave now (debounce-bypass).
Cmd-Z        Undo.
Cmd-Shift-Z  Redo.
Cmd-D        Duplicate selected block.
Del          Remove selected block (confirmation modal if block has analytics > 0).
Esc          Cancel current modal / drag.
Cmd-1/2/3    Switch to Mobile/Tablet/Desktop breakpoint.
Cmd-Enter    Publish (with confirmation).
?            Show this help.
```

## 18.28 Inspector panel: field types

The Inspector renders props per block type. Supported field types:

- `text` — single-line, 200-char default cap, validated against schema.
- `textarea` — multi-line; rich-text on RichText block only.
- `number` — integer or decimal; min/max/step from schema.
- `money` — `Decimal(14,2)` + currency selector. Currency stored alongside.
- `enum` — radio (<5 options) or select (>=5).
- `boolean` — toggle.
- `color` — palette of theme + 3 free-form swatches; passes contrast check.
- `image` — drag-drop or file-picker; runs Section 18.6 pipeline.
- `link` — URL input with allowlist hint; offline broken-link checker (Section F6).
- `tag` — autocomplete against allowed scope tags (for `editScopeTag`).
- `slug` — kebab-case enforced; uniqueness checked async.

Each field renders a label, the input, and (if validation fails) the error inline. No tooltips for primary field hints — labels carry the meaning.

## 18.29 Empty-state and onboarding

A fresh `StorefrontPage` ships with three blocks:

1. Hero block — `headline = "I'm <coachName>"`, `subhead = "I help <type-of-client> achieve <result>."`
2. About block — placeholder text.
3. CTA block — `label = "Apply"`, `href = "/c/<slug>/apply"`.

The empty state has a dismissible coach checklist:

- [ ] Replace the headline with your real positioning.
- [ ] Add at least one Pricing-Table block.
- [ ] Upload a hero image.
- [ ] Add at least one Testimonial.
- [ ] Hit Publish.

Checklist progress is persisted to `coach.storefront_onboarding_done` (a boolean per item); when all 5 are checked, the checklist auto-dismisses.

## 18.30 Failure-mode summary table

| Code | Mode                             | Impact      | Detection      | Recovery                       |
|------|----------------------------------|-------------|----------------|--------------------------------|
| F1   | cycleVersion conflict            | save fails  | server 409     | three-way merge                |
| F2   | schema migration mid-edit        | save mutates| server header  | refresh tree on response       |
| F3   | browser crash mid-edit           | local loss  | reopen check   | replay IDB op log              |
| F4   | concurrent editor                | lock denied | server 409     | wait or force-unlock           |
| F5   | oversize image                   | upload fails| pre-flight     | client-side compress           |
| F6   | broken external link             | warn only   | nightly job    | edit or accept                 |
| F7   | quota exceeded                   | local cache | IDB error      | LRU evict, fallback memory     |
| F8   | hostile rich-text paste          | sanitised   | paste handler  | content stored sanitised       |
| F9   | custom-block iframe failure      | block stub  | iframe events  | fallback placeholder           |
| F10  | slug collision                   | save fails  | server 422     | suggest alternative            |

(See Section 12 for full per-mode detail; this is the at-a-glance index.)

## 18.31 Editor session metrics export

For the internal dashboard (Section 18.12), each editor session emits:

```ts
interface EditorSessionMetric {
  pageId: string;
  sessionId: string;
  userId: string;
  role: "OWNER" | "COACH" | "SUB_COACH" | "ADMIN";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  opCount: number;
  autosaveCount: number;
  conflictCount: number;
  publishCount: number;
  endReason: "session_end" | "lock_lost" | "browser_crash" | "force_quit";
}
```

This is internal-only; never exposed externally. Daily roll-up to a `editor_session_metric_daily` materialised view feeds the dashboard.

## 18.32 Data retention

| Row                         | Retention          | Reason                                                |
|-----------------------------|--------------------|-------------------------------------------------------|
| `StorefrontPage`            | until coach deletes| Live data.                                            |
| `StorefrontVersion`         | last 30 (Owner-1)  | Rollback window.                                      |
| `StorefrontEditLock`        | 7 days             | Audit; expired locks pruned weekly.                   |
| `BlockEvent`                | 18 months          | Analytics, see funnel-analytics.md Section 8.         |
| `EditorSessionMetric`       | 12 months          | Internal ops dashboard.                               |
| Audit log entries           | 7 years            | Per Wave 1 admin-console policy.                      |

A nightly job runs `prune_storefront_versions` — for each `pageId`, keep the 30 most recent versions (by `versionNumber`), set `deletedAt` on older rows. Hard-delete (DROP) runs after 30-day soft-delete window.

## 18.33 Service-level objectives (SLOs)

| Surface                         | SLI                       | SLO target              | Burn alert       |
|---------------------------------|---------------------------|-------------------------|------------------|
| Editor autosave                 | p95 <= 250ms              | 99.5% / 28d             | 14d burn-rate    |
| Editor autosave success rate    | 200 responses / requests  | 99.9% / 28d             | 7d burn-rate     |
| Public render TTFB              | p95 <= 250ms (cache hit)  | 99.5% / 28d             | 14d burn-rate    |
| Public render availability      | 200/all                   | 99.95% / 28d            | 7d burn-rate     |
| Publish success rate            | 200/all                   | 99.5% / 28d             | 14d burn-rate    |

Burn-rate alerts route to the storefront on-call rotation (separate from admin-console).

## 18.34 Capacity planning

At 10k coach scale:

- Storefront pages: 10k * 50KB tree = ~500MB. Trivial.
- Versions: 10k * 30 versions * 50KB = ~15GB. Comfortable.
- BlockEvents: covered in funnel-analytics.md Section 9.
- Autosave write rate: 10k * 4 active editor-hours/day = 40k editor-hours/day; 10% concurrency at peak = 4k concurrent... but only 200 active editing at any moment given debounce. Sustained writes: ~40 PUT/s. Burst: ~200/s.
- Public reads: 10k coaches * (assume 200 visitors/day average, peaks for popular coaches) = peak ~2000 RPS at edge. ISR cache hit > 95% means origin sees < 100 RPS. Origin handles that with one Postgres read replica.

## 18.35 Failure-mode coverage in tests

For each F-mode in Section 12, an integration test exists. Coverage matrix:

| Mode | Test name                                  | Asserts                                        |
|------|--------------------------------------------|------------------------------------------------|
| F1   | `autosave_conflict_409.spec.ts`            | 409, modal shown, rebase succeeds              |
| F2   | `schema_migrate_midsession.spec.ts`        | migrated header, tree refresh, ops replayed    |
| F3   | `browser_crash_recovery.spec.ts`           | IDB op log replayed on reopen                  |
| F4   | `lock_contention.spec.ts`                  | second editor sees LOCK_HELD modal             |
| F5   | `image_oversize.spec.ts`                   | 12MB upload rejected, compress path works      |
| F6   | `broken_link.spec.ts`                      | nightly job flags 404 link, banner shows       |
| F7   | `idb_quota_exceeded.spec.ts`               | LRU evicts, memory mode, warning shown         |
| F8   | `xss_paste.spec.ts`                        | OWASP cheat-sheet payloads sanitised           |
| F9   | `custom_block_load_fail.spec.ts`           | iframe timeout -> fallback placeholder         |
| F10  | `slug_collision.spec.ts`                   | 422 SLUG_TAKEN, suggestion offered             |

A failure mode without a test is not "specified" by Wave 9 — it is a future task.

## 18.36 Cross-repo handshakes

- `growth-project-mobile`: receives the published page tree via `GET /api/storefront/pages/{id}/published`. The mobile renderer is read-only. Mobile does NOT autosave. Mobile RN renderers exist for Hero, Pricing-Table, CTA, Image only — other block types render as a "View on web" CTA. Ship mobile blocks incrementally in waves.
- `tgp-finance-app`: Pricing-Table CTA initiates Stripe Checkout in the connected coach account. Pricing-Table block stores `stripePriceId` per tier; the public renderer composes the Checkout URL with `attribution_token` from the visitor cookie so revenue is attributed in the funnel.

## 18.37 Slug squatting and slug policy

Coach slug is reserved at `Coach` row creation (Wave 2). v1 storefront slug == coach slug. v2 may diverge if a coach wants `gpr.app/yo-bradley` while their `Coach.slug` is `bradley-g-fitness`.

Policy:

- Slugs are kebab-case `^[a-z0-9-]{3,40}$`.
- Phishing-adjacent words rejected: `login`, `verify`, `stripe`, `wallet`, `apple-id`, `microsoft`, `secure`, `account`, `auth`, `password`, `bank`, `card`, `crypto`, `oauth`. (List maintained in `phishing_words.txt`; updated centrally.)
- Reserved words for the platform: `admin`, `api`, `app`, `static`, `assets`, `c`, `health`, `status`, `help`, `docs`, `terms`, `privacy`. (List maintained in `reserved_words.txt`.)
- Slug uniqueness across the whole `StorefrontPage` table.
- Slug change recompiles the sitemap and emits a 301 from the old slug to the new slug for 90 days.

## 18.38 Editor session timeout

If the editor sits idle (no ops, no heartbeat) for 30 minutes, the lock auto-expires and the editor session transitions to LOCK_LOST. Reasoning: a coach who walked away from their laptop shouldn't block a sub-coach indefinitely. The 30-minute number is generous; lock TTL on its own is 5 minutes, with refresh every 60s. A coach actively typing keeps the lock; a coach who walked away lets it expire after one TTL cycle.

## 18.39 Editor cookie / session lifecycle

The editor uses the existing coach session cookie (Wave 2 auth). No new cookies in Wave 9. The cookie carries `userId, role, expiresAt`; the editor ALSO maintains an in-memory `lockId` per opened page.

Logout clears the cookie; any held locks are released best-effort (a `release` request is sent before cookie clear). If the release request fails, the lock TTL handles the cleanup.

## 18.40 Optimistic edit lock — formal protocol

The lock is "optimistic" in the sense that holding it does not physically prevent another client from issuing PUTs; it just causes those PUTs to fail. The protocol:

```
1. Client A: POST /lock/acquire     -> 200 { lockId: L1, expiresAt: T+5min }
2. Client A: PUT /pages/{id}        -> 200, lock TTL refreshed to T'+5min
3. Client B: POST /lock/acquire     -> 409 LOCK_HELD { holder: A, expiresAt: T'+5min }
4. Client A: idle 5min
5. (server) lock auto-released at T'+5min
6. Client B: POST /lock/acquire     -> 200 { lockId: L2, expiresAt: T''+5min }
7. Client A: PUT /pages/{id}        -> 409 LOCK_NOT_HELD or CYCLE_VERSION_CONFLICT
                                       (server checks lock first; if A's cookie no longer holds the lock,
                                        return LOCK_NOT_HELD; else fall through to cycleVersion check)
```

State on the server: a single row in `StorefrontEditLock` with `releasedAt IS NULL` for that page. Acquire = INSERT with the unique constraint on `(pageId, releasedAt)`; on conflict, return current holder. Release = `UPDATE ... SET releasedAt = now()`. TTL expiry is enforced at acquire time: if the existing lock is past `expiresAt`, the acquire treats it as released.

There is no background "release expired locks" job — locks just expire on the next acquire attempt. This avoids a separate worker; the cost is that an expired lock row stays "live" until someone tries to take it. Pruning happens nightly along with version retention.

Concurrency: `INSERT ... ON CONFLICT (pageId, releasedAt) DO UPDATE` if expired -> claim. Postgres advisory lock on `pageId` to prevent race between two acquires landing simultaneously.

## 18.41 Editor reachability via deep-links

Direct URLs to specific blocks:

```
/coach/storefront/edit?page=<pageId>&block=<blockId>
```

On boot, the editor scrolls to and selects the deep-linked block. Used by the broken-link nightly job notification ("Click here to fix") and by sub-coach handoff ("Bradley, please review this block").

If the deep-linked blockId no longer exists (e.g. removed since the link was sent), the editor opens normally and shows a non-blocking toast "Block not found; it may have been removed."

## 18.42 Editor analytics for the coach (versus internal)

In addition to the internal RUM (Section 14), the editor exposes a per-block analytics tooltip:

- Hover any block in the editor canvas -> tooltip "127 impressions / 8 clicks / 6.3% CTR (last 7 days)".
- This data is read from the funnel-analytics view (see `funnel-analytics.md` Section 6); cached client-side for 30s.

This tells coaches in real time which blocks are working. The tooltip is hidden if `analytics: false` on that block.

## 18.43 Editor zero-state behaviour

If a coach has never opened the editor before, the route shows a 30-second video walkthrough (no audio, captioned), then auto-loads the empty-state page (Section 18.29). The video is dismissible.

The video is hosted as a Loom embed using the embed allowlist; a future iteration may switch to a self-hosted MP4. This is internal-asset; the URL is whitelist-pinned.

## 18.44 Editor "responsibility" matrix — who owns what

| Concern                                | Owner                                  |
|----------------------------------------|----------------------------------------|
| Block registry (server)                | Storefront platform team               |
| Block CSR components                   | Storefront platform team               |
| Theme tokens                           | Design systems team                    |
| Editor a11y                            | Storefront platform + a11y guild       |
| Image upload pipeline                  | Platform infra (CF Images integration) |
| Embed allowlist                        | Trust & Safety + Storefront            |
| Public renderer                        | Storefront platform                    |
| Funnel analytics ingestion             | Data platform                          |
| Funnel analytics dashboards            | Data platform + Storefront PM          |
| Custom-block iframe sandbox            | Apps platform (Wave 6 owners)          |

This matrix exists so an issue knows who to triage to. A bug in the editor's drag-and-drop is platform; a bug in a custom block is the app's owner.

## 18.45 Versioned block schema example walkthrough

Suppose `pricing-table` v1 had `priceMonthly: string`. v2 splits to `priceMonthly: { amount: string, currency: string }`. v3 adds an optional `priceAnnual` mirroring shape.

Migrators:

```ts
const pricingTableMigrators: Record<number, (p: any) => any> = {
  1: (p) => p,                                  // identity
  2: (p) => ({
    ...p,
    priceMonthly: { amount: p.priceMonthly, currency: "USD" },
    __schemaVersion: 2,
  }),
  3: (p) => ({
    ...p,
    priceAnnual: p.priceAnnual ?? null,
    __schemaVersion: 3,
  }),
};
```

When the server receives an autosave with a block at `__schemaVersion: 1`, it runs migrator 2 then migrator 3. The migrated tree is what's written to `StorefrontPage.draftTree`. The autosave response includes `migrated: [{ type: "pricing-table", from: 1, to: 3 }]`; the client refreshes the tree.

If the migrator throws, the autosave returns 500 `MIGRATION_FAILED` with the block id and failed step. The on-call team rolls back the migrator and the editor session continues.

Migration is one-way. We never downgrade; rollback to a prior storefront version always involves migrating that version's tree to current schema before serving (so the published-renderer never has to know about historical schemas). Migration is fast (microseconds per block); the cost is acceptable per publish.

## 18.46 OpenAPI sketch

A subset; full spec lives in `docs/openapi.json` updates (out of scope for this docs PR; implementing PR will update it).

```yaml
paths:
  /api/storefront/pages/{pageId}:
    get:
      operationId: getStorefrontPage
      security: [{ coachAuth: [] }]
      responses:
        "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/GetPageResponse" } } } }
        "404": { description: "Page not found" }
        "403": { description: "Not authorised to read this page" }
    put:
      operationId: autosaveStorefrontPage
      security: [{ coachAuth: [] }]
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content: { "application/json": { schema: { $ref: "#/components/schemas/AutosavePageRequest" } } }
      responses:
        "200": { ... AutosavePageResponse ... }
        "409": { ... CYCLE_VERSION_CONFLICT ... }
        "422": { ... BLOCK_PROPS_INVALID ... }
        "403": { description: "EDIT_SCOPE_DENIED" }
```

## 18.47 Documentation that lives outside this directory

The implementation PR will additionally update:

- `docs/openapi.json` — full route spec.
- `docs/api-conventions.md` — to reference the storefront editor's idempotency-key contract.
- `docs/audit-and-gdpr.md` — to add the new audit categories and GDPR cascade rules.
- `docs/metrics.md` — to add storefront-specific metrics keys.

These are mentioned here for traceability; Wave 9 (this PR) is the spec only.

## 18.48 Disagreements and decisions log

For posterity. These are decisions taken during spec drafting that someone might want to revisit:

| Date       | Decision                                                  | Reason                                       |
|------------|-----------------------------------------------------------|----------------------------------------------|
| 2026-05-01 | Optimistic edit lock, not real-time multiplayer.          | Multiplayer is huge engineering scope; v1 doesn't justify it.|
| 2026-05-01 | Op log + inverse, not snapshot stack.                     | Memory pressure for long sessions.           |
| 2026-05-01 | Iframe preview, not in-DOM.                               | Style isolation, sandbox for custom blocks.  |
| 2026-05-01 | No raw HTML in v1 (OWNER_DECISION-1 = A).                 | XSS risk vs. low value.                      |
| 2026-05-01 | ISR over SSR-every-request (OWNER_DECISION-3 = C).        | Cost at 10k coach scale.                     |
| 2026-05-01 | 30 versions retained (OWNER_DECISION-5 = B).              | Storage cost trivial; covers ~6 months.      |
| 2026-05-01 | Page-level A/B only (OWNER_DECISION-2 = A).               | Block-level multiplies analytics complexity. |
| 2026-05-01 | dnd-kit, not React DnD.                                   | Bundle size, a11y.                           |
| 2026-05-01 | DOMPurify for paste sanitisation, not custom regex.       | Battle-tested.                               |
| 2026-05-01 | BroadcastChannel for cross-tab.                           | Native; no polling.                          |

## 19. Open questions (resolved before merge)

These are documented for transparency; resolution is captured inline as `OWNER_DECISION-*` in the README:

- Custom-HTML escape policy (README OWNER_DECISION-1).
- A/B test scope v1 (README OWNER_DECISION-2).
- SEO render strategy (README OWNER_DECISION-3).
- Image CDN provider (README OWNER_DECISION-4).
- Version retention depth (README OWNER_DECISION-5).

End of block-editor-spec.
