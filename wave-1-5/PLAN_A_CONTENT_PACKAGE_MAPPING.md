# PLAN A — Content↔Package Mapping + Luxury Unlock CTA Page

**Author:** Chief of Product (for Bradley Gleave)
**Date:** 2026-06-16
**Status:** DESIGN ONLY — no production code written, mobile + backend repos read-only.
**Scope:** Wave 1.5 BIG candidate. Pairs with `wave-1-5/DECISIONS.md` (D1 open-guard, D6 no per-client overrides) and `SERVER_SIDE_FEATURE_FLAGS_SPEC.md`.
**Evidence:** raw citations in `plan_a_evidence/CODE_CITATIONS.md`.

---

## Executive summary

The flow we are designing — *tap a locked search hit → luxury unlock page → Buy CTA → checkout* — is **mostly already wired at the infrastructure level**, but is **blocked by one structural gap in the content model**:

1. **Checkout is done.** `publicPackagesApi.createCheckoutSession()` + `BrandedCheckoutWebViewScreen` already mint and render a branded Stripe checkout, with deep-link return to `CheckoutReturn`. The Buy button is a thin call onto existing rails (`packagesApi.ts:543`, `BrandedCheckoutWebViewScreen.tsx:69`).

2. **A reverse-lookup primitive already exists** — `CoachPackageContent` with `@@index([asset_type, asset_id])` (`schema.prisma:5036`). Given an `(asset_type, asset_id)` you can already find the owning package(s) in one indexed read.

3. **The gap that blocks everything:** the two gated search kinds — `classroom_lesson` and `event` — **are not representable in `CoachPackageContent`.** Its `asset_type` union is `workout_program | workout_plan | meal_plan | pdf | video | auto_message` (`packageContentsApi.ts:33`). And `CommunityClassroomPost` / `CommunityEvent` have **no `package_id` and no package join** (`schema.prisma:6029`, `:5887`). So today there is *no data path* from a gated lesson/event hit to a purchasable package. **System 1's core job is to build that path.**

The single biggest design decision is therefore **granularity**: do we extend `CoachPackageContent` to carry classroom lessons + events, or build a separate purpose-built mapping table? This doc recommends **a separate, narrow `content_unlock_map` table** (Section 2) so we do not overload the drip-feed authoring surface, and so the unlock query stays a single-purpose hot path.

**Open questions for Bradley: 7** (Section 10). **Biggest design risk:** mapping granularity + canonical-package ambiguity could silently regress to "Upgrade" fallbacks for most gated content if backfill is incomplete. **Biggest deferred R82:** the coach-facing tagging UI (Section 6) — the data model must support it, but the authoring screens are Wave 1.6.

---

## Section 0 — Design philosophy (the lens every UX decision in this doc is traced to)

Every UX choice in Section 4 is justified by a principle from `design-reference/LUXURY_DESIGN_DOC.txt` (cited by line). The unlock page is a **high-stakes, high-friction commerce moment** (the user is about to spend money on content they cannot yet see), so the doc's *Phantom* doctrine governs: **"polish functions as trust in high-stakes domains … every micro-interaction is a data point the user's brain uses to assess risk"** (`LUXURY_DESIGN_DOC.txt:78`). A janky or hype-y unlock page reads as *"if they were careless here, how careful were they with my payment?"* These five principles (P1–P5) are the design spine; Section 4.10's invariant table and Section 11's index trace every applied principle back to a line.

- **P1 — Lead with the felt emotional target, not the function.** *"Before writing a single line of code or dropping a single component, ask: How will this make the user feel?"* (`:10`) and Screen Protocol Step 1: *"When the user leaves this screen, they should feel ___"* (`:289`). **Applied:** Section 4.1's emotional target is **reassured + capable** ("this is worth it, and buying is safe"), NOT "informed". Drives the calm hero, plain copy, single CTA.

- **P2 — Polish = trust in a payment moment (Phantom CALM).** *"Polish functions as trust in high-stakes domains"* (`:78`); the CALM framework — Clarity, Animation, Light feedback, Mascot — for anxiety moments (`:87-91`). **Applied:** Section 4.5 motion is a single calm fade (no spring/scale-pop that would read as gimmicky); 4.6 copy is plain-language Clarity ("Text explains rather than intimidates", `:76`); 4.7 error states are *trust-building*, never raw codes (*"Treat error states as trust-building opportunities"*, `:101`).

- **P3 — Show the payoff before the effort.** *"Show the payoff before the effort: Before the first lesson, Duolingo shows users what they will be able to do — the goal state — not the effort required"* (`:45`); onboarding Screen 4 *"the value moment … show the user what they will gain"* (`:307`). **Applied:** Section 4.2 puts the *value* (what unlocking includes) above the price/effort; the CTA is framed as access to a payoff, never as a paywall punishment.

- **P4 — Apple cognitive de-load: one primary path, ≤5 choices, Hick's Law smart default.** *"Every screen should have one primary path — the action 70–80% of users need"* (`:238`); Miller's Law ≤5 actionable elements (`:226-227`); Hick's Law *"Make the Default Path Irresistible"* (`:234`); Screen Protocol Steps 2,4,5 (`:290-297`). **Applied:** Section 4.1/4.2 — exactly **one** primary CTA + one de-emphasized "Not now"; the canonical package (Section 2.4) is the *smart default* so the user makes zero package-selection decisions on this screen. The screen passes the *"one sentence"* test (`:284`): "This is where the user unlocks a locked item."

- **P5 — Peak-End closure, never an empty confirmation, never silent punishment.** Peak-End Rule + closure state (`:300-301`); Anti-Pattern 4 *"The Empty Confirmation"* (`:336-337`); *"never punish silently"* (`:61`). **Applied (with a Quiet-Luxury reconciliation):** the doctrine bans celebrations/confetti, so we honor Peak-End **by routing success straight into the now-unlocked content** (Section 5.3) — the *content itself* is the reward, a calm closure, not a trophy screen. The locked state never "punishes silently": it *explains the value and offers a path* (Section 4.2/4.6), satisfying `:61` without a celebration animation the doctrine forbids.

> **Doctrine reconciliation note (important).** `LUXURY_DESIGN_DOC.txt` repeatedly prescribes *celebration animations* for peak moments (e.g. Anti-Pattern 4, ring-closure sparks `:196`). The repo's **Quiet Luxury Doctrine** (and `quietLuxuryDoctrine.test.ts`) **forbids** confetti/trophies/celebrations. Where the two conflict, **the Quiet Luxury Doctrine wins and the UX is redesigned around it** (per the hard constraint: *"If a Quiet Luxury Doctrine test will block your proposed UX, REDESIGN — not the test"*). The redesign: the peak/closure is delivered by *immediacy and restraint* (instant access to the paid content, a calm warm-near-white-on-oxblood CTA) rather than by an explicit celebration. This is the single biggest place the research doc and the repo doctrine diverge, and it is resolved in the doctrine's favor throughout Section 4.

---

## Section 1 — Content hierarchy as it exists today

