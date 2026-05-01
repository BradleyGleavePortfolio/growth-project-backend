# Spec: Replays and Content Library

> **Status:** Draft (engineer-facing). **Roadmap row:** #42
> (engagement & retention wave). **Owner:** backend lead.
> **Companion brief:** [`docs/architecture/handoff/42-replays-content-library.md`](../architecture/handoff/42-replays-content-library.md).
> **No runtime in this PR.** No schema change, no migration, no
> module wiring. Runtime PRs descend from this spec, behind
> `CONTENT_LIBRARY_ENABLED`.

This is the engineer-facing specification for the
**Replays & Content Library** — the durable, member-only
distribution surface where every coach-recorded asset lives
forever (or until retention expires): live-call replays,
podcasts, lessons, PDFs, video lessons, audio drops. It owns
the **post-event** retention loop the events spec
([`events-live-calls.md`](./events-live-calls.md)) hands off to,
and is the surface a coach's community spec
([`community-spaces.md`](./community-spaces.md)) deep-links into.

The 16-section template follows
[`docs/specs/README.md`](./README.md). Every section closes with
the decisions that must be settled before the first runtime PR.

---

## 1. Status banner and cross-references

- **Stage:** discovery → spec.
- **Depends on (drafts):** PR #117 (Supabase Storage prefix +
  mime allow-list + the embedding pipeline; the content library
  reuses chunk + embed for transcript search), PR #118 (Team
  Mode forward-compat hook), PR #120 (lanes #01 flags / #04
  data lifecycle / #05 billing packaging / #06 observability /
  #08 AI governance), PR #121 (#28 program-templates uses
  content-library entries as source material; #23 weekly recap
  reads which entries the member consumed), PR #123 (#33
  content-boards is a v0 of this surface; #34 regimens
  references library entries).
- **Reuses (merged):** `User`, `CoachProfile`, `CoachSubscription`,
  `Lesson`, `LessonCompletion`, `AuditLog`, the OpenAPI
  publication convention, the existing `ListItem` pattern for
  saved/bookmarked items, `ClientCoachConsent`.
- **Out of scope:** public-internet content discovery (no
  cross-coach catalog); paywall preview / "first 30 seconds
  free" upsell flows (the platform does not stream-paywall;
  membership is the gate); user-uploaded content **by members**
  (only coach + OWNER + Team Mode staff write); SEO-friendly
  long-form HTML (covered by the public-pages module + the
  public coach profile, PR #121 #27).

---

## 2. WHY — problem in user/business terms

**Coach problem.** A coach's body of work — the live-call
recordings, the audio drop they record after a workout, the PDF
they wrote in 2024, the YouTube link they posted in Discord
last week — lives in five tools. None of them are the platform
the client opens every day. Re-finding a thing the coach said
six months ago is a search problem the coach loses every time.

**Client problem.** A client misses a live call, never finds
the replay, and the call effectively did not happen for them.
Or the client wants to revisit a lesson the coach published in
March and cannot remember which app it was in.

**Business problem.** The single most underrated retention
mechanic for a creator-shaped business is the **back catalog**.
Skool, Whop, Patreon, Circle — the dominant feature is "the
library" (everything the creator ever made, organized,
searchable, durable). Without it, every renewal is paid for
fresh, and every churn is a clean break.

