**Tier:** T3 (mobile UI; coach-only AI entry points; no money, auth, tenancy or PII logic changes; every server call is an existing or b#808/b#809 route that re-checks tenancy and consent server-side).
**Why:** Owner 15:40 10-06: the AI master workout builder ships ON and visible in the 10-07 build. AIB-6 adds the entry points outside the single-workout builder (plan AI_MASTER_BUILDER_PLAN.md PART 1 "Exact screens and taps", sections 3 and 6).
**T4 trigger scan:** none. No auth/RLS/tenancy code, no money, no credentials, no destructive data path, no migrations, no new dependencies, no lockfile edits, no feature flags. Apply goes through the existing `PATCH /ai/gateway/drafts/:id` (coach decision, server re-validates); nothing reaches a client without the coach tapping Apply/Approve.
**T3 trigger scan:** new coach UI (week sheet, history sheet, client Workouts entry), one hunk in CoachWorkoutBuilderScreen (History button, outside the AIB-5 hunk), CoachAiSection/SummaryTab/ClientDetailScreen prop pass-through, AIWorkoutDraftScreen haptics.
**Bounded T1:** copy only per plan PART 1 (no first person, emojis, exclamation marks or generic errors).
**Canonical builder:** Claude Opus 5.5 (B-AIB6-126, agent 126).
**Acceptance evidence:** `src/components/coach/ai-entry/__tests__/aiEntry.test.tsx` (7 tests, fail on main: modules absent) passes locally; `programsScreens.test.tsx` passes locally with the editor change; full suite + tsc in this PR's CI.

Stacked on m#439 (AIB-5, base `agent126/b-aib5-126`) so the diff shows only AIB-6. Retargets to main when m#439 merges. Imports from `src/components/coach/ai-builder/*` and `src/api/aiBuilderApi.ts` only; never edits them.

## What it adds
- **Program editor, per week:** "Ask AI" on every week that has workout days -> "Progress this week with AI" or "Make this a deload week". One propose per filled day (max 7) in day order under one shared staged reveal ("Day 2 of 4: Wed: Pull"), cards grouped by day with keep toggles, "Apply N changes" applies each day's kept change ids (a day with none kept is discarded), partial failures say which days were not changed. Paused / not configured / no credits show the specific copy and ask nothing. Out of credits, consent, rate limit, network stop the run with their copy; a per-day 422/409 shows on that day only.
- **Workout builder, header History:** RevisionHistorySheet from b#808 `GET /workout-plans/:planId/revisions`: newest first, author chip ("AI-suggested, coach-approved" / "Coach" / "Team coach"), time, one-line server summary. Read-only; header Undo steps back. Shown with Ask AI (b#808 ships status + revisions together); a 404 reads "History is not available for this workout yet".
- **Client page, Workouts tab:** "Build a program for <first name> with AI" opens the existing per-client generator (Coach AI section -> AIWorkoutDraft review) once AI is ready.
- **AI workout draft screen:** success haptic on approve, warning on reject, error on failure ("N workouts assigned" from `assigned_count` already landed in AUDIT-14-125 and is unchanged).
- Haptics via `fireAiHaptic` (AIB-5); Reduce Motion: no stagger, fade only.

## B/U fixed
- U (plan AIB-6): a coach who wants to progress or deload a whole program week has to open and ask every day by hand; now one tap per week, reviewed card by card.
- U (plan AIB-6): a coach cannot see who changed a workout or that an AI change was coach-approved; History now lists every saved version with its author.
- U (plan AIB-6): on a client's Workouts tab there is no way to start an AI program for that client; the entry now opens the existing generator.

## Not in this PR (needs backend; see report)
- "New workout with AI" in the Programs library: a standalone plan from `POST /workout-plans` has no revision baseline (`head_revision_id` null), so b#809 propose answers 409 and autosave answers 409. Needs the backend to seed revision 0 on create first.
- "Adjust <client>'s current workouts": needs a coach-side per-client assignment list route and `client_id` threaded through `useAiBuilder` (AIB-5 file).
