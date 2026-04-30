# RFC: AI Program Builder

**Status:** Draft / Aspirational — discovery phase, no production runtime code shipped with this RFC.
**Owner:** Backend platform.
**Audience:** Engineering, product, design, founder.
**Last updated:** 2026-04-30.
**Stability:** Subject to change. Section §17 lists the open questions
that must close before Phase 1 begins.

This RFC proposes a server-side **AI Program Builder** that lets a coach
assemble a structured client program (workouts, lessons, meal-plan
templates, check-in cadences, guidelines) from their own existing
assets — videos, PDFs, spreadsheets, prior client programs, and freeform
notes — using a guided pipeline of asset ingestion, LLM-mediated
drafting, and human-in-the-loop review.

The intent is to make a coach's *system* (their unique programming,
their lesson library, their voice) the substrate the AI builds against,
so the output is recognizably *their* program, not a generic LLM
template.

This RFC is **docs only**. No production runtime code lands with it.
The skeleton in §15 describes a no-op module that may follow as a
separate, narrowly scoped Phase-0 PR.

---

## Table of contents

1. [Problem](#1-problem)
2. [Non-goals](#2-non-goals)
3. [User stories](#3-user-stories)
4. [Architecture](#4-architecture)
5. [Data model proposal](#5-data-model-proposal)
6. [API surface](#6-api-surface)
7. [Background jobs and queues](#7-background-jobs-and-queues)
8. [Asset ingestion](#8-asset-ingestion)
9. [LLM and provider strategy](#9-llm-and-provider-strategy)
10. [Prompt and template versioning](#10-prompt-and-template-versioning)
11. [Human-in-the-loop editing](#11-human-in-the-loop-editing)
12. [Publishing workflow](#12-publishing-workflow)
13. [Evaluation and QA](#13-evaluation-and-qa)
14. [Safety, privacy, and compliance](#14-safety-privacy-and-compliance)
15. [Cost controls](#15-cost-controls)
16. [Observability](#16-observability)
17. [Open questions](#17-open-questions)
18. [Rollout plan](#18-rollout-plan)
19. [Test plan](#19-test-plan)
20. [Implementation phases and follow-up PRs](#20-implementation-phases-and-follow-up-prs)
21. [Links to existing models](#21-links-to-existing-models)
22. [Forward-compatibility: Outcome Graph and Team Mode](#22-forward-compatibility-outcome-graph-and-team-mode)

---

## 1. Problem

A coach onboarding a new client today repeats themselves. They have
their own programming style — sets-and-reps philosophies, nutrition
heuristics, lesson content, check-in cadences, even a voice they want
to preserve in written guidelines — but the platform makes them
**re-enter that knowledge per client**:

- They build a `WorkoutRoutine` from `RoutineExercise` rows by hand.
- They build a `MealPlan` row whose `items` is a freeform JSON blob.
- They author `Lesson` rows one at a time.
- They write `CoachGuideline` content per client, often pasting the
  same paragraphs from a Google Doc.
- They re-explain their methodology in every onboarding message.

This rewards the coach who already has a tight digital workflow, and
penalizes the experienced coach whose IP lives in a folder of PDFs,
spreadsheets, and YouTube unlisted videos. The product also has a
ceiling: a coach cannot scale past the number of clients they can
hand-program.

The opportunity is to ingest the coach's own assets — once — and let
them assemble a per-client program by **reviewing and editing AI
drafts** rather than writing from scratch. The same primitive is the
substrate for future automation (per-client adaptation, plateau
detection, the Outcome Graph) and the substrate for Team Mode (a
junior coach drafting under the senior coach's published system).

### What "AI Program Builder" is *not*

- It is **not** the in-app GP assistant (`src/ai`). GP answers a
  client's questions inside the bounds of their app context. AI Program
  Builder runs in the coach's hands, before publishing, and produces
  durable rows the client then sees.
- It is **not** a chat interface to "ask the LLM for a workout." The
  coach's own assets are the corpus; the LLM's role is to organize and
  reformat what the coach already has, not to invent.
- It is **not** medical or therapeutic advice. The output is always
  reviewed by the coach before it reaches a client; the existing
  `AIGuardrailsService` referral and floor rules apply when the
  resulting content is later surfaced through GP.

### Why now

- The platform has the durable surfaces a builder would write into:
  `WorkoutRoutine`/`RoutineExercise`, `MealPlan`, `Lesson`,
  `CoachGuideline`, `UserProfile`. We are not inventing the targets.
- We have a typed AI context pattern (`ClientAIContext`) that proves
  out structured-input → LLM → structured-output works in this
  codebase. The Program Builder generalizes that pattern from
  per-request to per-program.
- Billing is in place, so a Program Builder can be priced as a
  feature without rebuilding entitlements.

## 2. Non-goals

The following are explicitly out of scope for this RFC and the first
implementation phase:

1. **Real-time AI program generation.** Drafts are produced by
   background jobs; the coach polls or receives a server-sent event.
   Sub-second latency is not a goal.
2. **Direct client exposure of the builder.** Only coaches (and,
   later, Team Mode collaborators) interact with the builder. Clients
   only see published artefacts.
3. **Replacing the existing GP assistant.** GP keeps its current shape
   and prompt. The Builder may *write* `CoachGuideline` rows GP later
   reads, but GP's prompt assembly is unchanged.
4. **Cross-coach asset sharing.** A coach's ingested assets are
   strictly tenant-scoped to their `coach_id`. A future "marketplace"
   is a separate RFC.
5. **Mobile UI for ingestion or editing.** All authoring happens in
   the coach console (`tgp-coach-console`). The mobile app is
   read-only with respect to the Builder, except for receipt of
   published artefacts via existing routes.
6. **Realtime collaboration on a draft.** Two coaches editing the
   same draft simultaneously is a Team Mode concern (§22) and is not
   solved here.
7. **Auto-adjustment of programs.** The Builder produces a draft *at a
   point in time*. Continuous adaptation (e.g., detecting a plateau
   and re-drafting) is a follow-on RFC that builds on the Outcome
   Graph (§22).

## 3. User stories

Numbered for cross-reference from §6 (API) and §20 (PRs).

### Coach onboarding

- **US-1.** As a coach with a folder of PDFs and unlisted YouTube
  videos, I can upload them once into a "library" and have them
  ingested, transcribed, and indexed without me organizing them by
  hand.
- **US-2.** As a coach, I can connect a Google Drive / Dropbox folder
  (later phase) and have new files ingested incrementally so I do not
  re-upload my whole library on every change.
- **US-3.** As a coach, I can review what was ingested, correct
  miscategorizations (e.g., "this PDF is a nutrition primer, not a
  workout"), and re-run the categorizer.

### Program drafting

- **US-4.** As a coach, given a new client's profile (`UserProfile`,
  goals, prescribed macros, equipment access), I can request a draft
  program in one click and review the output before any of it reaches
  the client.
- **US-5.** As a coach, I can specify constraints — "8-week cut,
  4 days/week, dumbbell-only, vegetarian" — and the draft respects
  them or surfaces a warning when it cannot.
- **US-6.** As a coach, I can iterate on a draft section-by-section
  (workouts, lessons, meal plan, guidelines) without re-running the
  whole pipeline.
- **US-7.** As a coach, I can edit the draft inline, accept it, or
  reject it. Rejected drafts are saved so the coach can compare or
  recover.
- **US-8.** As a coach, the draft surfaces *which of my assets it
  used* (a citation list) so I can trust the output.

### Publishing

- **US-9.** As a coach, accepting a draft writes durable rows
  (`WorkoutRoutine`, `MealPlan`, `Lesson`, `CoachGuideline`) into the
  client's account in a single transaction. There is no half-published
  state.
- **US-10.** As a coach, I can see the diff between the latest draft
  and what was last published, so I know what would change before
  re-publishing.
- **US-11.** As a coach, I can publish the same program (or a
  derivative) to multiple clients without re-drafting per client.

### Operations and admin

- **US-12.** As an OWNER, I can see how much each coach is spending
  in LLM cost and how many drafts they have generated in a window, so
  I can price the feature responsibly.
- **US-13.** As an OWNER, I can throttle, suspend, or refund builder
  usage for a coach without disabling the rest of the platform.
- **US-14.** As an OWNER, I can audit every draft, every published
  program, and the asset citations behind it (§14).

## 4. Architecture

The Builder is a **pipeline**, not a single endpoint. The coach
console submits requests; the backend persists state and dispatches
work; background workers do the slow steps (asset extraction,
embedding, LLM calls); the coach reviews and accepts.

### High-level flow

```
                +---------------------+
                |  Coach console UI   |
                | (tgp-coach-console) |
                +----------+----------+
                           |
                           v
              POST /api/coach/program-builder/...
                           |
+--------------------------+--------------------------+
|                  ProgramBuilderModule               |
|                                                     |
|  ProgramBuilderController  ProgramBuilderService    |
|         |                          |                |
|         v                          v                |
|  AssetIngestionService    DraftOrchestratorService  |
|         |                          |                |
|         v                          v                |
|     job queue (BullMQ on REDIS_URL)                 |
+-----+-----------+------------+---------+------------+
      |           |            |         |
      v           v            v         v
   +------+   +------+   +-------+   +-------+
   | OCR/ |   |trans-|   |embed/ |   | LLM    |
   |parse |   |cribe |   |index  |   |draft   |
   +--+---+   +--+---+   +---+---+   +---+----+
      |          |           |           |
      +----------+-----+-----+-----------+
                       v
                +-------------+
                |  Postgres   |
                | (Prisma)    |
                +-------------+
```

### Modules

A new top-level module `src/program-builder/` (folder name TBD —
§17 Q1) owns the surface. It contains:

- `program-builder.module.ts` — Nest module wiring.
- `program-builder.controller.ts` — coach-only routes.
- `program-builder.service.ts` — domain logic (draft state machine).
- `asset-ingestion.service.ts` — accept, parse, transcribe, chunk,
  embed.
- `draft-orchestrator.service.ts` — given a client + constraints,
  fans out to the LLM and assembles the draft.
- `program-builder.dto.ts` — request/response shapes; `class-validator`
  guards every coach input.
- `program-builder.types.ts` — internal types (mirrors
  `client-ai-context.types.ts` style).
- `program-builder.guardrails.service.ts` — pre- and post-LLM
  validation (no banned substances, no kcal floor violations, no
  contradicting `APP_PRESCRIBED` macros — see §14).

A separate `src/program-builder/jobs/` directory holds the queue
processors (`asset.processor.ts`, `embed.processor.ts`,
`draft.processor.ts`).

The OWNER admin surface lives under `src/admin/` next to the existing
admin routes — not a new module — so RBAC stays consistent.

### Why a new module rather than extending `src/ai`

`src/ai` is GP, a per-client request-time assistant. The Builder is
coach-side, asynchronous, and writes durable program rows. Conflating
the two would force `AiService` to know about asset upload and BullMQ.
The Builder may *consume* `ClientAIContext` (read-only) when drafting,
but it does not extend `AiService`.

### Synchronous vs. async boundary

| Operation | Mode |
|---|---|
| Upload an asset | sync HTTP, returns 202 + `asset_id` |
| Asset parse / transcribe / embed | async job |
| Request a draft | sync HTTP, returns 202 + `draft_id` |
| Draft generation | async job (multiple LLM calls) |
| Edit a draft | sync HTTP |
| Publish a draft | sync HTTP, transactional |

The async boundary is **wherever an LLM is called**. This keeps
request handlers fast and predictable, makes retries cheap, and
allows OWNER cost throttling to act before tokens are spent.

## 5. Data model proposal

All new tables are tenant-scoped to `coach_id` (a `User.id` with
`Role.coach`) and follow existing conventions: `@id @default(uuid())`,
`created_at`/`updated_at`, soft-delete via nullable `archived_at`
where appropriate, indexes on every foreign key, snake_case columns.

> **Status:** proposal only. No migration ships with this RFC.

```prisma
// Asset uploaded or imported by a coach.
model CoachAsset {
  id              String              @id @default(uuid())
  coach_id        String
  coach           User                @relation("CoachAssetOwner", fields: [coach_id], references: [id])
  source_kind     CoachAssetSourceKind
  source_url      String?             // signed URL for object storage
  original_name   String
  mime_type       String
  bytes           BigInt?
  status          CoachAssetStatus    @default(uploaded)
  // Filled in by the parse/transcribe pass.
  category        CoachAssetCategory?
  language        String?             // ISO-639-1
  extracted_text  String?             @db.Text
  // Provenance for QA.
  parser_version  String?
  hash_sha256     String?
  created_at      DateTime            @default(now())
  updated_at      DateTime            @updatedAt
  archived_at     DateTime?

  chunks          CoachAssetChunk[]

  @@index([coach_id, status])
  @@index([coach_id, category])
}

enum CoachAssetSourceKind {
  upload
  google_drive  // phase 2
  dropbox       // phase 2
  url           // phase 2
}

enum CoachAssetStatus {
  uploaded
  parsing
  parsed
  embedding
  ready
  failed
}

enum CoachAssetCategory {
  workout
  nutrition
  lesson
  guideline
  general
  unknown
}

// One chunk of extracted text from a CoachAsset.
// Chunks are the unit of retrieval for the draft pipeline.
model CoachAssetChunk {
  id             String     @id @default(uuid())
  asset_id       String
  asset          CoachAsset @relation(fields: [asset_id], references: [id])
  coach_id       String     // denormalized — every retrieval filters on it
  ordinal        Int        // position in the source asset
  content        String     @db.Text
  // pgvector — see §17 Q3 on whether to use pgvector vs. external store.
  embedding      Unsupported("vector(1536)")?
  token_count    Int?
  created_at     DateTime   @default(now())

  @@index([coach_id])
  @@index([asset_id, ordinal])
}

// A request to draft a program for a specific client.
// One draft has many sections; one client can have many drafts over
// time; only the most recently *published* draft is the source of
// truth for that client's program.
model ProgramDraft {
  id              String              @id @default(uuid())
  coach_id        String
  coach           User                @relation("ProgramDraftCoach", fields: [coach_id], references: [id])
  client_id       String
  client          User                @relation("ProgramDraftClient", fields: [client_id], references: [id])
  status          ProgramDraftStatus  @default(queued)
  prompt_version  String              // see §10
  // Coach-specified constraints. Validated server-side.
  constraints     Json
  // Output assembly is in sections (workouts, meal_plan, lessons,
  // guidelines). Each section may be regenerated independently.
  sections        ProgramDraftSection[]
  // Citation list — which CoachAssetChunk ids fed the draft.
  asset_citations Json?
  // Cost + telemetry, denormalized for OWNER reporting (§16).
  llm_cost_cents  Int                 @default(0)
  llm_tokens_in   Int                 @default(0)
  llm_tokens_out  Int                 @default(0)
  // Lineage — when the coach iterates, the new draft references the
  // parent so we can show diffs (US-10).
  parent_draft_id String?
  parent_draft    ProgramDraft?       @relation("ProgramDraftLineage", fields: [parent_draft_id], references: [id])
  children        ProgramDraft[]      @relation("ProgramDraftLineage")
  created_at      DateTime            @default(now())
  updated_at      DateTime            @updatedAt
  published_at    DateTime?
  archived_at     DateTime?

  @@index([coach_id, client_id, created_at])
  @@index([client_id, status])
}

enum ProgramDraftStatus {
  queued
  generating
  ready_for_review
  editing
  publishing
  published
  rejected
  failed
}

// One section of a draft. Section bodies are JSON until accepted; on
// publish, the body is materialized into the existing tables (see
// §12). Keeping the body as JSON during draft means we can iterate
// without spraying half-built rows across the schema.
model ProgramDraftSection {
  id           String                 @id @default(uuid())
  draft_id     String
  draft        ProgramDraft           @relation(fields: [draft_id], references: [id])
  kind         ProgramDraftSectionKind
  body         Json
  // The exact LLM output before any coach edits — we keep this so
  // evals (§13) can replay against the unedited draft.
  body_initial Json
  status       ProgramDraftSectionStatus @default(generating)
  created_at   DateTime               @default(now())
  updated_at   DateTime               @updatedAt

  @@index([draft_id, kind])
}

enum ProgramDraftSectionKind {
  workout_routine
  meal_plan
  lesson_set
  guideline
  check_in_cadence
}

enum ProgramDraftSectionStatus {
  generating
  ready
  edited
  rejected
  failed
}

// One concrete publishing event. Allows US-9 / US-10: every publish
// is auditable and reversible, and we can show diffs.
model ProgramPublication {
  id                  String   @id @default(uuid())
  draft_id            String   @unique
  draft               ProgramDraft @relation("ProgramDraftPublication", fields: [draft_id], references: [id])
  coach_id            String
  client_id           String
  // Snapshot of what was actually written, by entity type and id.
  // Lets us show diffs against later publications without traversing
  // the live schema.
  written_entities    Json
  published_at        DateTime @default(now())

  @@index([client_id, published_at])
}

// Versioned prompt template. See §10. This is a table not a file so
// rollouts / A/B / per-coach overrides do not need a redeploy.
model BuilderPromptTemplate {
  id              String   @id @default(uuid())
  version         String   @unique
  kind            ProgramDraftSectionKind  // one template per section kind
  body            String   @db.Text
  // Eval suite snapshot at the time of authoring — used by §13.
  eval_baseline   Json?
  is_default      Boolean  @default(false)
  created_at      DateTime @default(now())
  retired_at      DateTime?
}
```

### Notes

- `CoachAssetChunk.embedding` uses pgvector. The Supabase Postgres
  already supports pgvector. This avoids a second datastore for
  Phase 1. §17 Q3 revisits whether we outgrow it.
- `ProgramDraft.parent_draft_id` is the lineage edge. Combined with
  `ProgramPublication`, every program a client has ever received is
  reconstructable.
- `ProgramDraftSection.body_initial` is the unedited LLM output. The
  eval harness (§13) replays prompts against the same chunks and
  diffs against `body_initial`, so coach edits never poison evals.
- All FKs are concrete relations, not orphan strings. The recent
  schema cleanup (`feat(profile)` 46e5f33a, the routine and lesson
  FKs) is the convention to follow.

## 6. API surface

All routes mount under `/api/coach/program-builder/*` and require
`Role.coach`. They are subject to the existing
`SubscriptionGuard` so a coach in `past_due`/`canceled` cannot draft
or publish (the audit trail still records the attempt).

OWNER admin routes mount under `/api/admin/program-builder/*` and
follow `src/admin/` conventions.

Versioning follows the existing `/api/` style. We do not introduce a
`/v2/` prefix; breaking changes ship under a new path or a new field
behind a flag.

### Coach-facing

| Method | Path | Body | Returns | Story |
|---|---|---|---|---|
| `POST` | `/assets` | multipart upload, max 25 MB | `202 { asset_id }` | US-1 |
| `GET` | `/assets` | — | `{ assets: [...] }` paginated | US-3 |
| `GET` | `/assets/:id` | — | full asset detail incl. category | US-3 |
| `PATCH` | `/assets/:id` | `{ category? }` | updated asset | US-3 |
| `DELETE` | `/assets/:id` | — | `204` (soft-delete via `archived_at`) | US-3 |
| `POST` | `/assets/:id/reprocess` | — | `202` | US-3 |
| `POST` | `/drafts` | `{ client_id, constraints, parent_draft_id? }` | `202 { draft_id }` | US-4, US-5 |
| `GET` | `/drafts` | `?client_id=&status=` | paginated drafts | US-7, US-10 |
| `GET` | `/drafts/:id` | — | full draft incl. sections | US-7 |
| `POST` | `/drafts/:id/regenerate-section` | `{ kind }` | `202` | US-6 |
| `PATCH` | `/drafts/:id/sections/:section_id` | `{ body }` | updated section | US-7 |
| `POST` | `/drafts/:id/publish` | — | `200 { publication_id }` | US-9 |
| `POST` | `/drafts/:id/reject` | `{ reason? }` | `200` | US-7 |
| `GET` | `/drafts/:id/diff/:other_draft_id` | — | structural diff | US-10 |

Streaming (SSE) is reserved for `/drafts/:id/events` in a later phase
so the console can surface "asset 3 of 7 ingested" without polling.
Phase 1 is poll-only on `GET /drafts/:id` to keep the surface minimal.

### OWNER admin

| Method | Path | Returns | Story |
|---|---|---|---|
| `GET` | `/admin/program-builder/usage` | per-coach token + cost rollup | US-12 |
| `POST` | `/admin/program-builder/coaches/:id/throttle` | adjust per-coach quota | US-13 |
| `GET` | `/admin/program-builder/drafts/:id/audit` | full prompt + retrieved chunks | US-14 |
| `GET` | `/admin/program-builder/templates` | list `BuilderPromptTemplate` | §10 |
| `POST` | `/admin/program-builder/templates` | author a new template version | §10 |

### Throttling

Per-coach throttles (defaults — settable via the OWNER endpoint above):

- Asset upload: 50 / hour, total 500 / day.
- Draft create: 10 / hour, 50 / day.
- Section regenerate: 30 / hour, 100 / day.

These are enforced via the existing `ThrottlerModule` keyed on
`coach_id`. Exceeding the hourly limit returns `429 builder_quota`.

### Errors

All errors follow `docs/api-conventions.md`: `{ code, message, hint? }`,
not a string body. Builder-specific codes:

| Code | Status | Meaning |
|---|---|---|
| `builder_quota` | 429 | per-coach quota exhausted |
| `builder_unavailable` | 503 | LLM provider degraded; retry later |
| `asset_too_large` | 413 | upload over the per-asset cap |
| `asset_unsupported_mime` | 415 | mime not in the allow-list |
| `draft_not_ready` | 409 | tried to publish or edit a draft still generating |
| `client_constraint_violation` | 409 | constraints contradict `UserProfile` (e.g., kcal floor) |
| `safety_violation` | 422 | guardrails refused output (banned substance, etc.) |

## 7. Background jobs and queues

We use **BullMQ** on the existing `REDIS_URL`. Redis is already a
prod-tier requirement for the multi-machine throttler, so adding a
queue does not introduce a new infra dependency.

### Queues

| Queue | Producer | Consumer | Concurrency | Max attempts |
|---|---|---|---|---|
| `asset.parse` | `POST /assets` | `asset.processor.ts` | 4 per machine | 3 (exp backoff) |
| `asset.embed` | parse success | `embed.processor.ts` | 8 per machine | 3 |
| `draft.generate` | `POST /drafts` | `draft.processor.ts` | 2 per machine | 2 |
| `draft.section.regenerate` | `POST /regenerate-section` | `draft.processor.ts` | 2 per machine | 2 |

Concurrency caps are tuned for the smallest Fly machine size;
production scaling is via more machines, not bigger queues, so the
per-machine numbers stay honest.

### Failure handling

- Three failures move a job to a dead-letter queue with the original
  payload + error.
- A failed asset transitions to `CoachAssetStatus.failed`; the coach
  sees it in `GET /assets` and can retry with `POST /reprocess`.
- A failed draft section transitions to
  `ProgramDraftSectionStatus.failed`; the rest of the draft is still
  reviewable. The coach can regenerate just that section.
- All job failures emit a Sentry event with the queue name, job id,
  coach id (never client id at the breadcrumb level — see §14 for
  PII rules), and attempt count.

### Idempotency

Every job carries a deterministic id derived from its inputs:

- `asset.parse`: `asset_id + parser_version`.
- `asset.embed`: `asset_id + embedding_model_version`.
- `draft.generate`: `draft_id + prompt_version`.

BullMQ rejects a duplicate id within the dedupe window, so a retried
HTTP request never spawns a duplicate run.

## 8. Asset ingestion

### Inputs

Phase 1 supports direct upload via the coach console. Phase 2 adds
Google Drive and Dropbox connectors (deferred — §17 Q4 and §20).

### Allow-listed mime types

| Family | Mime types | Handling |
|---|---|---|
| Documents | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown` | text extraction (pdf2text or equivalent) |
| Spreadsheets | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | row-oriented extraction; column headers preserved |
| Audio | `audio/mpeg`, `audio/mp4`, `audio/wav` | transcription (provider — §9) |
| Video | `video/mp4`, `video/quicktime` | transcription (audio track only); no frame analysis in Phase 1 |
| Images | `image/png`, `image/jpeg` | optional OCR (deferred to Phase 2) |

The mime allow-list is enforced at the controller. Anything outside
returns `asset_unsupported_mime`. Per-asset cap is 25 MB (videos can
be linked rather than uploaded — §17 Q5 covers the unlisted-YouTube
flow).

### Storage

Uploads land in **Supabase Storage** under a per-coach prefix
(`coach-assets/{coach_id}/{asset_id}.{ext}`). The bucket is private;
signed URLs are short-lived (10 min) and minted on demand. We do not
proxy bytes through Nest — the upload is direct to Supabase Storage
with a backend-issued upload token, mirroring the existing pattern
for any per-coach private content.

Rationale: Supabase already auths every request against the
service-role key the backend holds, and we avoid the operational
cost of a separate S3 bucket.

### Extraction pipeline

```
upload → asset.parse job
            ├── mime → handler
            │     ├── pdf  → text
            │     ├── docx → text
            │     ├── csv  → structured rows + flattened text
            │     └── audio/video → transcription provider
            ├── language detect (cheap heuristic, then provider only if low confidence)
            ├── coarse category classifier (cheap LLM call, see §9)
            ├── store extracted_text + category on CoachAsset
            └── enqueue asset.embed
```

### Chunking and embedding

- Text is split into ~800-token chunks with 100-token overlap, on
  paragraph boundaries when present.
- Each chunk is embedded with the configured embedding model
  (`text-embedding-3-small` family — small, cheap, sufficient).
- Chunks land in `CoachAssetChunk` with `coach_id` denormalized so
  every retrieval can filter on it without a join.

### Retrieval

When the draft pipeline needs corpus, it retrieves the top-k
(default k=8) chunks per `ProgramDraftSectionKind` filtered to the
drafting coach. The retrieved chunk ids are recorded in
`ProgramDraft.asset_citations` so the coach (US-8) and an OWNER
audit (US-14) can see what fed the draft.

### Re-ingestion

If the parser version changes, all assets for a coach are not
re-parsed automatically — that would explode cost. Instead, the
OWNER admin can trigger a coach-scoped re-parse, and the coach can
trigger per-asset re-parse via `POST /assets/:id/reprocess`.

## 9. LLM and provider strategy

### Provider posture

We are **provider-pluggable but provider-pinned**. The interface in
front of any LLM is small enough to swap providers; the production
configuration pins a single provider per task to keep the eval
surface honest.

### Provider choices (Phase 1)

| Task | Provider | Why |
|---|---|---|
| Embeddings | OpenAI-compatible `text-embedding-3-small` | Already pulled in via `openai` package; cheap; good quality at 1536 dims; matches pgvector column. |
| Drafting (per section) | Anthropic Claude (Sonnet class) | Higher-quality structured output; better at instruction-following for "use only the provided assets" framing; supports prompt caching for the static system prompt. |
| Audio transcription | Deepgram or OpenAI Whisper | Pick one and pin; both are ergonomically similar. §17 Q6. |
| Lightweight category classifier | Anthropic Haiku class | Cheap, fast, sufficient for "is this a workout, nutrition, or lesson" given a prefix of extracted text. |
| Fallback (provider down) | Deterministic responder, same shape as `src/ai`'s fallback | Ensures the builder degrades to a coach-authorable empty draft rather than failing closed. |

### Justification

GP uses Perplexity today and we keep that. The Builder uses Anthropic
because:

- Drafting is **structured output sensitive**. The Builder must emit
  JSON that maps cleanly into `RoutineExercise[]`, `MealPlan.items`,
  etc. Anthropic's constrained-output and tool-use behavior is
  reliable for this; the eval harness (§13) will validate it
  empirically before we commit.
- Drafting prompts are large (system + retrieved chunks + client
  context). Anthropic's prompt caching makes the per-draft cost
  competitive with smaller-model alternatives.
- Decoupling the Builder from GP lets us evolve each independently.
  We are not required to pick the same provider for both.

### The provider interface

A thin internal abstraction in `program-builder/llm/`:

```ts
interface BuilderLLM {
  draftSection(input: DraftSectionInput): Promise<DraftSectionOutput>;
  classifyAsset(input: ClassifyInput): Promise<CoachAssetCategory>;
  // No streaming in Phase 1.
}
```

`DraftSectionInput` is a typed bundle: client context (read-only),
constraints, retrieved chunks, prompt template body, prompt version.
Implementations of `BuilderLLM`:

- `AnthropicBuilderLLM` (production).
- `OpenAIBuilderLLM` (parity check; not wired in production).
- `DeterministicBuilderLLM` (fallback; uses a fixed template against
  retrieved chunks; deterministic for tests).

Provider selection is via `BUILDER_LLM_PROVIDER` env var (§17 Q7
covers naming and tier).

### Token and context limits

Each section draft has a hard cap on retrieved-chunk tokens (default
6 000) and on output tokens (default 4 000). The cap protects against
runaway cost when a coach uploads a 200-page manual.

When retrieved-chunk tokens exceed the cap, we **summarize-then-draft**:
a second LLM pass produces section-relevant summaries from the
top-k chunks before the drafting prompt runs. The summary cost is
recorded on `ProgramDraft.llm_cost_cents` like any other call.

### Provider degradation

The provider call is wrapped in:

1. Single retry on a 5xx or transient timeout (≥30 s).
2. On second failure, the section transitions to `failed` — the rest
   of the draft is still useful.
3. A surge in provider failures opens a circuit (per-coach, then
   global) that diverts to the deterministic fallback. The circuit
   is observable via OWNER metrics (§16).

## 10. Prompt and template versioning

Prompts are **content** in this system, not code. They live in the
`BuilderPromptTemplate` table, addressable by `version` (semver-ish
string, e.g. `workout.2026-04.0`). Every draft records the
`prompt_version` it ran against. Every eval (§13) records the same.

### Why a table, not files

- Rolling out a new prompt does not require a redeploy.
- A bad prompt rolls back in one row update.
- Per-coach overrides (e.g., a flagged early-access coach) are a
  `WHERE coach_id =` flip, not a config-file fork.
- Auditing what prompt produced what draft is a join, not a git
  spelunk.

### Authoring flow

- A new template starts as `is_default: false`.
- The template is run against the eval set (§13). Pass/fail is
  attached as `eval_baseline`.
- An OWNER promotes it via the admin endpoint, which sets
  `is_default: true` for that `kind` and `retired_at` on the previous
  default in the same transaction.
- Active drafts already in flight keep their pinned version; only
  new drafts pick up the new default.

### Per-section templates

Each `ProgramDraftSectionKind` gets its own template. Mixing all
sections into one prompt was tried in early experiments (not in
this codebase; informal industry experience) and produced bleed —
the meal plan ends up with workout phrasing, the lesson ends up
with macro contradictions. Per-section keeps each output narrow.

### Template body conventions

- Absolute rules first ("Do not contradict APP_PRESCRIBED macros",
  "Use only the provided assets, do not invent exercises").
- A `CLIENT_CONTEXT` block, derived read-only from `ClientAIContext`.
- A `RETRIEVED_ASSETS` block, the top-k chunk citations.
- A `CONSTRAINTS` block, the coach-supplied JSON.
- An `OUTPUT_SCHEMA` block enumerating the JSON shape expected.
- The same em-dash / exclamation mark scrub that GP uses, applied
  post-LLM, to keep voice consistent across the product.

### Diff visibility

Old templates are kept indefinitely (we never hard-delete a
`BuilderPromptTemplate`). Drafts tied to retired templates remain
reproducible. This matters for §13 (replay).

## 11. Human-in-the-loop editing

The coach is the system of record. The LLM proposes; the coach
disposes.

### Editing surface

- The console renders each section in a structured editor:
  - Workout routine: an editable table of exercises (sets, reps,
    rest, video URL).
  - Meal plan: a per-day card with editable items.
  - Lessons: a list of lesson cards with title, description, and
    asset citation.
  - Guidelines: a markdown editor with the LLM's draft preloaded.
  - Check-in cadence: a small form (frequency, fields).
- Every section has three buttons: **Accept**, **Regenerate**,
  **Reject**.
- "Edit" is implicit: any change to the structured editor saves to
  `ProgramDraftSection.body`. `body_initial` is preserved.

### State machine

```
queued ──> generating ──> ready_for_review ──┬─> editing ──> published
                                              ├─> rejected
                                              └─> failed (retryable)
```

Transitions are server-enforced; the controller refuses
`PATCH /sections/:id` if the section is not in `ready` or `edited`,
and refuses `POST /publish` if any section is not in `ready` or
`edited`.

### Why preserve `body_initial`

Three reasons:

1. **Evals (§13).** We measure model quality against the unedited
   draft, not the coach-edited final.
2. **Recovery.** A coach who edits and then regrets can restore the
   initial.
3. **Coach feedback signal.** A diff between `body_initial` and
   `body` is the strongest possible signal that the prompt has a
   gap. We do not auto-train on it (§14), but an OWNER can
   inspect it.

## 12. Publishing workflow

Publish is the only step that writes into the existing program
schema. It is **transactional** (Prisma `$transaction`) so a partial
publish is impossible.

### What publish writes, by section kind

| Section kind | Target | Notes |
|---|---|---|
| `workout_routine` | `WorkoutRoutine` + `RoutineExercise[]` | `creator_id` = coach. `is_template = false` for client-specific. |
| `meal_plan` | `MealPlan` | `items` JSON written verbatim from `body`. |
| `lesson_set` | `Lesson[]` | `coach_id` = coach. `goal_tags` derived from constraints. |
| `guideline` | `CoachGuideline` | unique on `(coach_id, client_id)` — we **upsert**. |
| `check_in_cadence` | `NotificationPreferences` (additive fields TBD — §17 Q8) | If we cannot land cleanly in Phase 1, this section is non-publishing for now and stays as guidance the coach copies into existing flows. |

### Re-publish

A subsequent publish to the same client:

- Inserts new `WorkoutRoutine`, `MealPlan`, `Lesson` rows; the old
  ones remain (they are addressable by id from the old
  `ProgramPublication`). The mobile app already pages by
  `created_at`, so the newest is the one a client sees.
- Upserts `CoachGuideline` (one row per pair).

This avoids the trap of trying to *update* a routine that the client
has already begun executing — which would mutate history under their
feet. The old routine stays as is; the new one becomes their current.

### Publication record

Every publish writes a `ProgramPublication` row with
`written_entities` capturing the ids of every row touched. A future
"unpublish" or "rollback" feature reads this record; we do not ship
unpublish in Phase 1, but the data shape supports it.

### Audit

Every publish writes an `AuditLog` entry with action
`program.published`, `actor_id` = coach, `target_id` = client,
`metadata` = `{ draft_id, publication_id, sections: [kind, ...] }`.
This satisfies the existing audit posture (`docs/audit-and-gdpr.md`).

## 13. Evaluation and QA

### Eval set

A versioned, in-repo set of synthetic coach + client fixtures lives
under `test/program-builder/fixtures/`:

- 10 coaches with varied asset libraries (workout-heavy,
  nutrition-heavy, generalist, video-heavy, sparse).
- 30 clients with varied profiles (cut, bulk, recomp, beginner,
  advanced, equipment constraints, dietary constraints).
- Per-pair, a "gold" expected shape (not exact text — structural
  expectations, e.g. "draft has 4 workout days, ≥1 lower-body
  session, no banned-substance language, kcal target within 10 % of
  prescribed").

The eval set is **not** real coach data. We never copy a real coach's
assets into the test corpus.

### Eval runner

A script `scripts/run-builder-evals.ts` that:

1. Loads each fixture pair.
2. Runs the draft pipeline against the configured prompt version.
3. Scores the output against the gold expectations.
4. Emits a JSON report and a human-readable diff.

The eval runner is **not** wired to CI by default — it costs real
LLM tokens. It is gated behind an OWNER manual trigger and runs in a
dedicated Fly app or local dev. Per-prompt-version baselines are
stored in `BuilderPromptTemplate.eval_baseline`.

### Regression

A "smoke" subset of the eval set (3 pairs) runs locally in
`npm run test:builder:smoke` against a deterministic LLM stub
(`DeterministicBuilderLLM`). It tests:

- The pipeline routes correctly.
- The publish transaction is atomic.
- Guardrails fire on banned-substance and kcal-floor inputs.
- Idempotency keys deduplicate as expected.

This subset is in CI from Phase 1.

### Human review for top defects

Top 5 % most-edited drafts (by `body_initial` ↔ `body` diff size) are
flagged for OWNER review weekly. Persistent diffs in one direction
(e.g., the LLM consistently picks the wrong rep range) trigger a
prompt revision.

## 14. Safety, privacy, and compliance

### Tenancy and access control

- `coach_id` is the tenancy axis. Every Builder query filters on it
  server-side. A coach can never read another coach's assets, drafts,
  or templates.
- Coach console requests carry the Supabase JWT; the role guard is
  the existing `Role.coach` check from `src/auth`.
- Cross-tenant test: every Builder controller has a "wrong-coach"
  spec that asserts a 404 (not 403 — leakage avoidance).

### Provider data handling

- We pin providers that contractually do not retain or train on API
  inputs (Anthropic API, OpenAI API with the no-retention default).
  If a provider's terms change, we change provider before sending.
- The OWNER-facing provider matrix is documented in
  `docs/program-builder.md` (a follow-up doc) and reviewed quarterly.
- We do **not** send raw client PII to providers. The
  `CLIENT_CONTEXT` block contains the same shape `ClientAIContext`
  exposes today (no email, no phone, no last name, no DOB), plus
  derived constraints. Asset chunks are coach-authored, but if a
  coach uploads a PDF that contains client names, the chunk goes to
  the provider — the OWNER documentation calls this out and the
  console UI warns coaches not to upload client-identifying material.

### Banned content

The same `AIGuardrailsService` rules used by GP run on every draft
section before it is presented to the coach (§14 reuses the
guardrails from `src/ai/ai-guardrails.service.ts` — see §17 Q9 on
extracting them into a shared module):

- Banned substances → redacted.
- Sub-floor calorie targets → blocked.
- Macro contradictions vs. `APP_PRESCRIBED` → blocked.
- Medical / injury / ED / mental-health framing → referral line
  prepended.

A blocked section transitions to `failed` with a `safety_violation`
metadata blob. The coach sees a structured warning with the rule
that fired.

### GDPR

- A client's published programs (`WorkoutRoutine`, `MealPlan`,
  `Lesson`, `CoachGuideline`) are already part of the existing GDPR
  export and scrub flows (`docs/audit-and-gdpr.md`). No new work.
- Drafts targeting that client are added to the export bundle and
  the scrub. `ProgramDraft.client_id` is the join key.
- Coach-owned assets are not part of a client's export — they are
  the coach's IP. They are part of the coach's export when the coach
  requests one.
- Audit entries for `program.published` follow the existing
  append-only convention.

### Right to be forgotten

- `GdprScrubService` is extended to:
  - Null `ProgramDraft.client_id` and tombstone `body` for drafts
    targeting a scrubbed client.
  - Leave `CoachAsset` and `CoachAssetChunk` untouched (coach IP,
    not client PII).

### Coach-uploaded content moderation

- We do not run general content moderation on uploaded coach assets
  in Phase 1. The coach is contractually responsible for their own
  content. If the asset extraction surfaces banned-substance text,
  the *draft* is blocked at the guardrail step (§14), not the
  upload — but the OWNER admin can flag and remove an asset
  manually.

### Training opt-out

- We never use coach assets, prompts, or drafts to train any model.
  This is stated in the coach Terms of Service (a docs PR pairs the
  legal copy with §6's surface). The provider contracts back this
  up on the model side.

## 15. Cost controls

LLM cost is the single largest operational risk of this feature.

### Per-coach budget

- Default monthly budget per coach: `$BUILDER_DEFAULT_BUDGET_USD`
  (suggested 25 USD; tunable). When 80 % is consumed, the console
  surfaces a warning. When 100 % is consumed, drafting is blocked
  (`builder_quota`); editing and publishing are not.
- OWNER admin can lift, lower, or reset the budget per coach.
- The budget tracker reads from `ProgramDraft.llm_cost_cents` summed
  per `coach_id` per calendar month.

### Per-draft cap

- A single draft is capped at 50 000 input tokens and 8 000 output
  tokens across all sections. Exceeding the cap aborts the draft
  with `builder_quota`.

### Caching

- Anthropic prompt caching is used for the static system prompt of
  each `ProgramDraftSectionKind`. Cache TTL is provider-default (5
  minutes). On a hot coach, this cuts input cost roughly in half.
- Embeddings are cached on the chunk (we never re-embed the same
  chunk).
- Asset transcriptions are cached on the asset hash, so a coach
  re-uploading the same PDF does not re-extract.

### Batch where possible

- The cheap category classifier is batched per-asset on parse. We
  do not pay round-trip per chunk.
- The summarize-then-draft pass (§9) only fires when needed.

### Rate ceiling on the queue

- `draft.generate` queue concurrency is 2 per machine. Across a
  small Fly fleet, this is a hard upper bound on simultaneous
  spend. Cost spikes are observable in the OWNER metrics endpoint
  (§16) within a minute.

### Skeleton no-op

If we ship a Phase-0 skeleton (§20 PR-1), the LLM call sites are
**stubbed** to the deterministic responder. No real provider tokens
are spent until Phase 1 explicitly enables a provider key in env.

## 16. Observability

### Metrics

Surface the following on `/api/admin/metrics` (existing OWNER
endpoint, additive fields):

- `program_builder.assets_total` (gauge by status).
- `program_builder.drafts_total` (counter by status).
- `program_builder.publishes_total` (counter).
- `program_builder.llm_cost_cents_30d` (gauge, per coach top-N).
- `program_builder.queue_depth` (gauge per queue).
- `program_builder.provider_failure_rate_5m` (gauge).
- `program_builder.guardrail_block_rate_24h` (gauge).

### Events (PostHog)

Per the existing `src/analytics/events.ts` conventions:

- `builder.asset.uploaded` — coach, asset_id, mime, bytes.
- `builder.asset.parsed` — coach, asset_id, ms, success.
- `builder.draft.requested` — coach, client_id, prompt_version,
  constraint_keys.
- `builder.draft.section.regenerated` — coach, draft_id, kind.
- `builder.draft.published` — coach, client_id, sections.
- `builder.draft.rejected` — coach, draft_id, reason.

No client PII in any event. `client_id` is a UUID; we do not include
client name or email. This matches the existing PostHog posture.

### Logs

- All Builder log lines carry `coach_id`, `draft_id` (when
  applicable), and `prompt_version`. They never carry asset chunk
  text or LLM completions.
- A surge in `program_builder.provider_failure_rate_5m` is the
  on-call signal that we have a provider problem.

### Sentry

- Every queue failure produces a Sentry event with the queue name,
  attempt count, and a redacted error (no chunk text, no completion
  text).
- A guardrail block is **not** a Sentry error — it is expected
  behavior and only emits a PostHog event.

## 17. Open questions

These must close before Phase 1 begins. Each owner is the person who
opens the follow-up issue, not the implementer.

1. **Module folder name.** `program-builder` vs. `coach-program` vs.
   `builder`. Owner: backend lead. Bias: `program-builder` for clarity.
2. **pgvector dim.** 1536 (OpenAI small) vs. 3072 (OpenAI large).
   Smaller is cheaper and faster; larger may improve retrieval.
   Owner: ML / backend. Bias: 1536 in Phase 1; benchmark in Phase 2.
3. **pgvector vs. external store.** Once a coach has > 50 000 chunks,
   does pgvector still hold up on Supabase Postgres? If not, swap to
   a managed vector store. Owner: backend lead. Decision before
   Phase 2.
4. **Drive / Dropbox connectors.** Build vs. defer to Phase 3 vs.
   never (uploads only). Owner: product. Bias: defer.
5. **Unlisted-YouTube ingestion.** Many coaches host video on
   YouTube. We can resolve a YouTube URL to its captions if
   available; otherwise, transcribe via the audio extraction path.
   Owner: backend. Bias: caption-first, transcribe-fallback in
   Phase 2.
6. **Transcription provider.** Deepgram vs. OpenAI Whisper. Owner:
   backend. Bias: pick one and pin; cost is similar.
7. **Provider env var naming.** `BUILDER_LLM_PROVIDER` vs.
   `PROGRAM_BUILDER_PROVIDER`. Tier: `prod` if the feature ships
   without a deterministic-only mode, otherwise `optional`. Owner:
   backend.
8. **Check-in cadence target.** Does Phase 1 publish a check-in
   cadence section? If `NotificationPreferences` cannot accommodate
   without a migration, this section stays advisory in Phase 1.
   Owner: backend.
9. **Guardrail extraction.** `AIGuardrailsService` lives in
   `src/ai`. The Builder needs the same rules. Extract to
   `src/common/guardrails/` or import directly from `src/ai`?
   Bias: extract; keeps both modules clean. Owner: backend.
10. **Draft retention.** Drafts grow without bound. Default policy:
    keep all `published` and `rejected` drafts for 1 year, archive
    after. Owner: backend.
11. **Per-coach prompt overrides.** Do we ship the override row in
    Phase 1 or Phase 2? Phase 1 is fine on `is_default` per kind.
    Owner: product.
12. **Pricing.** Is the Builder bundled into the existing coach SaaS
    plan or priced as an add-on? Drives whether `entitlements.md`
    needs a new bundle. Owner: founder.

## 18. Rollout plan

The Builder ships behind a feature flag (`BUILDER_ENABLED`) and a
per-coach allow-list. Stages, in order:

### Stage 0 — RFC merge (this PR)

- Docs only. No runtime, no migration.
- Outcome: shared technical understanding; engineering can split
  follow-up work into the Phase-1 PRs.

### Stage 1 — Skeleton, behind flag (PR-1)

- New module, controllers return `503 builder_unavailable`.
- No migration. No queue. No provider.
- Outcome: routes are addressable; OpenAPI updates; the coach
  console can integrate against a stable surface in parallel with
  backend work.

### Stage 2 — Asset ingestion only (PR-2 + PR-3)

- Migration: `CoachAsset` + `CoachAssetChunk`.
- Routes: upload, list, parse, embed, reprocess.
- Queue: `asset.parse`, `asset.embed`.
- Provider: embeddings only.
- OWNER allow-list: 1 internal coach (us) + 1 friendly external
  coach.
- Outcome: a coach can upload assets and see them parsed and
  categorized; no drafting yet.

### Stage 3 — Drafting, internal-only (PR-4)

- Migration: `ProgramDraft`, `ProgramDraftSection`,
  `BuilderPromptTemplate`.
- Routes: create draft, get draft, regenerate section, edit section.
- Queue: `draft.generate`, `draft.section.regenerate`.
- Provider: Anthropic for draft, plus deterministic fallback.
- Allow-list: us only.
- Outcome: end-to-end pipeline against real assets, no publishing
  yet.

### Stage 4 — Publishing, internal-only (PR-5)

- Migration: `ProgramPublication`.
- Routes: publish, reject, diff.
- Outcome: full loop. We use it on ourselves. We measure cost,
  edit-distance, and time-to-publish.

### Stage 5 — Friendly-coach beta (PR-6)

- Allow-list expansion. Per-coach budgets enforced. OWNER admin
  surface live.
- Outcome: 5–10 friendly coaches, weekly review of edits and cost.

### Stage 6 — General availability

- Allow-list removed; gate is now a paid entitlement.
- Outcome: feature on for paying coaches. Continuous eval and
  prompt iteration.

### Rollback posture

- Every stage is reversible by flipping `BUILDER_ENABLED` off; the
  routes return 503 and existing program tables are untouched.
- Migrations are forward-only (existing repo convention) but every
  new table is **additive**. No rename, no drop, no NOT-NULL
  retrofit on existing tables.

## 19. Test plan

### Unit

- DTO validation: every DTO has a "rejects malformed input" spec.
- Asset parser: per-mime extractor specs against fixture files.
- Chunker: deterministic chunking against fixed input.
- Guardrails: each rule on representative inputs (mirror
  `test/ai-guardrails.service.spec.ts`).
- Draft state machine: each illegal transition rejected.
- Provider abstraction: `DeterministicBuilderLLM` is exercised in
  every controller spec so unit tests never hit a real provider.

### Integration

- Full pipeline against `DeterministicBuilderLLM`:
  - Upload → parse → embed → ready.
  - Draft request → generating → ready_for_review.
  - Edit + publish → durable rows in `WorkoutRoutine`,
    `RoutineExercise`, `MealPlan`, `Lesson`, `CoachGuideline`.
- Cross-tenant isolation: a wrong-coach call returns 404.
- Subscription gate: a `past_due` coach gets blocked at draft
  request and at publish.
- Audit: every publish writes the expected `AuditLog` row.

### Eval (manual)

- See §13. Owner-triggered, not in CI.

### Smoke

- Add `npm run smoke:builder` running against staging:
  - Upload a 1-page test PDF.
  - Wait for `ready`.
  - Request a draft against a synthetic test client.
  - Wait for `ready_for_review`.
  - Publish.
  - Assert the `WorkoutRoutine` and `MealPlan` rows exist and have
    the expected shape.
  - Tear down (delete test artefacts).
- Pairs with the existing staging smoke (`scripts/smoke.ts`)
  conventions.

### Load

- Synthetic load: 50 coaches × 10 drafts in 1 hour against the
  deterministic LLM. Asserts queue throughput, no DB deadlocks, and
  cost telemetry rolls up correctly.

## 20. Implementation phases and follow-up PRs

This RFC's only artefact is itself plus a docs index entry. Every
runtime change ships as a separate PR. Each follow-up PR is small,
reviewable in under an hour, and rolls back cleanly.

### PR-0 — RFC (this PR)

- `docs/rfcs/ai-program-builder.md`.
- `docs/README.md` link.
- No runtime change, no migration. **Stays draft until reviewed.**

### PR-1 — Skeleton module behind flag

- `src/program-builder/` with controller + module + DTOs.
- All routes return `503 builder_unavailable` when
  `BUILDER_ENABLED !== 'true'`.
- `BUILDER_ENABLED` registered in `env-validation.ts` as
  `optional`.
- OpenAPI export picks up the new routes.
- Tests: route registration, 503 path, role guard.
- No migration.

### PR-2 — Asset table + upload endpoint

- Prisma migration: `CoachAsset` only (chunks come in PR-3).
- `POST /assets`, `GET /assets`, `GET /assets/:id`,
  `PATCH /assets/:id`, `DELETE /assets/:id`.
- Supabase Storage bucket setup (operator runbook entry).
- BullMQ wiring for `asset.parse`; processor is a no-op stub that
  flips status to `parsed`.
- Tests: upload, mime allow-list, per-coach quota, soft-delete.

### PR-3 — Asset extraction + embedding

- Prisma migration: `CoachAssetChunk` (pgvector enabled in same
  migration if not already on).
- Real parsers per mime family (PDF, docx, csv, txt, md).
- `asset.embed` queue, processor, embedding provider client.
- Reprocess endpoint.
- Tests: extraction fidelity per mime, chunking, embedding stub.

### PR-4 — Draft state machine + LLM drafting

- Prisma migration: `ProgramDraft`, `ProgramDraftSection`,
  `BuilderPromptTemplate`.
- Routes: `POST /drafts`, `GET /drafts`, `GET /drafts/:id`,
  `POST /drafts/:id/regenerate-section`,
  `PATCH /drafts/:id/sections/:section_id`,
  `POST /drafts/:id/reject`.
- `BuilderLLM` interface + `AnthropicBuilderLLM` +
  `DeterministicBuilderLLM`.
- Guardrail integration (extracted per §17 Q9).
- Tests: state-machine transitions, deterministic LLM end-to-end,
  guardrail blocks.

### PR-5 — Publish + diff

- Prisma migration: `ProgramPublication`.
- `POST /drafts/:id/publish`, `GET /drafts/:id/diff/:other_draft_id`.
- Transactional write into `WorkoutRoutine`, `RoutineExercise`,
  `MealPlan`, `Lesson`, `CoachGuideline`.
- Audit entry on publish.
- Tests: publish atomicity, re-publish behavior, audit write.

### PR-6 — OWNER admin + cost controls

- `src/admin/program-builder/` with usage and throttle endpoints.
- Per-coach budget enforcement in `program-builder.service.ts`.
- `/api/admin/metrics` additive fields.
- Tests: throttle path, budget exhaust, cross-tenant isolation on
  admin reads.

### PR-7 — Eval harness

- `scripts/run-builder-evals.ts`.
- Fixture set under `test/program-builder/fixtures/`.
- `npm run test:builder:smoke` deterministic smoke.
- No CI change for the full eval (manual trigger only).

### PR-8 — Docs and operator runbook

- `docs/program-builder.md` operator guide.
- `docs/deploy-runbook.md` updates: BullMQ workers, env vars,
  rollback procedure.
- `docs/entitlements.md` update if PR-9 lands an entitlement bundle
  (depends on §17 Q12).
- Coach Terms of Service language about training opt-out (legal
  pairing).

### PR-9 — Entitlement gate (optional, gated on §17 Q12)

- New `entitlements.md` bundle if pricing decides add-on.
- `SubscriptionGuard` extended.
- Tests: gated coach is blocked.

### Phase 2 (post-GA)

Each is a separate RFC, not committed by this one:

- Drive / Dropbox connectors.
- YouTube caption ingestion.
- Per-coach prompt overrides UI.
- Realtime SSE on `/drafts/:id/events`.
- Continuous adaptation (Outcome Graph, §22).
- Team Mode (junior-coach drafting under senior coach, §22).

## 21. Links to existing models

The Builder is **additive** — it writes into the existing schema, it
does not replace any of it. Mapping:

| Existing model | How the Builder uses it |
|---|---|
| `User` (`Role.coach`) | `coach_id` on every Builder table. |
| `User` (`Role.student`) | `client_id` on `ProgramDraft`. |
| `UserProfile` | Source of truth for goals, equipment, dietary constraints. Read-only at draft time. |
| `CoachProfile` | Read-only; informs OWNER usage rollups. |
| `CoachSubscription` | `SubscriptionGuard` denies `past_due`/`canceled`. |
| `WorkoutRoutine` + `RoutineExercise` | Publish target for `workout_routine` sections. |
| `MealPlan` | Publish target for `meal_plan` sections. |
| `Lesson` + `LessonCompletion` | Publish target for `lesson_set` sections. |
| `CoachGuideline` | Publish target for `guideline` sections (upsert). |
| `NotificationPreferences` | Possible publish target for `check_in_cadence` (§17 Q8). |
| `AuditLog` | One entry per publish. |
| `DataExportRequest` / GDPR scrub | Drafts targeting a scrubbed client are tombstoned. |
| `ClientCoachConsent` | The coach must have an active consent edge with the client before a draft can be published to that client. (Same gate as `MealPlan` writes today.) |
| `ClientAIContext` (`src/ai`) | Read-only feed for the `CLIENT_CONTEXT` prompt block. **No coupling** to the GP request flow. |
| `AIGuardrailsService` (`src/ai`) | Extracted to `src/common/guardrails/` (§17 Q9) and reused. |
| `AnalyticsModule` | PostHog events per §16. |
| `ThrottlerModule` | Per-coach quotas per §6. |

## 22. Forward-compatibility: Outcome Graph and Team Mode

These are aspirational features the founder has signalled. The
Builder is shaped so they slot in without redesign.

### Outcome Graph

The Outcome Graph is the durable, time-indexed record of every
intervention (workout, meal, lesson, guideline) and every observable
outcome (weight, check-in, adherence) per client. Today this exists
implicitly across `WorkoutSession`, `LoggedFoodEntry`, `WeightLog`,
`CheckIn`, etc. The Builder is naturally an Outcome Graph producer:

- Every `ProgramPublication.written_entities` is a structured
  changelog of interventions, by entity id, by time.
- Every section's `body_initial` and `body` capture the *intent* of
  the intervention separately from the *execution*.
- A future Outcome Graph service can join `ProgramPublication`
  against `WorkoutSession` / `WeightLog` / `CheckIn` to attribute
  outcomes to specific interventions, per client and per coach.

The Builder's contract for Outcome Graph readiness:

1. Every published row is traceable to a `ProgramPublication.id`.
2. Every `ProgramPublication` is traceable to a `ProgramDraft.id`,
   which is traceable to a `BuilderPromptTemplate.version`.
3. No row is silently mutated post-publish. Re-publish creates new
   rows; old rows remain.

These guarantees are sufficient for an Outcome Graph layer to be
built later as a read-only join, with no migration on the Builder
side.

### Team Mode

Team Mode is the future world where a senior coach publishes their
**system** (a curated set of templates, prompts, guidelines) and a
junior coach drafts under it. The Builder admits Team Mode without
schema rework:

- `BuilderPromptTemplate` already supports `is_default` per kind.
  Adding a `team_id` and an "owned by team" flag is a column add.
- `CoachAsset` is `coach_id`-scoped today. Adding a "shared with
  team" join table is additive; nothing in the Builder pipeline
  assumes single-coach-per-asset.
- `ProgramDraft.coach_id` becomes `(team_id, drafting_coach_id)` —
  a column add, not a rename. Authorization checks become
  team-membership checks.
- The publish target (the client's coach) stays `client.coach_id`;
  the draft author may differ. The `AuditLog` entry on publish is
  already keyed by actor, so a junior coach publishing under a
  senior's system shows up correctly.

The Builder's contract for Team Mode readiness:

1. No table assumes one-coach-per-asset or one-coach-per-template.
   Phase 1 only writes `coach_id`, but the schema is shaped so a
   `team_id` can be added without a rename.
2. The provider abstraction is per-call, not per-coach singleton, so
   a team-shared API key (or a per-coach key) drops in cleanly.
3. The audit posture distinguishes actor from target, which is
   already true today (`docs/audit-and-gdpr.md`).

Neither feature is implemented by this RFC. They are noted to ensure
nothing in Phase 1 closes the door on them.

---

## Appendix A — File layout (proposed)

```
src/program-builder/
  program-builder.module.ts
  program-builder.controller.ts          # coach routes
  program-builder.admin.controller.ts    # OWNER routes (or under src/admin/)
  program-builder.service.ts
  program-builder.dto.ts
  program-builder.types.ts
  asset-ingestion.service.ts
  draft-orchestrator.service.ts
  publish.service.ts
  guardrails.service.ts                  # thin re-export of src/common/guardrails
  llm/
    builder-llm.interface.ts
    anthropic-builder-llm.ts
    openai-builder-llm.ts                # parity check; not wired in prod
    deterministic-builder-llm.ts
  jobs/
    asset.processor.ts
    embed.processor.ts
    draft.processor.ts
  README.md
test/
  program-builder/
    fixtures/
      coaches/...
      clients/...
    program-builder.controller.spec.ts
    asset-ingestion.service.spec.ts
    draft-orchestrator.service.spec.ts
    publish.service.spec.ts
    guardrails.service.spec.ts
prisma/migrations/
  YYYYMMDD_program_builder_phase1/...
  YYYYMMDD_program_builder_phase2/...
docs/
  program-builder.md                     # operator guide (PR-8)
  rfcs/
    ai-program-builder.md                # this RFC
```

## Appendix B — Glossary

- **Asset** — any coach-owned input (PDF, doc, audio, video, etc.)
  that the Builder can ingest.
- **Chunk** — a ~800-token slice of an asset's extracted text;
  retrieval unit.
- **Draft** — a request to produce a program, in any state from
  `queued` through `published` or `rejected`.
- **Section** — one of `workout_routine`, `meal_plan`, `lesson_set`,
  `guideline`, `check_in_cadence`. A draft has one row per section
  it is producing.
- **Template** — a versioned prompt body keyed by section kind.
- **Publication** — the durable record of a publish event; carries
  the ids of every row written.
- **Outcome Graph** — future read-only layer joining published
  interventions to observed outcomes.
- **Team Mode** — future feature letting a senior coach's system
  back a junior coach's drafts.

## Appendix C — Out-of-scope lists (so future readers do not relitigate)

- This RFC does not cover **video frame analysis** (form-check style
  ML on uploaded video). Audio transcription only.
- This RFC does not cover **client-facing AI editing** (the client
  cannot influence the Builder; only the coach can).
- This RFC does not cover **mobile authoring**. The console is the
  authoring surface.
- This RFC does not cover **a marketplace of coach systems** or any
  cross-coach asset sharing in Phase 1.
- This RFC does not cover **continuous adaptation** of a published
  program — that is an Outcome-Graph follow-on.
- This RFC does not cover **the new-website surface** at all. The
  Builder is a backend + coach console feature.