### 1.1 Searchable / gateable kinds (the only kinds this flow touches)

From `communitySearchApi.ts:40-46`, the search surface returns exactly four kinds:

| `kind` | Backing model | Gated by flag (D7) | Has package link today? |
|---|---|---|---|
| `post` | community post | — (not flag-gated) | n/a |
| `classroom_lesson` | `CommunityClassroomPost` | `community_classroom` | **NO** |
| `voice_note_transcript` | community voice note | — (not separately flagged) | n/a |
| `event` | `CommunityEvent` | `community_events` | **NO** |

Cited verbatim:

- Search kinds — `src/api/communitySearchApi.ts:40`
  ```ts
  export const SEARCH_KINDS = ['post','classroom_lesson','voice_note_transcript','event'] as const;
  ```
- Classroom post shape — `src/api/communityClassroomApi.ts:74-80` (`id, workspace_id, cohort_id, coach_id, title, ...`). No package field.
- Event shape — `[backend] prisma/schema.prisma:5887-5916` (`id, workspace_id, cohort_id, created_by_id, title, state, starts_at, ...`). No package field.

### 1.2 Commercial / entitlement entities (the "what you buy" side)

- **`CoachPackage`** (`schema.prisma:3208`) — the sellable unit. Fields: `id, coach_id, name, description, amount_cents, currency, billing_type (one_time|recurring), interval, interval_count, is_active, archived_at, published_at, is_sellable, recurring_*`. A package is *purchasable* only when `published_at != null` and `is_sellable = true`.
- **`CoachPackageContent`** (`schema.prisma:5036`) — the forward map *package → assets*. `asset_type ∈ {workout_program, workout_plan, meal_plan, pdf, video, auto_message}`, `asset_id`, `cadence_*` (drip). Indexed `@@index([package_id, removed_at, display_order])` AND `@@index([asset_type, asset_id])`.
- **`ClientPurchase`** (`schema.prisma`, `ClientPurchase` model) — the entitlement row. `client_user_id, coach_user_id, package_id, status, entitlement_active: Boolean, access_expires_at`. Indexed `@@index([client_user_id, status])` and `@@index([entitlement_active, access_expires_at])`. **This is the source of truth for "does user U currently own package P".**
- **`ScheduledDrop`** / **`PurchaseFanout`** — per-buyer drip schedule snapshotted at purchase (out of scope for unlock-CTA, but explains why content rows are soft-removable not deleted).

### 1.3 Ownership chain

```
Coach (User, role=coach|owner)
  └── CoachPackage (sellable unit; published_at, is_sellable)
        ├── CoachPackageContent[]  (package → asset_type+asset_id, drip cadence)   [FORWARD MAP — exists]
        └── ClientPurchase[]       (buyer entitlement: entitlement_active, expiry) [ENTITLEMENT — exists]

Community surface (workspace-scoped, cohort-scoped)
  ├── CommunityClassroomPost  (classroom_lesson)   [NO package link — GAP]
  └── CommunityEvent          (event)              [NO package link — GAP]
```

### 1.4 Documented gaps in the hierarchy

- **G1 — No lesson/event ↔ package edge.** The forward map (`CoachPackageContent`) cannot represent a classroom lesson or event. This is the central gap. (`packageContentsApi.ts:33`, `schema.prisma:6029`, `:5887`.)
- **G2 — Asset-type namespace collision risk.** Classroom lessons and community events live in `community_*` tables with `@db.Uuid` ids, while package contents use plain `String @default(uuid())` ids. The two id spaces are disjoint by table, so an `(asset_type, asset_id)` reverse key is only unambiguous if `asset_type` distinguishes them. We must add `asset_type` values `classroom_lesson` and `event` rather than reuse `pdf`/`video`.
- **G3 — Workspace/cohort scope vs. package scope.** A package is coach-scoped; a classroom lesson is workspace+cohort-scoped. A coach can own packages across workspaces. The mapping must not assume 1 coach = 1 workspace.
- **G4 — Membership-gated free content.** Some gated content is unlocked by *cohort membership* (free) rather than purchase. The four flags (D7) gate by capability, not always by payment. The model must express "this is unlocked by joining cohort X / signing up" distinctly from "buy package P" (see Section 7 free-content case, and OPEN Q4).

---

## Section 2 — Content↔Package mapping data model (backend)

### 2.1 Decision: a new narrow table `content_unlock_map`, not an extension of `CoachPackageContent`

**Rationale.** `CoachPackageContent` is the *drip-feed authoring* surface — it carries cadence payloads, display order, soft-remove semantics, and is consumed by the fanout/scheduling machinery (`ScheduledDrop`, `PurchaseFanout`). Overloading it with classroom lessons + events would:
- pollute the drip scheduler with content kinds that have no drip semantics (a classroom lesson is released by `release_at`, not by purchase cadence);
- force the `asset_type` union to grow in a table whose every consumer assumes drippable assets;
- couple the unlock hot-path read to a table with heavier write patterns.

A **separate, single-purpose `content_unlock_map`** keeps the unlock query a clean one-index read and lets the coach-side tagging UI (Section 6) evolve independently. It *complements* `CoachPackageContent` rather than replacing it.

> **Alternative considered (and rejected for v1):** add `package_id` directly onto `CommunityClassroomPost` / `CommunityEvent`. Rejected because (a) it forces 1 content = at most 1 package (D1 explicitly anticipates multiple packages unlocking one item), and (b) it mutates two community tables owned by a different lane. A join table is the correct cardinality and keeps the community schema untouched.

### 2.2 Schema

```prisma
/// Content↔Package unlock edges. One row = "package P unlocks content C of kind K".
/// Many-to-many: a content item may be unlockable by several packages
/// (standalone + bundle); a package may unlock many content items.
model ContentUnlockMap {
  id            String   @id @default(uuid())

  // The gated content being unlocked. content_kind mirrors the SEARCH kind
  // namespace so the search handler can look up by the exact (kind, id) it
  // already holds — NO translation layer.
  content_kind  String   // 'classroom_lesson' | 'event'  (extensible; mirrors CommunitySearchKind subset)
  content_id    String   // UUID of the CommunityClassroomPost / CommunityEvent

  // The package that unlocks it.
  package_id    String
  package       CoachPackage @relation(fields: [package_id], references: [id], onDelete: Cascade)

  // Canonical-recommendation marker. Exactly ONE row per (content_kind, content_id)
  // SHOULD have is_canonical = true; enforced by a partial unique index below +
  // a service-layer guarantee. When absent, the resolver falls back to the
  // cheapest published package (see §2.4).
  is_canonical  Boolean  @default(false)

  // Optional per-edge CTA overrides (Section 6 coach customization). Null = use
  // package defaults (name/price/description). Kept on the EDGE, not the package,
  // so the same package can pitch differently for a lesson vs an event.
  cta_headline    String?
  cta_subheadline String?
  cta_image_url   String?

  // Provenance — how this edge was created. Drives backfill + audit (§2.5).
  source        String   @default("coach")  // 'coach' | 'auto_membership' | 'backfill'

  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt
  removed_at    DateTime?  // soft-delete; an archived package keeps history

  // HOT PATH: getPackagesForContent(content_id, content_kind) — one indexed read.
  @@index([content_kind, content_id, removed_at])
  // Coach-side "show me everything package P unlocks".
  @@index([package_id, removed_at])
  // At most one LIVE canonical per content item (partial unique; see migration note).
  @@unique([content_kind, content_id, is_canonical], name: "uq_one_canonical_per_content")
}
```

