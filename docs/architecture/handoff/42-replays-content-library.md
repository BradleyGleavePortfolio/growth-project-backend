# Handoff: #42 Replays and Content Library

> Operator brief. Engineer-facing long form is
> [`docs/specs/replays-content-library.md`](../../specs/replays-content-library.md).

## WHY

A coach's back catalog (live-call replays, audio drops,
PDFs, video lessons) is the dominant retention mechanic
on every creator-shaped business that scaled past $10M
ARR — Skool, Whop, Patreon, Circle. Without it, every
renewal is paid for fresh and every churn is a clean
break. The library is also the substrate the AI Program
Builder, AI Business Copilot, weekly recap, and at-risk
detector all read; one library = one source of truth.

## WHEN

Cannot start runtime PR-1 until: PR #117 §8 has confirmed
the Storage prefix shape; PR #120 lane #04 has recorded the
per-tier retention windows; PR #117 §6 has confirmed the
embedding shape (the library reuses the chunk + embed
pipeline for transcript search); transcript provider chosen
(Whisper / Deepgram / OpenAI) and recorded; search default
decided (keyword first, semantic added later behind a flag).

## WHERE

New module `src/content-library/` peer to `src/community/`,
`src/events/`. Five new tables: `ContentLibraryEntry`,
`ContentLibraryProgress`, `ContentLibraryTranscript`,
`ContentLibraryChunk`, `ContentLibrarySavedItem`. New env-var
family `CONTENT_LIBRARY_*`. No `new-website` change. Existing
`Lesson` rows are imported lazily (read-on-write); no
destructive migration.

## WHO

Founder owns: per-tier retention windows, whether semantic
search is bundled or up-tiered, whether transcripts default
on for live-call recordings. Backend lead owns: search shape
(keyword vs semantic), transcript-provider pluggability (spec
defaults: pluggable from day one). Mobile owns: playback
shape, progress-write cadence (spec defaults: 30s + on-pause
+ on-finish). Coach console owns: bulk import + chapter
editing UI. OWNER on the pager for first 30 days; transcript
provider failures are best-effort and never block playback.

## WHAT

Already exists: `Lesson`, `LessonCompletion`, `User`,
`CoachProfile`, `SubscriptionGuard`, `AuditLog`, the
Supabase Storage prefix + mime allow-list, the chunk + embed
pattern (PR #117 §6), `ListItem` / saved-items pattern.

Net-new: 5 tables, provider-pluggable transcript pipeline,
server-side keyword search (Postgres `tsvector` GIN +
generated column), pgvector semantic search behind a flag,
per-(member, entry) progress ledger, recording-ready bridge
from `events-live-calls.md`.

Non-goals: member-uploaded content, automated chapter gen
without transcripts, live-streaming, multi-language transcripts,
DRM/watermarking, public RSS export, paywall preview.

## HOW

8-PR rollout (spec §7.1). PR-1 is schema + empty `[]`
behind `CONTENT_LIBRARY_ENABLED=false`. Recording bridge
lands PR-4, transcript pipeline PR-5, retention cron PR-6.

Smallest first PR ships: schema, module mounted, empty `[]`,
smoke assertion, OpenAPI export update. Zero provider code,
zero Storage write.

## Risks (top 3)

1. Storage cost runaway. Mitigation: per-tier storage cap
   with OWNER alerts; per-tier retention cron hard-deletes
   past the window (with 7-day-before warning to coach).
2. Transcript provider downtime. Best-effort; never blocks
   playback. Deterministic fallback returns "transcript not
   available."
3. Signed-URL leak. Mitigation: ≤ 1-hour TTL signed URL minted
   on read, never logged, never a public URL.

## Acceptance criteria (one-line)

Coach uploads 30-min video → appears in library within 60s
→ transcribe runs (≤ 5min for 30-min audio) → member views
→ progress writes → weekly recap reflects consumption →
live-call recording auto-arrives via events spec PR-5
webhook → revert = flag flip.

## Operator handoff

- **Kill-switch:** `fly secrets set CONTENT_LIBRARY_ENABLED=false
  -a tgp-backend-prod`.
- **Dashboards:** entries-per-coach, consumption rate,
  storage utilization, search volume.
- **Runbook entry:** `docs/operations/content-library.md`
  (future doc).
- **First 30 days:** OWNER reads
  `library_consumption_rate_p50` weekly; bottom-decile coach
  is the on-call signal for "your library is dormant"
  intervention via the AI Business Copilot.

## Cross-references

- Engineer spec: [`docs/specs/replays-content-library.md`](../../specs/replays-content-library.md)
- Adjacent specs: [`events-live-calls.md`](../../specs/events-live-calls.md),
  [`community-spaces.md`](../../specs/community-spaces.md),
  [`ai-business-copilot.md`](../../specs/ai-business-copilot.md)
- Related drafts: PR #117 (Storage prefix + embedding pipeline),
  #118 (forward-compat), #120 (lanes #01, #04, #05, #06, #08),
  #121 (#22, #23, #28), #123 (#33 content-boards is a v0
  superseded by this surface).
