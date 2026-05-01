# Spec — Coach content boards (PDFs / newsletters / videos / links)

**Roadmap row:** #33.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.
**Handoff brief:** [`../architecture/handoff/33-content-boards.md`](../architecture/handoff/33-content-boards.md).
**Cross-references:** PR #117 RFC §3 (`CoachAsset` / `CoachAssetChunk`)
and §8 (Supabase Storage prefix); PR #121 spec
[`program-templates.md`](./program-templates.md) (#28 — coach-private
vs platform-curated split); merged `Lesson`
(`prisma/schema.prisma:554`); PR #120 platform-readiness lanes 01,
03, 04, 11.

---

## 1. Status

Net-new feature. PR #117 ingests coach assets *for AI drafting*;
this spec surfaces those assets *to clients* as a curated reading
list. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #33."

## 2. WHY

A coach's competitive edge often lives outside their structured
programs:

- A monthly *newsletter* PDF.
- A list of recommended *links* (articles, podcasts).
- An unlisted *video library* (form-check loops, mindset
  intros).
- A weekly *PDF pack* (recipes, reading material).

Today, a coach distributes these through email, DMs, or a
third-party Notion. None of those routes is gated by
`ClientCoachConsent`, none of them is auditable, and none of
them sits in the same surface where the client already opens
their workouts.

Content boards are the **distribution surface** for
already-ingested coach assets. The same `CoachAsset` row that
powers AI drafting in PR #117 can be linked from a content board
to a client; the client opens the platform, sees the board,
clicks the asset, and the platform tracks the view.

## 3. WHEN

Trigger conditions:

1. PR #117 RFC §8 (Supabase Storage prefix and mime allow-list)
   is reviewed against this spec to confirm the prefix is reused
   and the mime allow-list is the same union.
2. Spec #32 (avatar media) is reviewed if a coach-side
   "newsletter cover image" is required (it is; §10 of this
   spec uses the avatar resolver convention for the cover
   image).
3. Spec #34 (regimens) is in-flight or reviewed; a content
   board may be linked from a regimen week as supplementary
   reading.
4. Founder signs off on the per-board byte ceiling and the
   per-tier byte ceiling (#37).

## 4. WHERE

- **New module:** `src/content-boards/` —
  `content-boards.module.ts`,
  `content-boards.controller.ts`,
  `content-boards.service.ts`,
  `items.controller.ts`,
  `views.service.ts`.
- **New tables:** `ContentBoard`, `ContentBoardItem`,
  `ContentBoardView`, `ContentBoardSubscription`.
- **New routes (paths under `/api/`):**
  - Coach CRUD:
    - `GET /coach/content-boards`
    - `POST /coach/content-boards`
    - `PATCH /coach/content-boards/:id`
    - `POST /coach/content-boards/:id/archive`
    - `POST /coach/content-boards/:id/items`
    - `DELETE /coach/content-boards/:id/items/:item_id`
    - `POST /coach/content-boards/:id/publish`
  - Client / participant:
    - `GET /me/content-boards` (subscribed boards)
    - `GET /content-boards/:id` (gated by visibility +
      subscription)
    - `GET /content-boards/:id/items/:item_id` (returns the
      asset URL or external link with view tracking)
    - `POST /content-boards/:id/subscribe`
    - `POST /content-boards/:id/unsubscribe`
  - OWNER moderation:
    - `POST /admin/content-boards/:id/freeze`
    - `POST /admin/content-boards/:id/takedown`
- **Reads:** `CoachAsset` (PR #117), `Lesson`
  (`prisma/schema.prisma:554`), `User`,
  `ClientCoachConsent`.
- **Existing tables not touched:** none. The content-board
  family is fully additive. `CoachAsset` is read but not
  written (the spec **does not** introduce a new asset
  ingestion path; ingestion remains in PR #117).

## 5. WHO

- **Sign-off:** founder for the per-board byte ceiling, the
  newsletter-style fan-out trigger, and the public-visibility
  default; backend lead for the visibility model and the
  view-tracking shape; product for the board organization UX.
- **On the hook:** backend platform.
- **Downstream consumers:** spec #36 (messaging deep-links into
  a content item), spec #34 (regimen weeks reference content
  boards), spec #27 (public coach profile may embed a
  public content board).