The library on this platform is also the substrate the AI
Program Builder (PR #117), the AI Business Copilot
([`ai-business-copilot.md`](./ai-business-copilot.md)), and the
weekly recap (PR #121 spec #23) all read from. A unified
library = a single source of truth for "what does this coach
actually teach", which makes every downstream AI surface more
coherent.

**Why now.** The events spec needs a place to land
recordings; the community spec needs a place to link long-form
video; the at-risk detector needs a place to read "did this
member actually consume what their coach posted last week".

---

## 3. WHEN — gating conditions for the first runtime PR

PR-1 (schema + read-only `GET` of an empty library) cannot
start until **all** of the following are true.

1. **Storage prefix shape locked.** PR #117 §8 has confirmed
   `coach/{coach_id}/library/{entry_id}/...` as the prefix;
   library inherits the mime allow-list directly.
2. **Per-tier retention recorded.** PR #120 lane #04 has
   accepted the per-tier retention matrix (e.g. L1: 30 days
   replay, L2: 365 days, L3: forever-while-subscribed). The
   matrix lives in `docs/entitlements.md` and is read by the
   nightly retention cron.
3. **Embedding shape decided.** PR #117 §6 has confirmed the
   embedding provider + the chunking strategy. The content
   library reuses the same `CoachAssetChunk` table for
   transcript chunks (or a parallel `ContentLibraryChunk` if
   the access patterns diverge — spec defaults to a parallel
   table because the access surface is "search across
   library", not "draft from this asset").
4. **Transcript provider decided.** Whisper-API-compatible
   provider (OpenAI Whisper, Replicate, Deepgram). Default
   off; deterministic fallback returns "transcript not
   available". The pluggable shape mirrors `src/ai/`.
5. **Public-preview rule confirmed.** Content-library entries
   are member-only by default. A future opt-in "public
   excerpt" path (e.g. for a marketing site teaser) is
   enumerated as a non-goal in v1.
6. **Search posture.** Server-side keyword search vs. server-
   side semantic search. Spec defaults to keyword first,
   semantic added behind a flag once the embedding pipeline
   is GA.

---

## 4. WHERE — modules, tables, routes touched

### 4.1 New module

`src/content-library/` (peer to `src/community/`,
`src/events/`).

| File | Owns |
|---|---|
| `content-library.module.ts` | Wires controller + services. Imported by `app.module.ts` only behind `CONTENT_LIBRARY_ENABLED`. |
| `content-library.controller.ts` | `GET /api/library/coach/:coach_id`, `GET /api/library/entries/:id`, `POST /api/library/entries`, `PATCH /api/library/entries/:id`, `DELETE /api/library/entries/:id`, `POST /api/library/entries/:id/progress`, `POST /api/library/entries/:id/transcribe` (idempotent enqueue), `GET /api/library/search?coach_id=:id&q=:q`. |
| `content-library.service.ts` | All Prisma reads/writes + the entitlement gate. |
| `content-library-transcribe.service.ts` | Provider-pluggable transcript pipeline; deterministic fallback; BullMQ queue. |
| `content-library-search.service.ts` | Server-side keyword search (Postgres `tsvector` GIN); semantic search added behind a flag in PR-5. |
| `content-library-progress.service.ts` | Per-(member, entry) progress ledger; 0..1 progress; "consumed" boolean derived; emits `entry_consumed` PostHog event. |
| `dto/*.ts` | Request/response DTOs + Swagger. |
| `README.md` | Module orientation. |

### 4.2 New tables (additive, sketched in §8)

`ContentLibraryEntry`, `ContentLibraryProgress`,
`ContentLibraryTranscript`, `ContentLibraryChunk`,
`ContentLibrarySavedItem`. Every row carries `coach_id`. Every
write carries the nullable `acted_by_member_user_id` PR #118
hook.

### 4.3 New env vars (described, not added)

- `CONTENT_LIBRARY_ENABLED` — global kill-switch. Default off.
- `CONTENT_LIBRARY_TRANSCRIPT_PROVIDER` — `whisper` | `deepgram`
  | `none`. Default `none` (deterministic fallback).
- `CONTENT_LIBRARY_TRANSCRIPT_PROVIDER_API_KEY`.
- `CONTENT_LIBRARY_PER_COACH_STORAGE_BYTES_CAP` — soft cap per
  tier; OWNER alert at 80%.
- `CONTENT_LIBRARY_SEMANTIC_SEARCH_ENABLED` — gate the embedding
  + pgvector search path. Default off.

### 4.4 Mobile + console contract

Mobile reads `GET /api/library/coach/:coach_id` (paginated,
filterable by kind), `GET /api/library/entries/:id` (the
playback surface), `POST /api/library/entries/:id/progress`
(progress write).

Coach console writes new entries, deletes entries, runs the
re-transcribe path, edits titles/descriptions/chapters, manages
the per-entry visibility and tier gate.

### 4.5 Files explicitly NOT touched

- `prisma/schema.prisma` — no edit in this PR.
- `prisma/migrations/` — no migration in this PR.
- `src/common/env-validation.ts` — env vars described, not
  registered.
- `app.module.ts` — no module wiring in this PR.
- `new-website` — out of scope; the marketing site never
  consumes the library.

---

## 5. WHO — sign-off, on-the-hook, downstream, hard boundaries

| Role | Person / artefact | What they decide |
|---|---|---|
| Founder | Bradley | Per-tier retention windows; whether semantic search is included or up-tiered; whether transcripts are on by default for live-call recordings. |
| Backend lead | (TBD) | Search shape (keyword vs semantic); whether the transcript pipeline is one-deep or pluggable from day one (spec defaults to pluggable). |
| Mobile | (TBD) | Playback shape (web view + native player); whether progress writes are throttled at 5-second cadence or 30-second cadence (spec defaults to 30s + on-pause + on-finish). |
| Coach console | (TBD) | Bulk import shape (drag-and-drop multiple files at once vs one-at-a-time); chapter editing UI shape (out of scope for v1; chapters from transcripts only). |
| Pager | OWNER | First 30 days. Transcript provider failures are best-effort and never block playback. |
| Hard boundaries | — | (a) No public-internet catalog; the library is members-only. (b) No DRM in v1 (the platform cannot meaningfully prevent download of an MP4); spec acknowledges this and treats the library as "convenience + retention", not "piracy-proof". (c) No automated copyright takedown — the OWNER inbox handles report-driven removal. (d) `new-website` stays untouched. |

---

## 6. WHAT — already exists, net-new, non-goals

### Already exists (reused)

- `Lesson`, `LessonCompletion` — the existing per-coach
  curriculum surface. The library **supersedes** but does not
  delete these; v1 imports existing `Lesson` rows as
  `ContentLibraryEntry` rows lazily (read-on-write). Lessons
  remain the program-builder publish target (PR #117).
- `User`, `CoachProfile`, `SubscriptionGuard`, `AuditLog`.
- The Storage prefix + mime allow-list (PR #117 §8).
- The chunk + embed pattern (PR #117 §6) for semantic search
  (added behind a flag in PR-5).

### Net-new

- Five tables (§8).
- Provider-pluggable transcript pipeline.
- Server-side search service (keyword in PR-3, semantic in
  PR-5).
- Per-(member, entry) progress ledger.
- Saved-items list (per-member bookmark list).
- Recording-ready bridge from `events-live-calls.md`.

### Non-goals

- Member-uploaded content. The library is coach-write only in
  v1 (Team Mode adds staff-write later).
- Automated chapter generation **without** transcripts. v1
  derives chapters from transcript headings only; manual
  chapter editing is a later PR.
- Live-streaming (events spec covers that).
- Multi-language transcripts in v1; transcripts are stored as
  the source-language string and rendered as-is.
- Watermarking, screen-recording prevention, DRM. Acknowledged
  out of scope.
- Public RSS / podcast feed export. (Parking-lot row #11 in
  PR #119 — could be added later behind the "public" tier.)

---

## 7. HOW — rollout plan + smallest first PR + feature flag

### 7.1 Rollout phases

| Phase | What lands | Flag state |
|---|---|---|
| PR-1 | Schema (additive); `GET /api/library/coach/:id` returns `[]`; module wired but unreachable. | `CONTENT_LIBRARY_ENABLED=false`. |
| PR-2 | Coach can write a `ContentLibraryEntry` row (text/PDF/audio/video link or upload). Read returns the coach's own entries. | Flag on for staging; off for prod. |
| PR-3 | Roster reads (member-only access predicate from §11); progress write path; keyword search. | Flag on for one beta coach in prod. |
| PR-4 | Recording-ready bridge from `events-live-calls.md` PR-5 — recordings auto-create a library entry. | Flag on for ≤5 beta coaches. |
| PR-5 | Transcript provider wired; transcript chunks indexed; semantic search behind `CONTENT_LIBRARY_SEMANTIC_SEARCH_ENABLED`. | Flag on for ≤5 beta coaches. |
| PR-6 | Per-tier retention cron; saved-items list; weekly-recap signal write. | Flag on for the entire L2/L3 tier. |
| PR-7 | Console moderation (delete, hide, restore); audit-log every action; the report-driven takedown path. | GA. |
| PR-8 | Optional: lazy import of existing `Lesson` rows as `ContentLibraryEntry` (read-on-write so the library shows everything the coach has ever published). | GA. |

### 7.2 Smallest first PR

**PR-1** ships:

- Schema additions in §8.
- `content-library.module.ts` registered behind the flag.
- `GET /api/library/coach/:coach_id` returns `[]` when the
  flag is off.
- One smoke assertion: route mounted + 200 + `[]`.
- OpenAPI export update.

PR-1 carries no provider code, no Storage write, no transcript,
no search.

### 7.3 Feature flags

- `CONTENT_LIBRARY_ENABLED` — required for PR-1.
- `CONTENT_LIBRARY_TRANSCRIPT_PROVIDER=none` — deterministic
  fallback; PR-5 flips per-coach.
- `CONTENT_LIBRARY_SEMANTIC_SEARCH_ENABLED=false` — server-side
  keyword search is the default; semantic search is layered on
  later.
- `CONTENT_LIBRARY_PER_COACH_STORAGE_BYTES_CAP` — per-tier
  numeric.

---

## 8. Data model sketch (additive Prisma; **not** migrated here)

```prisma
model ContentLibraryEntry {
  id                       String   @id @default(uuid())
  coach_id                 String
  coach                    User     @relation("LibraryEntryCoach", fields: [coach_id], references: [id])
  kind                     String                  // "video"|"audio"|"pdf"|"image"|"text"|"link"
  title                    String                  // ≤ 200 chars
  description              String?                 // ≤ 8 KB
  storage_path             String?                 // Supabase Storage path, when applicable
  external_url             String?                 // for kind="link"
  source                   String   @default("manual") // "manual"|"event_recording"|"program_publication"
  source_event_id          String?                 // FK to Event (events spec)
  duration_seconds         Int?                    // for video/audio
  bytes                    BigInt?                 // for uploaded media
  visibility               String   @default("members_only") // "members_only"|"hidden"|"deleted"
  required_tier            String   @default("any") // "any"|"L2"|"L3"
  pinned                   Boolean  @default(false)
  acted_by_member_user_id  String?                 // PR #118 forward-compat
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  transcript               ContentLibraryTranscript?
  chunks                   ContentLibraryChunk[]
  progress                 ContentLibraryProgress[]
  saved                    ContentLibrarySavedItem[]

  @@index([coach_id, kind, created_at])
  @@index([source_event_id])
}

model ContentLibraryProgress {
  id              String   @id @default(uuid())
  entry_id        String
  entry           ContentLibraryEntry @relation(fields: [entry_id], references: [id], onDelete: Cascade)
  coach_id        String
  user_id         String
  user            User     @relation("LibraryProgressUser", fields: [user_id], references: [id])
  position_seconds Int     @default(0)             // 0 for non-time-based
  position_fraction Float  @default(0)             // 0..1
  consumed         Boolean @default(false)         // true once position_fraction >= 0.9
  last_seen_at     DateTime @default(now())
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt

  @@unique([entry_id, user_id])
  @@index([coach_id, user_id, last_seen_at])
}

model ContentLibraryTranscript {
  id           String   @id @default(uuid())
  entry_id     String   @unique
  entry        ContentLibraryEntry @relation(fields: [entry_id], references: [id], onDelete: Cascade)
  coach_id     String
  language     String   @default("en")
  body         String                              // full transcript, ≤ 1 MB
  chapters     Json?                               // [{ title: string, starts_at: number }]
  provider     String                              // "whisper"|"deepgram"|"manual"
  ready_at     DateTime
  created_at   DateTime @default(now())
  updated_at   DateTime @updatedAt
}

model ContentLibraryChunk {
  id            String   @id @default(uuid())
  entry_id      String
  entry         ContentLibraryEntry @relation(fields: [entry_id], references: [id], onDelete: Cascade)
  coach_id      String
  ord           Int                                 // chunk order
  starts_at     Int?                                // for time-based media
  ends_at       Int?
  body          String                              // chunk text
  embedding     Unsupported("vector(1536)")?       // pgvector; nullable until provider runs
  created_at    DateTime @default(now())

  @@index([entry_id, ord])
  @@index([coach_id])
  // pgvector index added in PR-5 via raw SQL
}

model ContentLibrarySavedItem {
  id              String   @id @default(uuid())
  entry_id        String
  entry           ContentLibraryEntry @relation(fields: [entry_id], references: [id], onDelete: Cascade)
  coach_id        String
  user_id         String
  user            User     @relation("LibrarySavedUser", fields: [user_id], references: [id])
  created_at      DateTime @default(now())

  @@unique([entry_id, user_id])
  @@index([coach_id, user_id, created_at])
}
```

### 8.1 Schema notes

- `ContentLibraryEntry.kind` is a closed-vocab string (no enum)
  so adding `"newsletter"` later is a one-line change.
- `source` distinguishes manually-uploaded entries from
  event-recording-derived entries (so the events spec doesn't
  need a separate join table) and from program-publication-
  derived entries (PR #117 §11 publishes lessons; the library
  imports them lazily).
- `required_tier="any"` is the default; coach can up-tier per
  entry. The library service checks the viewer's tier via the
  entitlement bundle before returning the row.
- `position_fraction` is the playback fraction; `consumed`
  flips at ≥ 0.9 (per industry convention; mirrors what
  Spotify/YouTube treat as a "completion").
- `chapters` is JSON for v1; once chaptering is a first-class
  concept (post-MVP) it migrates to a normalised table.
- `ContentLibraryChunk` mirrors `CoachAssetChunk` from PR #117
  §3 but indexes the **published-to-members** content, not the
  coach's private source assets — the access patterns diverge
  enough to justify a separate table.

---

## 9. API sketch (routes + envelope + throttling)

All routes under `/api/library/*`.

### 9.1 Read

```
GET /api/library/coach/:coach_id?kind=&cursor=
  → 200 { entries: ContentLibraryEntryEnvelope[], next_cursor: string|null }
  → 423 { error: "feature_locked", reason: "tier_below_library" }
```

```
GET /api/library/entries/:id
  → 200 { entry, transcript: { body, chapters } | null,
          playback: { signed_url: string, expires_at: ISO } | null,
          progress: { position_fraction: number, consumed: boolean } | null }
  → 403 { error: "tier_below_required" } | { error: "not_member" }
  → 404
```

```
GET /api/library/search?coach_id=:id&q=:q&kind=
  → 200 { entries: ContentLibraryEntryEnvelope[],
          highlights: { entry_id: string, snippet: string }[] }
```

Search uses Postgres `tsvector` against a generated column
(`title || description || transcript.body`). Semantic search,
behind the flag, augments with a pgvector distance score on
`ContentLibraryChunk.embedding`.

### 9.2 Write (coach + OWNER)

```
POST /api/library/entries
  body: { kind, title, description?, storage_path?, external_url?,
          required_tier?, source? }
  → 201 { entry }
  → 422 { error: "validation_failed", fields: { ... } }
  → 423 { error: "feature_locked" }
  → 429 { error: "rate_limited" }
```

Throttle: `30/hour/coach` for create; per-coach storage cap
enforced at create-time when `bytes` is supplied.

```
PATCH /api/library/entries/:id
  body: { title?, description?, required_tier?, visibility?, pinned? }
  → 200 { entry }
```

```
DELETE /api/library/entries/:id
  → 204
```

`DELETE` sets `visibility='deleted'` and emits an audit-log
row. Hard-delete only on the per-tier retention cron or GDPR
scrub.

### 9.3 Member surface

```
POST /api/library/entries/:id/progress
  body: { position_seconds, position_fraction }
  → 200 { progress: { position_fraction, consumed } }
```

Throttle: `120/hour/user` (mobile reasonably writes on pause +
finish + every 30s).

```
POST /api/library/entries/:id/save
  → 201 { saved_item }
  → 200 { saved_item } if already saved
DELETE /api/library/entries/:id/save
  → 204
```

### 9.4 Transcribe (coach-triggered idempotent enqueue)

```
POST /api/library/entries/:id/transcribe
  → 202 { job: { id, status: "queued" } }
  → 409 { error: "already_transcribed" }
  → 503 { error: "provider_unavailable" }
```

Idempotent: re-calling on a `ready` transcript returns 409;
calling on a queued job returns the same job id.

### 9.5 Envelope

```ts
type ContentLibraryEntryEnvelope = {
  id: string;
  coach_id: string;
  kind: "video"|"audio"|"pdf"|"image"|"text"|"link";
  title: string;
  description: string | null;
  duration_seconds: number | null;
  bytes: number | null;
  source: "manual"|"event_recording"|"program_publication";
  required_tier: "any"|"L2"|"L3";
  pinned: boolean;
  visibility: "members_only"|"hidden"|"deleted";
  has_transcript: boolean;
  created_at: string;
  updated_at: string;
};
```

---

## 10. Media / replay storage

- **Storage path**: `coach/{coach_id}/library/{entry_id}/{ext}`.
  Supabase Storage; the same prefix tree as PR #117 §8.
- **Upload**: pre-signed URL minted by the controller; the
  client uploads directly to Supabase Storage. The
  `POST /api/library/entries` writes the row with a
  `storage_path` referencing the to-be-uploaded file.
- **Read**: short-TTL signed URL (≤ 1 hour) minted on read,
  never a public URL. The signed URL is part of the
  `playback` envelope and is **never** logged.
- **Retention**: per-tier cron runs nightly; entries past the
  retention window are hidden (`visibility='deleted'`) and the
  Storage object is deleted in the next batch. Coach receives
  a 7-day-before warning (PostHog event +
  push notification).
- **Recording handoff**: the events-live-calls webhook
  (`events-live-calls.md` §9.4) writes one
  `ContentLibraryEntry` row with `source='event_recording'` +
  `source_event_id`. The library surface auto-titles it
  ("Live call: <event title> — <date>"); the coach edits in
  place.
- **External URLs**: `kind='link'` entries store an
  `external_url` (e.g. a YouTube link). The library renders
  them with a thumbnail preview generated client-side; the
  platform never proxies external content.

---

## 11. Moderation, member-only access, abuse posture

Member-only access is the same predicate as the community spec
(§11). The library service applies the predicate **plus** the
per-entry tier gate:

```ts
canReadEntry(viewer: User, entry: ContentLibraryEntry): boolean {
  if (viewer.role === 'owner') return true;
  if (viewer.id === entry.coach_id) return true;
  if (viewer.coach_id !== entry.coach_id) return false;
  if (entry.required_tier === 'any') return true;
  return viewerTierAtOrAbove(viewer, entry.required_tier);
}
```

`viewerTierAtOrAbove` resolves through the entitlement bundle
(PR #120 lane #05).

Abuse posture: the OWNER inbox accepts copyright / IP claims
via `POST /api/community/reports` with
`target_kind='library_entry'`. On valid claim, the OWNER sets
`visibility='hidden'`; the coach receives a notification + a
24-hour appeal window. Hard-deletion only on confirmed claim
or GDPR scrub.

Tombstoning preserves the row so progress/saved-item references
do not break; the entry renders as "(unavailable)".

---

## 12. Member-only access + RBAC + privacy

| Concern | Posture |
|---|---|
| Authentication | `JwksAuthGuard`. Signed-URL playback verifies the JWT before minting the URL. |
| Tenancy axis | `coach_id` on every row; service-layer predicate. |
| Entitlement gate | Per-coach via `SubscriptionGuard`; per-entry via `required_tier`. Mismatch returns `tier_below_required` (specific) or `feature_locked` (no library access at all). |
| GDPR | All five tables in the per-table retention matrix. Account-deletion scrub: hard-delete `ContentLibraryProgress` and `ContentLibrarySavedItem` immediately; tombstone any `acted_by_member_user_id` reference; transcript stays (it's the coach's content, not the deleted member's). Export includes a per-member listing of saved items + progress, not the surrounding coach catalog. |
| PII | Transcripts may contain a member's name if the coach addressed them. The transcript is the **coach's** record; redaction is a coach-triggered "edit transcript" action, not an automatic sweep. |
| Audit-log | `POST/PATCH/DELETE` on entries + every transcribe + every report-driven hide writes one row. |
| Cross-coach | A naive query never returns entries across coaches; integration tests assert this. |

---

## 13. AI governance (transcripts, chapter generation, search)

Three AI surfaces touch the library:

1. **Transcript pipeline.** Provider-pluggable. Deterministic
   fallback returns "transcript not available" in PR-5 if the
   provider is unset. The provider receives the audio/video
   bytes via signed URL; the platform never sends raw bytes
   over JSON.
2. **Chapter generation.** Derived from the transcript
   (heading/topic detection). The same provider that writes
   the transcript produces a `chapters` JSON; if the provider
   does not, the coach edits manually.
3. **Semantic search.** Embedding via the same provider as
   PR #117 §6. Per-coach budget cap (PR #120 lane #05); deterministic
   fallback returns keyword-only results when the provider is
   off.

**Prompt + threshold versioning** for any LLM-written summary
(see the AI Business Copilot spec) goes through the
`BuilderPromptTemplate` table (PR #117 §3). Eval baselines for
chapter generation live alongside the AI Program Builder evals
(PR #117 §13); the library spec adds 100 fixtures (50 audio,
50 video) that lock the chapter format (titles ≤ 80 chars, no
em-dashes — same posture as the GP guardrails).

**No AI-only writes to the library.** The coach reviews and
publishes; the AI Business Copilot drafts. This rule is
non-negotiable for v1.

---

## 14. Feature flags + entitlements

| Flag | Default | Gates |
|---|---|---|
| `CONTENT_LIBRARY_ENABLED` | off | Whole module. |
| `CONTENT_LIBRARY_TRANSCRIPT_PROVIDER` | `none` | Transcript pipeline. |
| `CONTENT_LIBRARY_SEMANTIC_SEARCH_ENABLED` | off | pgvector path. |
| `CONTENT_LIBRARY_PER_COACH_STORAGE_BYTES_CAP` | per-tier | OWNER alerts at 80%. |
| Entitlement bundle | tier-gated | Library is bundled with L2+ in v1 (founder decision). L1 returns `feature_locked`. |

Kill-switch: `fly secrets set CONTENT_LIBRARY_ENABLED=false`.
Existing entries keep on disk; reads return the empty envelope.

---

## 15. Analytics + telemetry

PostHog events:

| Event | Properties |
|---|---|
| `library_entry_created` | `coach_id`, `kind`, `source`, `bytes` |
| `library_entry_viewed` | `coach_id`, `entry_id`, `viewer_role` |
| `library_entry_consumed` | `coach_id`, `entry_id`, `viewer_role`, `duration_seconds` |
| `library_progress_written` | `coach_id`, `entry_id`, `position_fraction` |
| `library_search` | `coach_id`, `q_length`, `mode` ("keyword"|"semantic"), `result_count` |
| `library_transcript_ready` | `coach_id`, `entry_id`, `provider`, `duration_seconds` |
| `library_entry_saved` | `coach_id`, `entry_id`, `viewer_role` |

OWNER metrics counter:

- `library_entries_per_coach_p50_p90`.
- `library_storage_bytes_per_coach`.
- `library_consumption_rate_p50` — the fraction of a coach's
  entries that ≥ 1 member has consumed in the last 30 days.
- `library_search_volume_30d`.

The weekly recap (PR #121 spec #23) reads
`library_entry_consumed` + `library_progress_written` to
surface "you watched 4 of your coach's drops this week". The
at-risk detector (PR #121 spec #22) reads "no library
consumption in last 14 days" as one of its signals.

---

## 16. Tests, risks, dependencies, acceptance, operator handoff

### 16.1 Tests

- **Unit**: `canReadEntry` predicate matrix; the per-tier
  retention cron's idempotency; the transcript-fallback path;
  the chunk + ord ordering invariant.
- **Integration**: every route in §9 against a stubbed
  Storage + a stubbed transcript provider.
- **Smoke**: route mounted, returns `[]` when flag off.
- **Eval**: 100 fixtures for chapter generation locked behind
  the eval CI; transcript exact-match disabled (transcripts are
  inherently variable), but format checks (em-dashes, length,
  language) are enforced.
- **Load**: PR-3 stress-tests `GET /api/library/coach/:id` —
  10k entries, paginated, p95 < 300 ms.

### 16.2 Risks

- **Storage cost runaway.** A coach uploads 500 hours of video.
  Mitigation: per-tier storage cap (§4.3); OWNER alerts; the
  per-tier retention cron.
- **Transcript provider downtime.** Best-effort; never blocks
  playback.
- **Search drift.** Keyword search is a degraded experience for
  long-form video. Mitigation: semantic search behind the flag
  in PR-5.
- **Copyright takedown.** A coach uploads someone else's
  content. Mitigation: report intake + coach-visible removal;
  acknowledged that this is a manual triage process in v1.
- **Signed-URL leak.** A leaked URL grants ≤ 1 hour of access.
  Mitigation: short TTL + the URL is never logged + the URL is
  per-(viewer, entry) so a leak is traceable.
- **Tombstoned-entry confusion.** A member sees "(unavailable)"
  on an entry they had progress in. Mitigation: the envelope
  carries a `visibility` field; the mobile client renders a
  clear "removed by coach" affordance.

### 16.3 Dependencies

- Internal: PR #117 (Storage prefix, mime allow-list, embedding
  provider, eval CI), PR #118 (forward-compat), PR #120 (lanes
  #01, #04, #05, #06, #08, #10), PR #121 (#22 / #23 / #28),
  `events-live-calls.md` (recording handoff), `community-spaces.md`
  (deep-link inflow), `ai-business-copilot.md` (suggestion
  reads).
- External: Supabase Storage; transcript provider (Whisper /
  Deepgram); pgvector (already a dep in PR #117).

### 16.4 Acceptance criteria

- A coach uploads a 30-min video; it appears in the library
  within 60 seconds. The transcribe path runs (≤ 5 min for
  30 min of audio); transcript renders. A member views;
  progress writes; the weekly recap reflects consumption the
  next morning.
- A live-call recording arrives at the library automatically
  via the events spec PR-5 webhook.
- A member whose tier does not include the entry sees
  `tier_below_required`, not a 403.
- A revert is a flag flip; no migration runs in the rollback
  path.

### 16.5 Operator handoff

- **Runbook entry:** `docs/operations/content-library.md` (a
  future doc).
- **Dashboard tiles:** entries-per-coach, consumption rate,
  storage utilization, search volume.
- **Kill-switch:** `fly secrets set CONTENT_LIBRARY_ENABLED=false
  -a tgp-backend-prod`.
- **First 30 days:** OWNER reads `library_consumption_rate_p50`
  weekly; a coach in the bottom decile is the on-call signal
  for a "your library is dormant" intervention via the AI
  Business Copilot.

---

## Decisions that must close before PR-1

1. Per-tier retention windows (L1: 30d? L2: 365d? L3: forever?).
   (Founder + PR #120 lane #04.)
2. Transcript provider (Whisper / Deepgram / OpenAI Whisper-API).
   (Backend lead.)
3. Search default (keyword only in v1, or keyword + semantic on
   day one). Spec defaults: keyword-only at GA, semantic added
   in PR-5. (Backend lead.)
4. Whether the library imports existing `Lesson` rows lazily
   (spec defaults to yes, lazy / read-on-write). (Backend
   lead.)
5. Whether transcript chapters are auto-published or coach-
   reviewed. (Founder.)
6. Per-tier required_tier defaults — does an entry default to
   `"any"`, or to the coach's lowest tier? (Founder.)