> **Index note.** The `@@unique([content_kind, content_id, is_canonical])` form prevents two `is_canonical=true` rows only weakly (it also blocks two `false` rows for the same content, which is wrong). The migration MUST instead create a **Postgres partial unique index**:
> ```sql
> CREATE UNIQUE INDEX uq_one_canonical_per_content
>   ON content_unlock_map (content_kind, content_id)
>   WHERE is_canonical = true AND removed_at IS NULL;
> ```
> Prisma can't express partial uniques in the schema block, so this lands as raw SQL in the migration. Document it in the model comment. (This is an R82-adjacent note, tracked in Section 8.)

### 2.3 Granularity decision: **map at the leaf (lesson/event), not at the program, with optional inheritance**

- The searchable, gateable unit *is* the leaf (`classroom_lesson`, `event`) — that is what the user taps. So the **map is keyed at the leaf**.
- BUT coaches think in *programs/bundles*. To avoid a coach tagging 47 lessons by hand, the **coach-side write path** (Section 6) supports a "map this whole package's classroom cohort to package P" bulk action that **expands to per-leaf rows** at write time (denormalized), rather than storing an inheritance rule the reader must resolve at query time.
- **Why denormalize on write, not inherit on read:** the read (`getPackagesForContent`) is the hot path (every gated hit). A leaf-keyed table makes it a single index seek. Inheritance-on-read would require resolving the leaf→program→package chain per hit. We pay the cost once at authoring time. (Justification mirrors the backend's existing "snapshot at purchase" doctrine — `ScheduledDrop.content_id` is a snapshot, not an FK, `schema.prisma:5063`.)

### 2.4 Canonical-package logic

When content C is unlockable by multiple packages, the CTA recommends **the coach-marked canonical** (`is_canonical = true`). If none is marked:

1. **Tie-break 1 — cheapest published one-time package** the user does not already own (lowest `amount_cents` among `published_at != null AND is_sellable = true AND archived_at IS NULL`). Lowest-friction unlock = highest conversion, and is the honest "minimum to unlock this" answer.
2. **Tie-break 2 — if all candidates are recurring**, cheapest first period.
3. **Tie-break 3 — deterministic by `package_id`** so the CTA is stable across requests (no flapping).

> **OPEN Q2 (Section 10):** cheapest-unlock vs. coach-marked-canonical default ordering. This doc *defaults to coach-canonical, then cheapest*; Bradley may prefer "most-popular bundle" to drive AOV.

### 2.5 Migration / backfill plan

Two sources, recorded in `source`:

1. **`auto_membership` (automated, runs once + on package publish):** for every published, sellable package, if the coach has classroom lessons/events whose cohort is the package's delivery cohort, generate edges. *This only fires where a deterministic cohort↔package relationship exists.* Where it does not (most cases today, since there is no such link — G3), it generates nothing.
2. **`coach` (manual, primary path going forward):** coaches tag content via the Section 6 UI. This is the durable source of truth.

Because (1) cannot infer most edges (no existing cohort↔package link), **the realistic v1 backfill is mostly empty**, and gated content will fall to the **`upgrade` fallback CTA** (D1) until coaches tag it. That is acceptable and honest (Section 7, orphan case) — but it means **the coach tagging UI is on the critical path for the flow to feel complete**, which is why Section 9 sequences it early and Section 8 flags the deferral risk.

### 2.6 RLS / authorization

- **Read (compute a user's CTA):** the app runs as `service_role` (BYPASSRLS) per the search service's documented tenancy posture (`community-search.service.ts:38-41`). The *service* reads `content_unlock_map` freely; **user-facing authorization is the existing workspace/cohort/role gate already applied to the search hit** before the CTA is computed. A user can only ever see a CTA for a hit they were already allowed to see. Defense-in-depth RLS policy: `content_unlock_map` rows readable when the joined package's coach shares a workspace with the requester (mirrors classroom RLS).
- **Write (manage edges):** only the **owning coach** of the package (`CoachPackage.coach_id = auth.uid()`), or `owner` role (D6 future superset). No client writes, ever. Enforced both in the controller guard and an RLS `WITH CHECK`.

### 2.7 Performance

- Hot query `getPackagesForContent(contentId, contentKind)` → covered by `@@index([content_kind, content_id, removed_at])`: a single index range scan returning typically 1–3 rows. Sub-millisecond.
- At search-result scale (up to `SEARCH_PAGE_LIMIT_MAX = 50` hits per page, `communitySearchApi.ts:35`), naive per-hit lookup = 50 index seeks. We **batch**: collect the gated `(kind, id)` pairs in the page and issue one `WHERE (content_kind, content_id) IN (...)` query, then attach in-memory. One round-trip per page, not per hit.
- Layer the in-process LRU cache (Section 3.3) on top, keyed by `(kind, id)`, so repeat searches and pagination reuse resolved CTAs.

---

## Section 3 — Backend API additions

### 3.1 Where it injects

The search service already maps repo rows → DTO rows at one site (`community-search.service.ts:110-115`):

```ts
const results: SearchResultRow[] = pageRows.map((r) => ({
  id: r.id, kind: r.kind, targetId: r.target_id,
  cohortId: r.cohort_id, authorId: r.author_id, excerpt: r.excerpt, /* ... */
}));
```

We extend this to a two-phase map: (1) build the rows, (2) batch-resolve and attach `unlock_cta` for gated rows.

### 3.2 Service signature

```ts
// content-unlock.service.ts (new)
interface UnlockCtaContext {
  userId: string;
  role: 'client' | 'coach' | 'owner';
  workspaceId: string;
  // The user's coach (for message_coach CTAs). Resolved once per search, not per hit.
  primaryCoachUserId?: string | null;
}

interface ResolvedUnlockCta {
  kind: 'purchase' | 'message_coach' | 'upgrade';
  label: string;
  // purchase-specific
  package_id?: string;
  package_name?: string;
  package_price?: { amount: number; currency: string };  // amount in minor units (cents)
  purchase_url?: string;       // deep link, see Section 5.2
  // context
  target_user_id?: string;     // coach to message / etc.
  // display copy (edge override → package default → flag fallback)
  headline?: string;
  subheadline?: string;
  image_url?: string;
}

class ContentUnlockService {
  /**
   * Batch resolver. For each gated hit, returns the canonical unlock CTA (or
   * the flag-fallback upgrade CTA when no package edge exists). NON-gated hits
   * and hits the user already owns return undefined (no CTA attached).
   */
  async resolveForHits(
    hits: ReadonlyArray<{ kind: CommunitySearchKind; targetId: string }>,
    ctx: UnlockCtaContext,
    flags: EvaluatedFlags,           // from the feature-flag evaluator (D2/D3)
  ): Promise<Map<string /* targetId */, ResolvedUnlockCta>>;
}
```

**Gating logic per hit (D1 + D2):**
1. If `hit.kind` does not map to a disabled flag (`kindToFlag`, spec §4) → no CTA.
2. If the user already has `entitlement_active` for a package that unlocks this content → no CTA (it's actually open; see Section 7 stale-flag case).
3. Else, look up `content_unlock_map`:
   - rows found → `purchase` CTA on the canonical package (Section 2.4).
   - no rows (orphan) → flag fallback (`upgrade`) per D1 (`community_classroom` → "Upgrade to access lessons", `community_events` → "Upgrade to access events").
   - coach-message override case → `message_coach` (OPEN Q3 on when this is chosen).

### 3.3 Caching strategy

**Mirror the shipped in-process LRU pattern, NOT Redis.** The repo's analogous cache is `triage-cache.service.ts` (`[backend] src/community/ai-triage/triage-cache.service.ts:1-45`): an insertion-ordered `Map` with 5-min TTL, a content `freshnessKey` fingerprint, `MAX_CACHE_ENTRIES=1000`, opportunistic TTL sweep, R69 "zero schema diff". **There is no Redis provisioned in this repo today** (DECISIONS.md D4 makes Redis conditional). So:

- **Cache shape:** key = `(content_kind, content_id)`; value = the *package-resolution* (canonical package id + name + price + edge copy) — i.e. the **content→package** part, which is user-independent and changes rarely.
- **Do NOT cache the per-user CTA** (entitlement + coach identity are user-specific). Cache only the expensive content→package resolution; compose the user-specific bits (already-owned check, message-coach target) on each request from cheap indexed reads (`ClientPurchase` `@@index([client_user_id, status])`).
- **`freshnessKey`** = count of live edges for the content + max(`updated_at`). A coach re-tagging content changes it → auto-invalidate, exactly like triage.
- **Explicit invalidation** on package archive / edge mutation / purchase webhook (Section 5.4).
- Bounded (`MAX_CACHE_ENTRIES`), process-restart-safe (miss = recompute).

### 3.4 The `unlock_cta` payload (extends D1)

D1's locked base is `{ kind, target_id?, label }`. This plan **extends it additively** with purchase fields (matching the brief's `UnlockCTA` interface). On the wire for the search slice the convention is **camelCase** (`communitySearchApi.ts:21-24` documents this explicitly, and DECISIONS.md "Bonus" warns NOT to confuse it with the snake_case flags endpoint):

```ts
interface UnlockCTA {
  kind: 'purchase' | 'message_coach' | 'upgrade';
  label: string;
  // purchase-specific
  packageId?: string;
  packageName?: string;
  packagePrice?: { amount: number; currency: string };  // minor units
  purchaseUrl?: string;
  // context
  targetUserId?: string;
  // display copy
  headline?: string;
  subheadline?: string;
  imageUrl?: string;
}
```

> **Casing reconciliation (IMPORTANT):** D1's example uses snake_case (`target_id`). But the search slice wire is camelCase and `SearchResultRowSchema` is `.strict()` (`communitySearchApi.ts:60`). Emitting snake_case `unlock_cta` keys into a camelCase, strict schema would throw a `contract` error on mobile. **This plan standardizes `unlockCta` (camelCase) for the search slice**, consistent with that slice's documented convention, and flags the D1-example discrepancy as **OPEN Q1** for Bradley to ratify (it is a wire-contract decision, not mine to make unilaterally).

---

## Section 4 — Mobile UX: the Luxury Unlock CTA Page

A new screen `UnlockCtaScreen` (in `src/screens/community/`), reached when `CommunityFindScreen.open()` (`CommunityFindScreen.tsx:80`) is called for a hit carrying `unlockCta`, instead of navigating to the detail screen.

> **Emotional target (P1, `LUXURY_DESIGN_DOC.txt:289` Screen Protocol Step 1):** *when the user leaves this screen they should feel **reassured and capable** — "this content is worth it, and buying is safe and simple"* — not merely "informed". Every choice below serves that target.

### 4.1 Layout (wireframe)

```
┌─────────────────────────────────────────────┐
│  ‹ Back                                       │  ← ThreadHeader-style, hairline border
├─────────────────────────────────────────────┤
│                                               │
│        [ optional hero image, 16:9 ]          │  ← imageUrl; if absent, a calm
│        (cream surface, radius.lg = 4)         │     forest-tinted placeholder block
│                                               │
│   LOCKED LESSON              ← eyebrow token  │  ← typography.eyebrow, textMuted
│                                               │
│   Squat Mechanics 101        ← h1 (Cormorant) │  ← headline; typography.h1
│                                               │
│   Strength Program 2.0 includes 47 lessons,   │  ← subheadline; typography.body, textMuted
│   a full mesocycle, and weekly check-ins.     │
│                                               │
│   ── what unlocking includes ──               │  ← caption eyebrow, optional bullet list
│   • 47 progressive lessons                    │     (Ionicons checkmark-outline, NOT emoji)
│   • Lifetime access                           │
│   • Direct coach feedback                     │
│                                               │
│                                               │
│   (scrolls if content overflows)              │
│                                               │
├─────────────────────────────────────────────┤  ← pinned footer (safe-area)
│  ┌─────────────────────────────────────────┐ │
│  │   Buy Strength Program 2.0 — $149        │ │  ← PRIMARY CTA; accent fill, radius.sm=0
│  └─────────────────────────────────────────┘ │     full-width, min 48pt height
│            Not now                            │  ← secondary text link; accentText
└─────────────────────────────────────────────┘
```

### 4.2 Information architecture

- **Above the fold:** eyebrow (locked-kind label) + headline + the package name/price implicitly previewed. The user knows in one glance *what this is* and *what unlocks it*. (**P4 Apple "one thing" test, `LUXURY_DESIGN_DOC.txt:284`:** this screen is describable in one sentence — "where the user unlocks a locked item.")
- **Show the payoff before the effort (P3, `:45`, `:307`).** The "what unlocking includes" value list is placed *before/around* the price, so the user sees the **goal state** ("47 progressive lessons, lifetime access, coach feedback") before being asked for the effort (payment). We *"show the user what they will gain"* (`:307`) — never a bare "you can't see this." This is also the doc's *"never punish silently"* (`:61`): a locked item explains its value and offers a path.
- **Pinned footer — one irresistible primary path (P4 Hick's Law, `:234-238`).** The primary CTA is always reachable without scrolling (conversion-critical) and is the single visually-dominant action; *"secondary options should be visually de-emphasized"* (`:238`) — hence the lone, muted "Not now" text link. **Miller's Law (`:226`, ≤5 actionable elements):** the screen has exactly **two** tappable controls (Buy, Not now) + Back — well under the cap, so working memory is never taxed.

### 4.3 Typography (cite doctrine tokens by name — all from `tokens.ts:142-226`)

| Element | Token | Notes |
|---|---|---|
| Locked-kind eyebrow | `typography.eyebrow` | uppercase, letterSpacing 1.98, Inter 500 |
| Headline | `typography.h1` | Cormorant Garamond 400, size 32 — **never** bump weight |
| Subheadline / value copy | `typography.body` | Inter 400, lineHeight 26 |
| "What's included" section label | `typography.caption` | Inter 500 |
| Value bullets | `typography.bodySmall` | Inter 400 |
| CTA button label | `typography.bodyMd` (size 16, weight 500) | **max weight 500 on display; 600 only via `micro`/`Inter_600SemiBold` if needed — never 700/800** |
| "Not now" link | `typography.bodySmall` | accentText color |

### 4.4 Color (all from `tokens.ts:371-418` semantic tokens — never raw hex)

| Surface | Token |
|---|---|
| Screen background | `bgPrimary` (bone `#F5EFE4` / dark `#121110`) |
| Hero / value card | `bgSurface` (`#FFFDF8` / `#1C1A18`) |
| Headline text | `textPrimary` |
| Subheadline / muted | `textMuted` |
| **Primary CTA fill** | `accent` (oxblood `#4A0404` light / `#B43C3C` dark) |
| **Primary CTA label** | `textOnAccent` (warm near-white `#FBF7F0`, ~15:1 light / ~5.38:1 dark — both AA pass) |
| "Not now" link | `accentText` (`#4A0404` / lifted rose `#E07373`) |
| Hairlines / card border | `border` |
| Disabled CTA (mid-checkout) | `disabledBg` + `textOnDisabled` (never parent-opacity, per token doc `tokens.ts:348-360`) |

Single accent (forest is the brand accent in doctrine §5, but the semantic CTA accent is oxblood `accent`). No second color, no gradient, no glow.

### 4.5 Motion (`tokens.ts:281-296`) — Phantom CALM, reconciled with Quiet Luxury

The research doc's CALM framework prescribes *"a calming transition animation that begins before the anxiety moment … it modulates the emotional baseline so the user enters the decision in a more relaxed state"* (`LUXURY_DESIGN_DOC.txt:89`). We honor the **calming** intent while obeying the doctrine's ban on springs/celebration:

- **Entry:** single fade-in, `motion.duration.base` (400ms) with `motion.easing.decel` — a calm settle that primes the purchase decision (P2/CALM-Animation, `:89`). **No slide-up spring, no scale pop** (repo Doctrine §3/§5 — springs deleted; this is where CALM's "animation" is delivered as restraint, not bounce).
- **Button press:** opacity dip via `HapticPressable` (already used in `CommunityFindScreen.tsx:172`), `intent="medium"` for a purchase action — the *"tight haptics"* the doc credits with *lowering perceived risk and increasing willingness to proceed with high-commitment actions* (`:79`). No scale bounce.
- **Loading → loaded:** cross-fade the skeleton to content over `base`.
- **Success/error:** no celebration (doctrine). Per the Section 0 reconciliation, the Peak-End closure (`:300-301`) is delivered by **routing straight into the unlocked content** (Section 5.3), not a trophy. Error is a calm inline state (4.7) — *error states as trust-building*, `:101`.

### 4.6 Copy (exact microcopy)

- **Eyebrow:** `LOCKED LESSON` / `LOCKED EVENT` (uppercase via token).
- **Headline (purchase):** the content title (e.g. `Squat Mechanics 101`) — *or* `unlockCta.headline` if the coach set one.
- **Subheadline (purchase):** `unlockCta.subheadline` ?? `"{packageName} includes everything you need to follow along."` — plain, no em-dashes, no exclamation (Doctrine §4).
- **Primary button:** `Buy {packageName} — {formattedPrice}` (e.g. `Buy Strength Program 2.0 — $149`). *(The em-dash here is a price separator inside a button label, not marketing-cadence prose; if Bradley reads doctrine §4 strictly, swap to `Buy Strength Program 2.0 · $149` with a middot — OPEN Q5.)*
- **Secondary:** `Not now` (returns to results). **Not** "Maybe later", not "Skip" — calm and neutral.
- **Upgrade fallback headline:** `Unlock lessons` / `Unlock events`; button `View upgrade options`.
- **Message-coach:** button `Message {coachФirstName}`; subheadline `"Ask your coach about getting access."`

No "Coming Soon", no "Premium!", no hype (Doctrine §2, §4, enforced by tests). The plain, explanatory voice is also P2/CALM-Clarity from the research doc: *"Replace jargon with plain language. Write every label as if explaining to a smart first-time user"* (`LUXURY_DESIGN_DOC.txt:88`) and *"Text explains rather than intimidates"* (`:76`).

### 4.7 States

| State | Render |
|---|---|
| **loading** | branded skeleton: eyebrow bar + headline bar + 2 body bars + a full-width accent button bar. Reuse the `CheckoutLoadingSkeleton` shape from `BrandedCheckoutWebViewScreen.tsx:499` (proven, reduce-motion-aware). `accessibilityRole="progressbar"`, label "Loading". |
| **error (network — CTA fetch failed)** | calm centered state, `Ionicons name="alert-circle-outline"`, copy "We couldn't load this. Please try again.", a pill "Try again" — mirror `CommunityFindScreen.tsx:203-227` exactly. No raw error codes on the unlock surface (codes belong on the checkout webview only). **P2, `LUXURY_DESIGN_DOC.txt:101`:** *"Treat error states as trust-building opportunities … 'We couldn't process that — try again or contact support' builds trust"* — the warm, sympathetic, actionable error is the design, not an afterthought. |
| **success-redirect (post-purchase)** | NOT a screen. After checkout success, `CheckoutReturn` runs the existing confirm flow; we then pop back to the search result and the (now-owned) hit navigates normally (Section 5.3). No trophy, no confetti (Doctrine §3). |

### 4.8 Accessibility

- **Contrast:** all pairs use semantic tokens already verified AA in `tokens.ts` (CTA `textOnAccent` on `accent` ≥ 5.38:1 both modes; `textMuted` ≥ 4.9:1; `accentText` ≥ 5.68:1 dark — `tokens.ts:319-405`).
- **Dynamic type:** all sizes come from tokens (no hardcoded px); `Text` inherits OS scaling. The pinned footer uses min-height (48pt) + `numberOfLines` guards on the headline so large type degrades gracefully.
- **Screen reader:** primary CTA `accessibilityRole="button"`, `accessibilityLabel="Buy Strength Program 2.0, 149 dollars"`, `accessibilityHint="Opens secure checkout."`. The locked context is announced (`accessibilityLabel` on the header region: "Locked lesson, Squat Mechanics 101"). "Not now" labeled "Return to search results."

### 4.9 Variant per CTA kind

| `kind` | Primary button | onPress |
|---|---|---|
| `purchase` | `Buy {packageName} — {price}` | mint checkout → push `BrandedCheckoutWebViewScreen` (Section 5) |
| `message_coach` | `Message {coachName}` | navigate to the existing chat thread with `targetUserId` |
| `upgrade` | `View upgrade options` | navigate to a packages-list screen (storefront/upgrade list) |

### 4.10 Doctrine test compliance — every invariant from `quietLuxuryDoctrine.test.ts`

The screen lives in `src/screens/community/` so it IS scanned (`quietLuxuryDoctrine.test.ts:17-20`). Each invariant:

1. **`fontWeight 700/800` banned** (`:72`) — design uses only token weights ≤ 600 (`bodyMd`=500, `micro`=600). **Pass.**
2. **No "Coming Soon"/"In Development"/"Planned"** (`:83`) — copy is "Buy …", "Not now", "Upgrade options". **Pass.**
3. **No TODO/FIXME/XXX** (`:93`) — none in shipped file; deferrals go to R82 issues, not comments. **Pass.**
4. **No trophy/confetti/FirstWinCelebration** (`:103`) — success routes away with no celebration. **Pass.**
5. **No `Ionicons name="flame"`** (`:114`) — we use `alert-circle-outline`, `checkmark-outline`, `lock-closed-outline`. **Pass.**
6. **No `Ionicons name="trophy"`** (`:125`) — same. **Pass.**
7. **No `BadgeCabinet`** (`:135`) — n/a. **Pass.**
8. **No `'streak'` union in notificationsDb** (`:145`) — this screen doesn't touch that file. **Pass.**
9. **No `Leaderboard` in shipped screens** (`:153`) — n/a. **Pass.**
10. **No pictograph emoji** (`:169`) — no emoji; checkmarks use Ionicons line glyphs. **Pass.**

Additional doctrine (from `QUIET_LUXURY_DOCTRINE.md`, not all test-enforced but reviewer-enforced):
- **§5 radius:** card/sheet corners `radius.lg=4`, CTA `radius.sm=0`; no 16/20/24. **Pass.**
- **§4 no exclamation marks** in UI copy. **Pass** (periods only).
- **§5 shadows ≤ `shadows.lg`.** Page uses card `shadows.md` at most. **Pass.**
- **§6 no floating widgets/FAB** — CTA is a pinned in-flow footer, not a floating FAB. **Pass.**
- **§8 README rule** — the build PR MUST update `src/screens/community/README.md` + `src/navigation/README.md` (new route) + record the new backend dependency. **Build requirement, noted in Section 9.**

---

## Section 5 — Checkout wiring

### 5.1 The tap → checkout sequence (purchase variant)

1. User taps `Buy {packageName} — {price}` on `UnlockCtaScreen`.
2. Screen calls `publicPackagesApi.createCheckoutSession(unlockCta.packageId, {})` (`packagesApi.ts:543`). Idempotency-Key auto-attached.
3. Backend mints branded Stripe session, returns `{ url }` (`CheckoutSessionResponse`, `packagesApi.ts:278`).
4. Screen pushes `BrandedCheckoutWebViewScreen` with params `{ checkoutUrl: url, packageName, returnScheme: PACKAGE_CHECKOUT_RETURN_SCHEME }` (`BrandedCheckoutWebViewScreen.tsx:69`, `packagesApi.ts:48`).
5. **No new checkout infra is built** — this is the same path the storefront already uses.

### 5.2 Deep-link format

The `purchaseUrl` field in `unlockCta` is **optional and informational**; the canonical wiring is to mint the session client-side via `createCheckoutSession(packageId)` (so the app never embeds a Price id). The success/cancel return URLs are the existing constants (`packagesApi.ts:49-51`):
- success: `com.growthproject.app://checkout/success?session_id={CHECKOUT_SESSION_ID}`
- cancel: `com.growthproject.app://checkout/cancel`

If Bradley wants a *shareable* unlock deep link (push notification → unlock page), define an app route `com.growthproject.app://unlock/{kind}/{contentId}` that opens `UnlockCtaScreen` and lazily fetches the CTA — **OPEN Q6** (deferred; not needed for the search flow).

### 5.3 Pre/post-purchase state

- On success, `BrandedCheckoutWebViewScreen` already routes to `CheckoutReturn` (`BrandedCheckoutWebViewScreen.tsx:229-235`) which runs the confirm flow.
- **Return-to-result behavior:** after confirm, pop back past `UnlockCtaScreen` to `CommunityFindScreen`. The gated hit should now be openable. **Does it unlock immediately?** Only if the entitlement is realized synchronously — which it is **not guaranteed to be** (Stripe webhook is async; `entitlement_active` flips on `checkout.session.completed`). So:
  - Optimistic UX: on confirmed success, invalidate the search query (and the per-hit CTA cache) so the next render re-fetches; the hit's `unlockCta` disappears once entitlement is live and the hit opens normally.
  - There may be a brief window (seconds) where the webhook hasn't landed. During it, tapping the hit should show a calm "Finishing your purchase…" state, not the buy CTA again. The CTA resolver's already-owned check (Section 3.2 step 2) handles this once the webhook lands; the gap window is the stale-flag case (Section 7 / OPEN Q7).

### 5.4 Webhook → cache invalidation

- The backend learns of purchase via the existing Stripe webhook (`checkout-webhook-handler.service.ts`), which flips `ClientPurchase.entitlement_active` and triggers `PurchaseFanout`.
- **There is no Redis pub/sub in this repo** (the spec's phrasing is aspirational; the shipped pattern is the in-process LRU — Section 3.3, `triage-cache.service.ts`). So invalidation is:
  - The unlock-CTA cache is keyed by `(content_kind, content_id)` and stores the *content→package* resolution, which a purchase does **not** change → no invalidation needed there.
  - The *user-specific* already-owned check is computed fresh per request from `ClientPurchase` (cheap indexed read), so it picks up the new entitlement on the next request automatically — no cache to bust.
  - Therefore the only cross-process concern is multi-instance staleness of the content→package map, which the `freshnessKey` (edge count + max updated_at) already auto-invalidates.
- If/when Redis is provisioned (DECISIONS.md D4, Section 8 R82), the same key shape lifts to Redis with pub/sub on edge mutation; the user-specific composition stays uncached.

---

## Section 6 — Coach-side experience (data model must support; UI deferred to Wave 1.6)

For coaches to USE the system they must be able to:

1. **Tag content with packages.** A coach opens a classroom lesson / event in their authoring surface and selects "Unlocked by package(s) →" choosing one or more of their published packages. Each selection writes a `ContentUnlockMap` row (`source='coach'`).
2. **Mark a canonical package.** Among selected packages, one is starred as canonical (`is_canonical=true`, partial-unique enforced). If only one is selected it is canonical by default.
3. **Bulk-tag.** "Unlock all lessons in cohort X with package P" expands to per-leaf rows at write time (Section 2.3).
4. **Customize CTA copy/imagery per edge.** Optional `cta_headline`, `cta_subheadline`, `cta_image_url` on the edge (so the same package pitches differently for a lesson vs. an event).

**Coach write API (design, build in Wave 1.6):**
```
POST   /v1/coach/content-unlocks        { content_kind, content_id, package_id, is_canonical?, cta_* }
DELETE /v1/coach/content-unlocks/:id    (soft-delete; sets removed_at)
PATCH  /v1/coach/content-unlocks/:id    (toggle canonical / edit copy)
GET    /v1/coach/packages/:id/unlocks   (everything package P unlocks — uses @@index([package_id, removed_at]))
```
All mutations carry an `Idempotency-Key` (matching the codebase convention, `packagesApi.ts:290`) and are authorized to the owning coach only (Section 2.6). The **data model in Section 2 fully supports this** — only the screens/endpoints are deferred. **This deferral is an R82 (Section 8).**

---

## Section 7 — Failure modes & edge cases

| Case | Behavior |
|---|---|
| **Orphan content (no package edge)** | Fall to D1 flag fallback: `upgrade` CTA ("Upgrade to access lessons/events"). Honest, no fake package. **OPEN Q4** asks whether orphan should instead say "Contact coach". |
| **User already owns the package, flag still false (stale eval)** | The resolver's step-2 already-owned check (reads `ClientPurchase.entitlement_active`) suppresses the CTA so the hit opens normally. If the search query was cached pre-purchase, invalidate-on-success (Section 5.3) forces a re-fetch. Worst case: a brief "Finishing your purchase…" state, never a wrongful buy prompt. **Graceful refresh path:** pull-to-refresh on results re-runs search → fresh CTA resolution. |
| **Package deleted/archived but content still references it** | The resolver filters candidates to `archived_at IS NULL AND published_at != null AND is_sellable`. An archived canonical is skipped → tie-break picks the next live package; if none, falls to `upgrade`. A nightly/edge-mutation job soft-removes (`removed_at`) edges pointing at archived packages so the map self-heals. |
| **Multiple coaches own variants of the "same" content with different packages** | Content ids are globally unique per table, so two coaches' lessons are *different content ids* — no real collision. Within one content item, multiple packages → canonical logic (Section 2.4) disambiguates. |
| **Free content gated by flag only (no purchase needed)** | Distinguish via the edge's absence + cohort membership. If the content is unlocked by *joining a cohort the user can already join for free*, the CTA `kind` should be `upgrade`/membership-join, label "Free — join to access", NOT "Buy". This requires the resolver to know "is this free-on-membership?" — which today it cannot infer (no cohort↔package free-tier signal). **OPEN Q4 + an R82** to model a `free_on_membership` edge type. v1 default: orphan free content shows the `upgrade` fallback. |

---

## Section 8 — R82 follow-ups identified

Per `R82_TRACKING_ISSUE_DISCIPLINE.md`, each of these MUST become a GitHub tracking issue (6 sections, owner = Bradley Gleave) when the build lane starts. Listed here for the build subagent to file.

| # | Title | Description | Why deferred (not blocking W1.5 BIG) | Priority |
|---|---|---|---|---|
| R82-A | **Coach content-unlock tagging UI** | The coach-facing screens + `/v1/coach/content-unlocks` endpoints (Section 6). | Data model ships in W1.5; the authoring UI is a separate surface. But it's near-critical (without it most content stays orphan → `upgrade` fallback). | **P1** |
| R82-B | **Partial unique index for canonical** | Raw-SQL `CREATE UNIQUE INDEX … WHERE is_canonical AND removed_at IS NULL` (Prisma can't express it). | Migration detail; must land *with* the table. | P1 (in-PR) |
| R82-C | **Redis for unlock-CTA + flag caching** | Replace in-process LRU with Redis + pub/sub once provisioned (ties to DECISIONS.md D4). | No Redis in repo today; LRU is sufficient at current scale. | P2 |
| R82-D | **Free-on-membership edge type** | Model content that's free upon cohort join vs. purchase (Section 7 free case). | Needs a product decision (OPEN Q4) + cohort↔tier signal that doesn't exist yet. | P2 |
| R82-E | **Cohort↔package auto-backfill signal** | The `auto_membership` backfill (Section 2.5) can't infer edges today because there's no cohort↔package link (G3). | Backfill degrades to empty gracefully; coaches tag manually. | P2 |
| R82-F | **Per-client coach access grants** | "Coach grants client X access to lesson Y" override table + audit (DECISIONS.md D6 explicitly defers this). | D6 locks it out of v1. | P3 |
| R82-G | **Shareable unlock deep link** | `com.growthproject.app://unlock/{kind}/{id}` route (Section 5.2, OPEN Q6). | Not needed for the in-app search flow. | P3 |
| R82-H | **Self-healing edge cleanup job** | Soft-remove edges pointing at archived/deleted packages (Section 7). | Resolver already filters live packages at read time, so this is hygiene not correctness. | P3 |

---

## Section 9 — Build order recommendation (for the build subagent)

1. **Backend: `content_unlock_map` table + migration** (incl. partial unique index R82-B). Nothing else can resolve without the edges. *Must precede everything.*
2. **Backend: `ContentUnlockService.resolveForHits()` + `kindToFlag` reuse** — depends on (1) and on the feature-flag evaluator (DECISIONS.md D3, separate spec). Unit-test the canonical/tie-break/orphan/owned branches.
3. **Backend: wire resolver into `community-search.service.ts` map site** (`:110`) — attach `unlockCta` to gated hits; in-process LRU cache (Section 3.3); update `community-search.dto.ts` SearchResultRow.
4. **Backend: perf + contract tests** — batch lookup ≤ 1 round-trip/page; camelCase wire; existing search RLS unaffected.
5. **Mobile: extend `SearchResultRowSchema` with optional `unlockCta`** (`communitySearchApi.ts:50`) — coordinated, since it's `.strict()`. This is the schema change DECISIONS.md D1 flagged as a follow-up.
6. **Mobile: `UnlockCtaScreen`** + route registration + intercept in `CommunityFindScreen.open()` (`:80`). Wire purchase variant onto existing `createCheckoutSession` → `BrandedCheckoutWebViewScreen`.
7. **Mobile: states + a11y + doctrine pass** (Section 4); run `quietLuxuryDoctrine.test.ts`.
8. **Mobile: invalidate-on-success** (Section 5.3) + the brief "finishing purchase" window.
9. **READMEs** (Doctrine §8): `src/screens/community/README.md`, `src/navigation/README.md`, dependency note.
10. **(Wave 1.6) Coach tagging UI** (R82-A) — without it, ship with `upgrade` fallbacks and a seeded/manual edge set for launch content.

> Steps 1–4 are backend-only and can land first (mirrors DECISIONS.md D1 "backend ships data first; mobile catches up"). Steps 5–9 are the mobile catch-up PR. Step 10 is a follow-up wave.

---

## Section 10 — Open questions for Bradley (MUST be answered before build)

- [ ] **OPEN Q1 — `unlock_cta` wire casing.** D1's example shows snake_case (`target_id`), but the search slice wire is **camelCase** and its Zod is `.strict()` (`communitySearchApi.ts:60`). I recommend **camelCase `unlockCta`** for consistency with that slice (snake_case would throw a `contract` error on mobile). *Trade-off:* matches the slice but technically diverges from D1's illustrative snippet. Confirm camelCase is the contract.
- [ ] **OPEN Q2 — Canonical default ordering.** When no `is_canonical` is set and multiple packages unlock content: prefer **cheapest unlock** (my default — highest conversion, honest minimum) or **most-popular/highest-AOV bundle** (drives revenue)? *Trade-off:* conversion vs. AOV.
- [ ] **OPEN Q3 — When does `message_coach` win over `purchase`?** If a coach hasn't tagged a package but the user has an assigned coach, do we show "Message Coach" instead of the `upgrade` fallback? *Trade-off:* warmer/human vs. self-serve conversion.
- [ ] **OPEN Q4 — Orphan & free-content copy.** Orphan gated content: show **"Upgrade to access"** (my default, D1) or **"Contact your coach to unlock"** (no purchase path)? And for free-on-membership content, what's the label ("Free — join to access")? *Trade-off:* honesty vs. dead-ends; depends on whether orphan content should ever appear in search at all.
- [ ] **OPEN Q5 — Price separator in button label.** `Buy Strength Program 2.0 — $149` uses an em-dash; Doctrine §4 discourages em-dashes in copy. Use a **middot** `· $149` or a **comma**? *Trade-off:* strict doctrine vs. familiar pricing convention. (Low stakes, but the doctrine test reviewers will look.)
- [ ] **OPEN Q6 — Shareable unlock deep link.** Do we want `…://unlock/{kind}/{id}` for push/share campaigns now, or defer (R82-G)? *Trade-off:* marketing reach vs. scope.
- [ ] **OPEN Q7 — Post-purchase entitlement window UX.** Between checkout success and the Stripe webhook flipping `entitlement_active`, the hit isn't openable yet. Show a **"Finishing your purchase…" interstitial** (my default) or **optimistically open** and risk a transient empty detail screen? *Trade-off:* correctness vs. perceived speed.

---

## Section 11 — LUXURY_DESIGN_DOC.txt citation index

Every UX principle applied in this doc, traced to its source line in `design-reference/LUXURY_DESIGN_DOC.txt`. (Format: principle → line(s) → where applied here.)

| # | Principle / quote | `LUXURY_DESIGN_DOC.txt` line | Applied in |
|---|---|---|---|
| C1 | *"Before writing a single line of code … ask: How will this make the user feel?"* | `:10` | Section 0 P1; Section 4 emotional target |
| C2 | Screen Protocol Step 1 — *"When the user leaves this screen, they should feel ___"* | `:289` | Section 0 P1; Section 4 preamble |
| C3 | Don Norman's three levels (visceral/behavioral/reflective) | `:11-22` | Section 0 (why polish matters first impression); 4.4 visceral palette |
| C4 | Duolingo — *"Show the payoff before the effort"* | `:45` | Section 0 P3; Section 4.2 value-before-price |
| C5 | Onboarding Screen 4 — *"the value moment … show the user what they will gain"* | `:307` | Section 0 P3; Section 4.2 |
| C6 | *"never punish silently"* (streak recovery / reset) | `:61` | Section 0 P5; Section 4.2/4.6 (locked state explains value) |
| C7 | Phantom — *"polish functions as trust in high-stakes domains … every micro-interaction is a data point the user's brain uses to assess risk"* | `:78` | Section 0 P2 (the governing principle); 4.5 motion |
| C8 | *"Smooth transitions, tight haptics … lower perceived risk and increase willingness to proceed with high-commitment actions"* | `:79` | Section 4.5 (haptic on Buy) |
| C9 | CALM framework — Clarity / Animation / Light feedback / Mascot | `:87-91` | Section 0 P2; 4.5 (Animation), 4.6 (Clarity), 4.7 (Light feedback) |
| C10 | CALM-Clarity — *"Replace jargon with plain language … explaining to a smart first-time user"* | `:88` | Section 4.6 copy |
| C11 | Phantom — *"Text explains rather than intimidates"* | `:76` | Section 4.6 copy voice |
| C12 | *"Treat error states as trust-building opportunities"* | `:101` | Section 4.7 error state |
| C13 | Apple — *"every screen should have one primary path (70–80% of users) … secondary options visually de-emphasized"* | `:238` | Section 0 P4; 4.1/4.2 single CTA + muted "Not now" |
| C14 | Miller's Law — ≤5 actionable elements / chunking | `:226-227` | Section 4.2 (2 controls + Back) |
| C15 | Hick's Law — *"Make the Default Path Irresistible"* + smart defaults | `:234-239` | Section 0 P4; 4.1 pinned CTA; canonical pkg = smart default (§2.4) |
| C16 | Progressive disclosure — reveal only what the current task needs | `:246-252` | Section 4.2 (value list scrolls; detail deferred) |
| C17 | 80/20 — *"the one thing test: every screen describable in one sentence"* | `:284` | Section 4.2 "one thing" check |
| C18 | Screen Protocol Steps 2,4,5 (primary path, Miller, Hick) | `:290-297` | Section 4.1/4.2 layout discipline |
| C19 | Peak-End Rule + explicit closure state (Step 7) | `:300-301` | Section 0 P5; 5.3 (route into content = closure) |
| C20 | Anti-Pattern 4 — *"The Empty Confirmation"* (peak moments need design) | `:336-337` | Section 0 P5 reconciliation (closure via immediacy, not confetti) |
| C21 | Consistency — *"if blue is primary on screen A, it must be primary A→Z"* | `:267-276` | Section 4 reuse of existing skeleton/error/HapticPressable patterns |
| C22 | Fogg B=MAP — reduce **ability** friction; ≤3 taps to complete | `:404-409` | Section 5.1 (Buy → mint → webview is the shortest path; one tap to checkout) |

**Conflict resolved against the research doc (documented in Section 0):** the doc's celebration/peak prescriptions (`:196`, `:336-337`) are *overridden* by the repo Quiet Luxury Doctrine + `quietLuxuryDoctrine.test.ts`, per the hard constraint to redesign rather than weaken a doctrine test. The peak/closure is re-expressed as *restraint + immediacy*.

---

## Appendix — why this is mostly an assembly job, not a greenfield build

Of the six systems the flow needs, **four already exist and ship today**: the checkout session minting (`packagesApi.ts`), the branded webview + deep-link return (`BrandedCheckoutWebViewScreen.tsx`), the entitlement source of truth (`ClientPurchase.entitlement_active`), and a reverse-lookup index pattern (`CoachPackageContent.@@index([asset_type, asset_id])`). The doctrine, tokens, and search slice are all in place. **The genuinely new work is narrow:** one mapping table + one resolver service + one search-handler injection + one mobile screen + one strict-schema field. The risk is not technical complexity — it's **product completeness** (orphan content / canonical ambiguity / coach tagging UI), which is exactly why Section 10's seven questions gate the build.