## 6. WHAT

**Already exists:**

- `CoachAsset` ingestion (PR #117).
- The merged `Lesson` row — used as one of the item kinds
  (item kind `lesson` references an existing `Lesson` row by
  id).
- The merged Supabase Storage conventions.

**New surface:**

- The board organization primitive (a board is a coach-owned
  collection of items).
- Item kinds: `pdf_asset`, `video_asset`, `link_external`,
  `lesson_ref`, `markdown_inline`.
- Visibility model: `private` (coach-only),
  `assigned_clients` (subscribed clients only),
  `public` (anyone, listed on coach profile).
- Subscription model: a client subscribes to a board (or is
  auto-subscribed when assigned a regimen — #35).
- Per-item view tracking (no per-byte read; just
  open-event count).
- Newsletter fan-out hook (deferred to #36 wiring).

**Non-goals:**

- New asset ingestion. PR #117 owns this.
- Content moderation of *external* links (only takedown of
  the link from the platform's surface; the external page
  itself is not the platform's responsibility).
- Quizzes / inline assessments. Those belong to a future
  lessons-v2 spec.
- Subscription billing / paywalls. Out of scope for this wave.
- Real-time presence ("X is reading this"). Out of scope.

## 7. HOW

Smallest first PR: the migration + the coach-side CRUD with
only `link_external` and `markdown_inline` item kinds wired
(no asset deps). This lets the runtime ship before #117's
ingestion is live.

Rollout phases:

1. **Phase 1 — schema + link/markdown items.** Migration,
   coach CRUD, two simplest item kinds.
2. **Phase 2 — asset items.** `pdf_asset`, `video_asset`
   wired against `CoachAsset` (requires PR #117 to be at
   Phase 2 of its own rollout).
3. **Phase 3 — subscription + client read.** Subscription
   model, client-facing read endpoints, auto-subscription
   from regimen assignment (#35).
4. **Phase 4 — view tracking.** `ContentBoardView` writes,
   read counts surfaced in coach UI.
5. **Phase 5 — public boards.** Visibility `public`, embed
   on coach public profile (#27).
6. **Phase 6 — newsletter fan-out.** "Send to all
   subscribers" emits a `CoachMessage` per subscriber (deferred
   wiring through spec #36).

Feature flag: `CONTENT_BOARDS_ENABLED` (`off` | `coach_only` |
`on`). Default `off` until Phase 3.

## 8. Data model sketch

```prisma
enum ContentBoardVisibility {
  private
  assigned_clients
  public
}

enum ContentBoardItemKind {
  pdf_asset           // FK to CoachAsset
  video_asset         // FK to CoachAsset
  link_external       // URL only
  lesson_ref          // FK to Lesson
  markdown_inline     // text body, max 32 KB
}

enum ContentBoardState {
  draft
  published
  archived
}

model ContentBoard {
  id                          String                       @id @default(uuid())
  coach_user_id               String
  title                       String
  description                 String?                       @db.Text
  visibility                  ContentBoardVisibility        @default(private)
  state                       ContentBoardState             @default(draft)
  cover_storage_key           String?                       // shape mirrors avatar derived keys (#32)
  total_bytes                 BigInt                        @default(0)
  acted_by_member_user_id     String?                       // PR #118 forward-compat
  created_at                  DateTime                      @default(now())
  updated_at                  DateTime                      @updatedAt

  coach                       User                          @relation(fields: [coach_user_id], references: [id])
  items                       ContentBoardItem[]
  subscriptions               ContentBoardSubscription[]

  @@index([coach_user_id, state])
  @@index([visibility, state])
}

model ContentBoardItem {
  id                  String                  @id @default(uuid())
  board_id            String
  display_order       Int                     @default(0)
  kind                ContentBoardItemKind
  title               String
  description         String?                  @db.Text

  // Discriminated union by kind; only one of these is non-null:
  asset_id            String?                  // CoachAsset (PR #117)
  link_url            String?                  // external
  lesson_id           String?                  // FK Lesson
  markdown_body       String?                  @db.Text

  view_count          Int                      @default(0)
  bytes               BigInt                   @default(0)
  created_at          DateTime                 @default(now())
  updated_at          DateTime                 @updatedAt

  board               ContentBoard             @relation(fields: [board_id], references: [id], onDelete: Cascade)
  views               ContentBoardView[]

  @@index([board_id, display_order])
}

model ContentBoardSubscription {
  id                  String     @id @default(uuid())
  board_id            String
  user_id             String
  subscribed_at       DateTime   @default(now())
  unsubscribed_at     DateTime?
  source              String     // 'manual' | 'regimen_assignment' | 'invite_link'

  board               ContentBoard   @relation(fields: [board_id], references: [id], onDelete: Cascade)
  user                User           @relation(fields: [user_id], references: [id])

  @@unique([board_id, user_id])
  @@index([user_id, subscribed_at])
}

model ContentBoardView {
  id                  String     @id @default(uuid())
  item_id             String
  user_id             String?    // null when public + unauth
  ip_hash             String?
  user_agent          String?
  viewed_at           DateTime   @default(now())

  item                ContentBoardItem  @relation(fields: [item_id], references: [id], onDelete: Cascade)

  @@index([item_id, viewed_at])
  @@index([user_id, viewed_at])
}
```

The `total_bytes` field on `ContentBoard` is maintained by a
trigger or by the application layer on `ContentBoardItem`
insert / delete; the spec defaults to application-layer maintenance
because the existing schema does not use Postgres triggers.

## 9. API sketch

### Coach create / update

`POST /api/coach/content-boards`

Request:
```json
{
  "title": "Mindset weeklies",
  "description": "...",
  "visibility": "assigned_clients",
  "cover_storage_key": null
}
```

`POST /api/coach/content-boards/:id/items`

Request (one of the union shapes; validator picks branch by
`kind`):
```json
{
  "kind": "pdf_asset",
  "title": "Recipe pack — week 1",
  "asset_id": "<CoachAsset uuid>",
  "display_order": 1
}
```

```json
{
  "kind": "link_external",
  "title": "Why protein timing matters",
  "link_url": "https://example.com/article",
  "display_order": 2
}
```

Validation:
- `kind=pdf_asset` / `video_asset` requires `asset_id` to
  resolve to a `CoachAsset` owned by `coach_user_id`.
- `kind=lesson_ref` requires `lesson_id` to resolve to a
  `Lesson` owned by the coach.
- `kind=link_external` validates `link_url` as `https://` and
  rejects hosts in a deny list (`localhost`, `127.0.0.1`, the
  platform's own host).
- `kind=markdown_inline` requires `markdown_body` ≤ 32 KB and
  passes through a server-side markdown sanitizer
  (allow-list of HTML tags; no script / iframe).
- The board's `total_bytes` after insert must not exceed the
  per-tier ceiling (#37).

### Client read

`GET /api/me/content-boards`

Response: list of `{ id, title, cover_url, item_count,
last_updated_at }` for boards the user has an active
subscription to.

`GET /api/content-boards/:id/items/:item_id`

Effect: writes a `ContentBoardView` row, then:
- `pdf_asset` / `video_asset` → 302 to a signed Supabase URL
  (TTL 5 minutes).
- `link_external` → 302 to `link_url`.
- `lesson_ref` → 200 with the `Lesson` body.
- `markdown_inline` → 200 with the rendered HTML.

Throttle: 60 reads/min per `(user_id, item_id)` to deflate
view-count spam.

### Public

`GET /public/coach/:slug/content-boards/:id` and
`GET /public/coach/:slug/content-boards/:id/items/:item_id`

Available only when the board is `visibility=public`. Cached
at the edge for 5 minutes. `view_count` increments are
de-duped on `(ip_hash + UA)` per 24 hours.

## 10. Rollout / feature flags

- **Env var:** `CONTENT_BOARDS_ENABLED` (`off` | `coach_only` |
  `on`). Default `off`.
- **Public visibility flag:** `CONTENT_BOARDS_PUBLIC=on/off`,
  separate from the master flag, so an incident on the public
  surface does not require disabling coach-side reads.
- **Tier gate.** Per-tier byte ceiling and per-tier max board
  count are read from #37. L1 has 0 boards; L2 has 5; L3 is
  uncapped (subject to a global hard cap of 1000 per coach).

## 11. RBAC and privacy

- **Coach reads** are scoped to `coach_user_id = req.user.id`.
- **Client reads** require an active
  `ContentBoardSubscription` *or* an active
  `ClientCoachConsent` row matching `(coach_user_id, user_id)`
  (a client of the coach implicitly subscribes to any
  `assigned_clients` board the coach assigns to them via
  regimen — #35 owns the assignment side).
- **Public reads** require `visibility=public` and trigger
  the moderation surface.
- **External-link safety.** The spec rejects URLs whose host
  resolves to a private IP at validation time. The link is
  served as a `rel="noopener noreferrer"` link, never an
  embed.
- **GDPR.** A coach delete cascades the boards. A client
  delete:
  - Hard-deletes `ContentBoardSubscription` rows for that
    user.
  - Drops `ContentBoardView.user_id` to `null` (preserves the
    coach's aggregate view count).
- **Audit.** Every state transition (`publish`, `archive`,
  `freeze`, `takedown`) writes an `AuditLog` row.

## 12. Tests

- **Unit:**
  - Item validator per kind.
  - External-link host deny list (every entry rejected).
  - Markdown sanitizer (script tag stripped; iframe stripped;
    allow-list tags retained).
  - Byte-ceiling enforcement.
- **Integration:**
  - Subscribe → view → coach-side aggregate read.
  - Coach delete cascade.
  - Public board takedown propagates within one cache TTL.
- **Smoke:**
  - `GET /me/content-boards` returns 200 (empty array when
    none).
- **Manual eval:** founder reviews three example boards on
  staging.

## 13. Risks

- **External-link liability.** A coach links to a malicious
  page. Mitigation: the spec rejects private-IP hosts; the
  takedown surface lets OWNER pull a link without notifying
  the coach. Legal posture documented in audit-and-gdpr.
- **PDF malware.** `pdf_asset` items are served via signed
  Supabase URLs; the asset was uploaded via PR #117 and is
  scanned at ingestion (PR #117 §8). This spec does **not**
  re-scan.
- **Markdown XSS.** Mitigated by the server-side sanitizer;
  the rendered HTML is served with `Content-Security-Policy`
  preventing inline scripts.
- **View-count inflation.** Throttle + 24-hour de-dup on
  `(ip_hash + UA)`.
- **Storage cost runaway.** Per-tier byte ceiling enforced at
  insert; OWNER admin gets a "boards over quota" report.

## 14. Dependencies

- **Roadmap rows.** PR #117 (asset ingestion); #32 (cover
  image); #34 (regimens link to boards); #35 (auto-subscribe
  on assignment); #37 (tier gate).
- **Existing modules.** `src/audit/`, `src/auth/`,
  `src/common/throttling/`, `src/messaging/` (deferred
  newsletter fan-out).
- **External services.** Supabase Storage; the existing
  Markdown sanitizer
  (`isomorphic-dompurify` or equivalent — new dep).
- **Decisions that must close.**
  - Markdown library choice.
  - Whether `link_external` items are allowed for L1 coaches.

## 15. Acceptance criteria

1. Migration adds the four tables idempotently with FKs.
2. Coach-side CRUD passes integration tests for every
   `kind`.
3. External-link deny list rejects every test entry.
4. Markdown sanitizer strips every test script tag.
5. Subscribe → view → aggregate flow works end-to-end on
   staging.
6. Coach delete cascade preserves view-count anonymity.
7. Public takedown propagates within one cache TTL.
8. Handoff brief at
   [`../architecture/handoff/33-content-boards.md`](../architecture/handoff/33-content-boards.md)
   updated.

## 16. Operator handoff

- **Runbook entry** in [`../deploy-runbook.md`](../deploy-runbook.md):
  flag flips, takedown procedure, byte-ceiling adjustments.
- **Dashboard tiles:**
  - "Boards over quota."
  - "External link 4xx/5xx rate" (the platform redirects, not
    the link itself, but a misformed `link_url` shows here).
  - "View counts per board (top 50)."
- **Alerts:**
  - Storage usage > 80% of provisioned bucket capacity.
  - Takedown actions per day > 5 (signal of moderation
    spike).
- **Kill switches:**
  - `CONTENT_BOARDS_ENABLED=off` — disables routes.
  - `CONTENT_BOARDS_PUBLIC=off` — keeps coach + client side
    alive while shutting down public.
