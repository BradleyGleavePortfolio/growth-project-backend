# SCOPE MISMATCH — Wave 1.5 "server-side kind filtering for community search"

**Status:** HALTED per the binding SCOPE MISMATCH PROTOCOL. No product
behavior was invented. This branch contains only this document.

**Task as briefed:** Mirror an existing "γ pattern" from the community
*feed* handler into the community *search* handler so that, after search
hits are retrieved, the handler evaluates the caller's per-user feature
flags server-side and drops any hit whose `kind` maps to a disabled flag.
Briefed as closing issue #255 line 16 (`[ ] Server-side filter on
caller's enabled flags`), with prerequisites said to be already shipped
in "PR #414".

**Finding:** Every prerequisite the brief depends on is absent from this
repository. The work cannot be done as a "mirror an existing pattern"
task because there is no pattern to mirror, no mapping to reuse, and no
per-user flag evaluator to call. Proceeding would require inventing new
product behavior (a per-user flag-evaluation mechanism, a kind→flag
mapping, and a new evaluator service), which the protocol forbids.

---

## What the brief assumed vs. what is actually in the repo

| Brief assumption | Actual state in repo (verified) |
|---|---|
| Issue #255 tracks the community-search "treadmill"; line 16 is the open item | **Issue #255 is a CLOSED Dependabot PR**: *"chore(deps): bump @typescript-eslint/eslint-plugin from 6.21.0 to 8.59.4"*. It has no relation to community search, feature flags, or a γ pattern, and has no "line 16" item. (`gh issue view 255`) |
| `/me/feature-flags` endpoint shipped in PR #414, merged this session | **No PR #414 exists.** The latest commit on `main` is `fea925a … (#402)`. No `/me/feature-flags` route, no `feature-flags` controller, no `@Roles('student','coach','owner')` flag-evaluation handler anywhere. (`git log`, repo-wide grep) |
| A `FeatureFlagsEvaluationDTO` with `evaluated_at` (ISO) + `flags` object exists | **No such DTO.** No `FeatureFlagsEvaluation`, no `evaluated_at`, no per-user `flags` map type anywhere in `src/`. |
| The community **feed** handler already implements the γ (kind→flag intersection) pattern | **The only `/community/feed` handler is the legacy v0 anonymized-wins feed** (`CommunityController.getFeed` → `CommunityService.getFeed`). It returns `{ id, displayName, action, createdAt }` rows — no `kind` field, no feature-flag intersection, no per-hit filtering. There is no other "feed" handler. No file in the repo contains a γ / per-kind flag-intersection pattern (searched `γ`, `gamma`, `intersect`, `kind→flag`, etc.). |
| A feature-flag → community-kind mapping exists (`classroom_lesson` → `communityClassroom`, etc.) | **No such mapping exists.** No `communityClassroom` identifier anywhere; no `KIND_FLAG` / `kindToFlag` / `flagForKind` map; no structure relating `CommunitySearchKind` values to any flag name. |
| Feature flags are evaluated per-caller and intersected against result kinds | **Feature flags here are global env-var slice guards**, not per-user per-kind evaluations. `resolveCommunityFlag(callerId)` (`src/community/community-feature-flag.guard.ts`) returns a single `'enabled' \| 'disabled'` for the **entire** community API, derived from `FEATURE_COMMUNITY_API` (global boolean) OR membership in `FEATURE_COMMUNITY_API_ALLOWLIST`. Each slice (search, voice, classroom, events…) has its own `*-flag.guard.ts` that likewise reads a global `FEATURE_*` env boolean and returns **503** at the route level when off. None of them evaluate flags per result `kind`. |

---

## How community search & flags actually work today

- **Search read path:** `GET /community/workspaces/:workspaceId/search`
  → `CommunitySearchController.query`
  → `CommunitySearchService.search`
  → `CommunitySearchRepository.search`.
  Hits are typed `SearchResultRow { id, kind, targetId, cohortId,
  authorId, excerpt, createdAt }` where `kind ∈ CommunitySearchKind =
  { post, classroom_lesson, voice_note_transcript, event }`
  (`prisma/schema.prisma`). Visibility (workspace membership, cohort
  membership, role allowlist, soft-delete) is already enforced
  **DB-side in the repository**, never post-filtered in the service.

