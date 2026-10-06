**Tier:** T3
**Why:** Customer-visible coach AI approval flow: what the coach reviews and approves is what the client receives. No auth, tenancy, PII, money or credential change.
**T4 trigger scan:** auth no; RLS/tenancy no; PII no (no new data read or sent); money no; credentials no; destructive data no. AI consent gate unchanged (backend still requires the client's grant to generate).
**T3 trigger scan:** yes, AI draft review and approve on the coach side (customer-visible behaviour).
**Bounded T1:** n/a
**Canonical builder:** AUDIT-08-125 (agent 125 worker, Claude Opus)
**Acceptance evidence:** new `src/__tests__/aiMealPlanDraftReview125.test.tsx` (fails on main: slot/serving/totals/notes render empty and Save/Approve post to `/coach/ai/drafts/undefined/...`); PR CI full suite + tsc + lint.

Works against the current production backend: no API change; it reads the fields `GET /coach/ai/drafts/:id` already returns and writes through the existing `POST /coach/ai/drafts/:id/edit` merge.

## Fixes
- **B — AI approve and edits never land.** A coach generates an AI meal plan (or workout), taps Approve & assign, and gets "Approve failed" every time, because `GET /coach/ai/drafts/:id` returns the stored row (`id`), not `draftId`, so Save, Approve and Reject posted to `/coach/ai/drafts/undefined/...`. Both draft screens now use the route `draftId` (the id the generate call or the pending list already handed over). Workout screen: only these three lines.
- **B — AI notes reach the client unseen.** A coach approves an AI meal plan after reviewing the meals, and the client then sees AI-written notes (swaps, prep advice) the review screen never showed, because the approve step copies `coach_notes` into the client's plan notes. The review now shows them as "Notes <client> sees" and the coach can edit them.
- **U — review fields blank, edits thrown away.** Every meal "Time" and item "Portion" box was empty and day totals were missing, and what the coach typed there was dropped at approval: mobile read `time_of_day` / `portion` / `total_calories` while the backend sends `slot` / `serving` / `daily_totals` (backend `src/ai/prompts/meal-plan.prompt.ts`). The screen now reads and writes the backend fields (old names kept as read fallbacks). Day totals now follow item macro edits, so the client's per-day totals match the items. The "Meal name" and "Day notes" inputs were removed: nothing stored or showed them to the client.

Overlap: none with open PRs (m#404 touches ClientDetailScreen/SummaryTab, not these files). AUDIT-14-125 owns the rest of the AI workout draft screen; this PR only changes its three draftId lines.
