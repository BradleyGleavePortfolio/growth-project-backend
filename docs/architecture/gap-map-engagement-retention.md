# Gap map: engagement & retention wave (rows #40–#44)

> "Do we have this already?" — answered per row, mapped to the
> closest existing artefact (draft PR #117 / #118 / #119 /
> #120 / #121 / #122 / #123 or a merged module). Companion to
> [`expansion-wave-engagement-retention.md`](./expansion-wave-engagement-retention.md).

This document answers, for each row in the wave, the question
a reviewer will ask: **do we already have this somewhere, or
is this all net-new?** It is the quickest way to triage the
wave without reading five long specs.

The format mirrors [`gap-map-coach-experience.md`](./gap-map-coach-experience.md)
from PR #123.

---

## Short answer table

| Row | Already? | Closest existing artefact | What's new |
|---|---|---|---|
| #40 community spaces | **No** | merged `CommunityWin` (per-client wins, not a member-only feed); merged `CoachMessage` (1:1 messaging); PR #117 (Storage prefix the new media uses) | 6 tables; member-only feed; one optional attachment per post; per-coach moderator + abuse-report + toxicity classifier (best-effort, deterministic fallback) |
| #41 events + live calls | **No** | merged `@nestjs/schedule` (cron infra); PR #117 (Storage prefix for recordings); PR #122 mastermind cohort surface (IRL lifecycle — different shape) | 5 tables; provider abstraction (LiveKit/Daily/100ms); reminder cron with idempotent rows; attendance ledger; recording-ready webhook bridge to #42 |
| #42 replays + content library | **Partial** | merged `Lesson` + `LessonCompletion` (curriculum); PR #117 (Storage prefix + chunk + embed pipeline); PR #123 #33 content-boards (v0 of distribution surface) | 5 tables; provider-pluggable transcript pipeline; keyword + semantic search; per-(member, entry) progress ledger; recording handoff from #41; lazy import of existing `Lesson` rows |
| #43 rewards + bounties | **No** | merged `Invoice` + `PaymentFailure` + `StripeProcessedEvent` (Stripe ledger reused); merged `AuditLog`; PR #123 #30 challenges (natural redemption trigger) | 4 tables; coach-credit-only currency in v1; Stripe `customer_balance` adjustment service (idempotent); OWNER review queue; sweepstakes-posture ToS update |
| #44 AI Business Copilot | **No** (the closest is the AI Program Builder RFC, but it solves a different problem — programs for clients, not operator-side copilot for coaches) | PR #117 (provider abstraction, prompt-template table, eval CI, per-coach budget); merged `src/ai/` GP assistant (typed context pattern + post-response guardrails); PR #121 #22/#23/#24 (at-risk detector + weekly recap + coach voice — required inputs) | 4 tables; eight closed-vocabulary use cases; typed `CoachAIContext` bundle (operator-side analogue of `ClientAIContext`); 200-fixture eval suite; four guardrails (PII, voice, fact-check, cross-tenant); per-coach monthly cost ledger |

---

## #40 community spaces — full detail

### What we already have

- **`CommunityWin`** (`prisma/schema.prisma` line 711): a per-
  client win surface. The new `CommunityPost` is a strict
  superset of the same idea but member-visible across the
  coach's roster. We do not delete `CommunityWin` — the two
  coexist.
- **`CoachMessage`** (`src/messaging/`): 1:1 coach-client
  messaging. Different shape from a feed, but the
  Supabase Realtime ping pattern is reused directly.
- **`SubscriptionGuard`** + **`ClientCoachConsent`** (auth /
  billing): the entitlement gate on every read/write.
- **`AuditLog`** (`src/audit/`): every moderation action writes
  a row; `AuditAction` constants are extended additively.
- **PR #117 §8** Supabase Storage prefix + mime allow-list:
  the post's optional attachment piggybacks on
  `coach/{coach_id}/community/post/{post_id}/...`.

### What is net-new

- 6 tables: `CommunitySpace`, `CommunityPost`,
  `CommunityComment`, `CommunityReaction`, `CommunityReport`,
  `CommunityRole`.
- The community-feed composer (`community-feed.service.ts`)
  is a pure read-fan-in function over
  `(coach_id, viewer_user_id, cursor)`.
- The moderation service: toxicity classifier wrapper (best-
  effort, provider-pluggable, deterministic fallback returns
  `null`); abuse-report intake; soft-hide / unhide; tombstone-
  on-delete; audit-log emit.
- Per-coach moderator role placeholder (writes only `banned`
  rows in v1; PR #118 Team Mode wires the full role).

### Why a separate spec, not an extension of `CommunityWin`

`CommunityWin` is per-client; it is a one-row write that the
coach approves into a "wins of the week" surface. The new
community is many-to-many across the coach's roster, with
moderation, reactions, comments, attachments, reports, and a
single space per coach. The data shape and the read-fan-in
both differ enough that a parallel set of tables is cleaner
than a discriminator column + a unified shape.

### Lane crosswalk (PR #120)

| Lane | How #40 uses it |
|---|---|
| #01 flags & entitlements | `COMMUNITY_SPACES_ENABLED` global; tier-bundle gate via the entitlement bundle |
| #03 security/RBAC | service-layer `canReadSpace` predicate |
| #04 data lifecycle | per-table retention matrix; tombstone vs hard-delete posture |
| #05 billing packaging | tier mapping decision |
| #06 observability | DAU per coach, open reports, storage usage tiles |
| #08 AI governance | toxicity classifier + AI-drafted post composer (the latter via #44 Copilot) |
| #10 analytics | 6 PostHog events; OWNER metrics counter additions |

---

## #41 events + live calls — full detail

### What we already have

- **`@nestjs/schedule`** (cron infra): the reminder cron lives
  here; idempotent rows via `EventReminder` unique constraint.
- **`SubscriptionGuard`**, **`AuditLog`**, the throttler.
- **`StripeProcessedEvent`** (idempotency table pattern): the
  provider webhook reuses the dedupe pattern via a new
  `ProviderProcessedEvent` row in PR-5.
- **PR #117 §8** Storage prefix: recordings land at
  `coach/{coach_id}/event/{event_id}/recording.{ext}`.
- **PR #122 mastermind operating model**: the IRL event
  lifecycle (T-90 / T-30 / event days / T+30 / T+90) is a
  cousin shape; this spec carries the **virtual + hybrid**
  lifecycle only.

### What is net-new

- 5 tables: `Event`, `EventRSVP`, `EventAttendance`,
  `EventRecording`, `EventReminder`.
- Provider abstraction (`events-provider.service.ts`):
  pluggable from day one across LiveKit / Daily / 100ms;
  deterministic fallback returns `provider_unavailable`.
- Reminder cron with idempotent
  `(event_id, fires_at, channel)` unique.
- Attendance ledger (joined_at / left_at / duration).
- Recording-ready webhook handler with HMAC verification.
- Optional `.ics` mint (PR-8).

### Why a separate spec, not an extension of `CoachMessage`

Live calls are synchronous, scheduled, and have a media plane
(provided by a third-party WebRTC SDK); messages are
asynchronous, persistent, and text. The lifecycle is
fundamentally different (RSVP → reminder → join token →
recording → finalize). Sharing a schema with messaging would
be a category error.

### Lane crosswalk (PR #120)

| Lane | How #41 uses it |
|---|---|
| #01 flags | `LIVE_CALLS_ENABLED` global; per-tier minutes cap |
| #02 API versioning | provider webhook is `/api/events/:id/recording` (additive) |
| #03 security/RBAC | join-token issuance is one-shot, ≤5min TTL |
| #05 billing packaging | per-tier minutes cap (cost story) |
| #06 observability | attendance rate, recording storage, minutes utilization |
| #11 release QA | provider-rotation regression gate |

---

## #42 replays + content library — full detail

### What we already have

- **`Lesson`** + **`LessonCompletion`** (`prisma/schema.prisma`
  lines 554, 572): the existing per-coach curriculum surface.
  v1 imports existing `Lesson` rows lazily as
  `ContentLibraryEntry` rows (read-on-write). Lessons remain
  the program-builder publish target (PR #117); the library
  is the read surface.
- **PR #117 §8** Storage prefix + mime allow-list.
- **PR #117 §6** chunk + embed pipeline: the library reuses
  the same chunking strategy for transcript chunks via a
  parallel `ContentLibraryChunk` table (the access patterns
  diverge from `CoachAssetChunk` — library searches across
  the **published** content, not the **source** assets).
- **PR #123 #33 content-boards**: a v0 of the distribution
  surface (PDF + newsletter + video link board). The library
  supersedes it: every content-boards row migrates to a
  `ContentLibraryEntry` row in a future runtime PR.
- **`ListItem`** pattern: the saved-items table reuses the
  shape.

### What is net-new

- 5 tables: `ContentLibraryEntry`, `ContentLibraryProgress`,
  `ContentLibraryTranscript`, `ContentLibraryChunk`,
  `ContentLibrarySavedItem`.
- Provider-pluggable transcript pipeline (Whisper / Deepgram
  / OpenAI Whisper-API; deterministic fallback returns
  "transcript not available").
- Keyword search (Postgres `tsvector` GIN + generated column);
  semantic search behind a flag (pgvector).
- Per-(member, entry) progress ledger.
- Recording-ready bridge: `events-live-calls.md` PR-5
  webhook writes one `ContentLibraryEntry` row with
  `source='event_recording'`.

### Why a separate spec, not an extension of `Lesson`

`Lesson` is curriculum-shaped: a structured, ordered sequence
of educational units the coach assembles per program. The
library is catalog-shaped: any kind of content (PDF, audio,
video, link, text) discoverable by search, kind, recency.
Sharing a schema would lose either the ordering invariant
or the catalog flexibility. The compromise — lazy import —
preserves both: lessons stay structured for program builds;
their durable existence in the library is the read surface
for clients who want to revisit.

### Lane crosswalk (PR #120)

| Lane | How #42 uses it |
|---|---|
| #01 flags | `CONTENT_LIBRARY_ENABLED`; `_TRANSCRIPT_PROVIDER`; `_SEMANTIC_SEARCH_ENABLED` |
| #04 data lifecycle | per-tier retention windows; account-deletion scrub |
| #05 billing packaging | per-coach storage cap per tier |
| #06 observability | entries per coach, consumption rate, storage, search volume |
| #08 AI governance | transcript provider; chapter-generation prompt versioning + evals |
| #10 analytics | 7 PostHog events |

---

## #43 rewards + bounties — full detail

### What we already have

- **`Invoice`** + **`PaymentFailure`** + **`StripeProcessedEvent`**
  + **`CoachSubscription`** (`prisma/schema.prisma` lines
  225, 246, 266, 281): the platform's existing Stripe
  ledger. `BountyPayout` writes a `customer_balance`
  adjustment via Stripe and stores the resulting
  `stripe_balance_txn_id` as the idempotency anchor.
- **`AuditLog`** + **`AuditAction`** constants: every state
  transition writes a row with `bounty_*` prefixes.
- The throttler.
- **PR #123 #30 challenges** + **#31 leaderboards**: the
  natural redemption triggers — a challenge win or a
  leaderboard placement is an evidence kind for a claim.
- The **OWNER admin convention** (`docs/admin-reports.md`):
  the review queue mounts at `/api/admin/bounties/review-queue`.

### What is net-new

- 4 tables: `Bounty`, `BountyClaim`, `BountyPayout`,
  `BountyPayoutReviewQueue`.
- Per-coach monthly cap predicate (cap is computed on
  `BountyPayout.created_at`, not the bounty — pausing does
  not buy more cap).
- Evidence-validation service: confirms the cited row exists,
  belongs to the claiming user, and was created in the
  bounty's eligibility window.
- Idempotent Stripe credit-application service.
- OWNER review queue surface for above-threshold payouts.
- ToS update + `docs/audit-and-gdpr.md` edit declaring the
  sweepstakes posture.

### Why a separate spec, not an extension of `Invoice`

A bounty is a forward-looking incentive contract; an invoice
is a backward-looking financial document. The state machine
is different (`pending` → `awarded` → `applied` → optionally
`reversed`). The cap predicate, the OWNER review threshold,
the evidence-validation service, and the legal posture (§11
sweepstakes) all live outside the invoice domain.

### Lane crosswalk (PR #120)

| Lane | How #43 uses it |
|---|---|
| #01 flags | `BOUNTIES_ENABLED`; per-coach monthly cap |
| #03 security/RBAC | tenancy on every row; coach + OWNER inboxes scoped |
| #04 data lifecycle | financial-ledger row preserved 7 years per existing finance posture |
| #05 billing packaging | per-tier monthly cap; OWNER review threshold |
| #06 observability | payouts per coach, review queue, reversal rate |
| #11 release QA | prize-payout regression gate; Stripe-replay smoke |

---

## #44 AI Business Copilot — full detail

### What we already have

- **PR #117 (AI Program Builder RFC)**: the canonical first
  user of the provider abstraction, the prompt-template table
  (`BuilderPromptTemplate`), the eval CI, the per-coach
  budget shape, and the deterministic-fallback rule. The
  Copilot **reuses** every one of these. It does **not**
  re-implement them. It does **not** modify the Program
  Builder.
- **`src/ai/`** GP assistant: the typed-context pattern,
  prompt-assembly shape, post-response guardrails (calorie
  floor, AI-tell scrub, banned substance, referral). The
  Copilot's `CoachAIContext` is the operator-side analogue
  of `ClientAIContext`; the four Copilot guardrails (PII,
  voice, fact-check, cross-tenant) follow the same
  post-response pattern.
- **PR #121 #22 (at-risk detector)**: the source of the
  `roster.at_risk[]` block in `CoachAIContext`. Copilot
  reads its outputs; it does not re-implement the detector.
- **PR #121 #23 (weekly recap)**: the source of the
  `engagement` + `recent_outputs` blocks.
- **PR #121 #24 (coach AI voice)**: the source of the
  `coach.voice` block; the voice overlay is the last prompt
  rendering step.
- **`MessageDraft`** (existing per-coach-per-client draft
  table): the Copilot's accept-target for kinds 2 / 5 / 7.
- **`AuditLog`**, the throttler, the per-coach budget pattern
  from PR #120 lane #05.

### What is net-new

- 4 tables: `CopilotThread`, `CopilotMessage`,
  `CopilotSuggestion`, `CopilotUsage`.
- The 8 closed-vocabulary use cases (each with a dedicated
  prompt template version, eval fixture set ≥ 25 each, and
  acceptance-target shape).
- The typed `CoachAIContext` bundle (TypeScript shape in
  §8.2 of the spec).
- 200-fixture eval suite, JSON-Schema-validated per kind.
- Four guardrails (PII scrub, voice scrub, fact-check,
  cross-tenant scrub).
- Per-coach monthly cost ledger (`CopilotUsage` upserted on
  every assistant turn).
- OWNER debug endpoint (`/api/admin/copilot/context`) for
  privacy + completeness review.

### Why a separate spec, not an extension of PR #117

The two surfaces solve **different problems**:

| | PR #117 AI Program Builder | #44 AI Business Copilot |
|---|---|---|
| Audience | per-client artefact (a workout plan, a meal plan) | per-coach artefact (an offer, a sales page, a community post) |
| Inputs | the coach's source assets (PDFs, audio, sheets) | the coach's roster + business state + at-risk signals |
| Outputs | a `ProgramDraft` published into `WorkoutRoutine` / `MealPlan` / `Lesson` | a `CopilotSuggestion` accepted into a `MessageDraft`, `CommunityPost` draft, `Bounty` draft, etc. |
| Lifecycle | offline async (BullMQ; minutes) | interactive chat (SSE; seconds) |
| Eval shape | per-section validators (each `ProgramDraftSection`) | per-kind JSON-Schema (8 kinds) |

They share infrastructure; they do not share schema or surface.

### Why a separate spec, not an extension of `src/ai/` GP

GP is the **client-facing** assistant: a client asks "what
should I eat?" and GP answers. The Copilot is the
**coach-facing** assistant: a coach asks "draft the
onboarding sequence" and the Copilot drafts. The audiences,
the contexts, the guardrails, and the outputs are different.

### Lane crosswalk (PR #120)

| Lane | How #44 uses it |
|---|---|
| #01 flags | `COPILOT_ENABLED`; tier-bundle gate at L2+ |
| #04 data lifecycle | retention matrix for the 4 new tables; account-deletion scrub posture |
| #05 billing packaging | per-coach monthly cost ledger; budget cap predicate |
| #06 observability | active-coaches-30d, acceptance-rate-30d per kind, cost-30d, provider-error-rate, guardrail-trigger-rate |
| **#08 AI governance** | **canonical first user — prompt-template versioning, eval CI, deterministic fallback, four guardrails** |
| #10 analytics | 9 PostHog events |

---

## What is deliberately NOT in this wave

- Cross-coach community / discovery / marketplace.
- Voice/video media plane proxied by the platform.
- Member-uploaded content into the library.
- Sweepstakes / lottery prize draws.
- Auto-award path on bounties without OWNER review threshold.
- Free-form "Copilot, anything" kind.
- Voice input on Copilot.
- Mobile-side Copilot.
- Public RSS / podcast feed export from the library.
- Branded community URLs via custom-domain DNS (covered by
  PR #123 #37 tiering, not this wave).

---

## Cross-reference summary

| Existing artefact | Used by row(s) |
|---|---|
| `CommunityWin` (merged) | #40 (parallel; not deleted) |
| `CoachMessage` + `src/messaging/` (merged) | #40 (Realtime pattern); #44 (deep-link target) |
| `Lesson` + `LessonCompletion` (merged) | #42 (lazy import) |
| `Invoice` + Stripe ledger (merged) | #43 (`customer_balance` adjustment) |
| `src/ai/` GP assistant (merged) | #44 (typed-context pattern; guardrail shape) |
| `AuditLog` (merged) | #40 / #41 / #42 / #43 / #44 (every moderation + financial state transition) |
| PR #117 Storage prefix + mime allow-list | #40 / #41 / #42 |
| PR #117 provider abstraction + eval CI + budget shape | #44 (and indirectly #40, #42 transcribe pipeline) |
| PR #117 `BuilderPromptTemplate` | #44 (`copilot.<kind>.v<n>` rows); #40 (toxicity threshold); #42 (chapter-gen prompt) |
| PR #118 `acted_by_member_user_id` forward-compat | every new table in the wave |
| PR #120 lane #08 AI governance | #44 (canonical first user); #40 / #42 (toxicity, transcript) |
| PR #121 #22 at-risk detector | #44 input; #40 / #42 indirectly via the recap |
| PR #121 #23 weekly recap | #44 input; reads #40 / #41 / #42 / #43 outputs |
| PR #121 #24 coach AI voice | #44 input |
| PR #122 mastermind operating model | #41 cousin lifecycle (IRL); #40 cohort space surface |
| PR #123 #30 challenges + #31 leaderboards | #43 redemption triggers |
| PR #123 #33 content-boards | #42 (v0 superseded) |
| PR #123 #36 messaging+progress | #44 (acceptance target); #40 (Realtime pattern) |
| `MessageDraft` (merged) | #44 (acceptance target for kinds 2 / 5 / 7) |