- **Flag gating:** done at the **route/guard** layer, globally per
  feature slice, returning 503 when the slice is off. There is no
  notion of "this caller has `classroom_lesson` enabled but `event`
  disabled" — flags are not per-kind and not per-user (beyond the
  coarse global allowlist).

So the briefed change ("after retrieving hits, intersect each hit's
`kind` against the caller's per-user flag evaluation and drop disabled
kinds") has **no foundation to build on**: there is no per-user,
per-kind flag model in the product, and nothing to mirror.

---

## Why this hit the HALT protocol (all four triggers fired)

The protocol says HALT if any of these are true. All four are:

1. **The feed handler's γ pattern doesn't exist** — confirmed, no γ /
   kind-intersection pattern anywhere; the only "feed" is the legacy
   anonymized-wins feed with no `kind`.
2. **The kind→flag mapping doesn't exist** — confirmed, no mapping
   structure and no `communityClassroom`-style flag names exist.
3. **The search handler architecture differs fundamentally** — flags
   are global route-level guards (503), not per-user per-kind result
   intersections; search visibility is enforced DB-side, not via a
   post-retrieval flag filter.
4. **Adding the filter requires inventing new product behavior** — it
   would require a brand-new per-user flag-evaluation mechanism, a new
   kind→flag mapping, and a new evaluator service / `/me/feature-flags`
   endpoint. The protocol explicitly forbids inventing these.

---

## Decision needed from the user

Pick the intended direction; this PR stays a **draft** until then. No
code beyond this document has been written.

1. **Verify the issue/PR references.** Issue #255 is a closed
   Dependabot PR. Which real issue (and which line) tracks the
   "server-side filter on caller's enabled flags" item? Was the
   `/me/feature-flags` work (briefed as "PR #414") actually merged
   somewhere — a different repo, a different PR number, or still
   unmerged? If it's unmerged, this search work is genuinely blocked
   on it and should be sequenced after it.

2. **Define the missing product primitives, if this feature is real.**
   Before a "mirror the pattern" task is possible, the user (not an
   autonomous agent) needs to decide and land:
   - the **per-user feature-flag evaluation** mechanism / endpoint
     (the briefed `/me/feature-flags` + `FeatureFlagsEvaluationDTO`);
   - the **kind→flag mapping** (e.g. which of `post`,
     `classroom_lesson`, `voice_note_transcript`, `event` is gated by
     which flag, and what those flag names are);
   - confirmation that pass-through-for-unmapped-kinds is the desired
     default (the brief says yes, but it depends on the mapping above).
   Per ENGINEERING_RULES §5 (DTO/schema hygiene) and AGENT_RULES (no
   invention; ask for clarity at every new feature), these are product
   decisions, not agent guesses.

3. **Confirm the actual goal.** If the real concern is "search must
   not leak titles/snippets of content the caller can't see," note
   that membership/cohort/role/soft-delete visibility is **already**
   enforced DB-side in `CommunitySearchRepository`. If a *new* gating
   axis (per-kind feature flags) is genuinely wanted, it's a new
   feature spanning the flag model + mapping + endpoint + search +
   feed — a multi-PR effort, not a Wave 1.5 mirror.

Once (1)–(3) are resolved, the search-side change itself is small and
can be implemented quickly against the real primitives.

---

## Evidence index (for the reviewer)

- `gh issue view 255 --repo BradleyGleavePortfolio/growth-project-backend`
  → title *"chore(deps): bump @typescript-eslint/eslint-plugin …"*, state `CLOSED`.
- `git log --oneline` → top commit `fea925a … (#402)`; no `#414`.
- Repo-wide grep for `feature-flags`, `FeatureFlagsEvaluation`,
  `evaluated_at`, `communityClassroom`, `classroom_lesson` mapping,
  `kindToFlag` / `KIND_FLAG` / `flagForKind`, `γ` / `gamma`,
  `intersect` → no per-user flag evaluator, no kind→flag map, no γ
  pattern.
- `src/community/community.controller.ts` → `getFeed` is the legacy
  anonymized-wins feed (no `kind`, no flag intersection).
- `src/community/community-feature-flag.guard.ts` →
  `resolveCommunityFlag()` is a global on/off check, not per-kind.
- `src/community/search/community-search.service.ts` /
  `community-search.dto.ts` → current search shape & DB-side
  visibility enforcement.
- `prisma/schema.prisma` → `enum CommunitySearchKind { post,
  classroom_lesson, voice_note_transcript, event }`.
