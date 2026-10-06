# AUD-SOL-AV2-122 — coach booking options mobile

AUDIT GPT-6.1 Sol — growth-project-mobile#381 @ feab0c3b74479d2c3b644e91f301a76d92222c0e — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

## State

- Review: independent Sol first review, agent 122; started 2026-10-05 17:42 PDT, 25-minute limit.
- Target head: `feab0c3b74479d2c3b644e91f301a76d92222c0e`; base `main` at `a9bd9470f5d5b9c2ec955156d8886679594379ba`; 642 changed lines in nine files. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))
- Backend reference: #735 at `082d4653aa88ab1e4b05817a3a305fc138805026`; the relevant booking-options/controller/DTO/open-slots/lifecycle/types files are byte-identical to opening head `32d8120712cc106eb87a4a3457661dc2cf427a1e`. ([Backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))
- CI reused: run 37394781589, completed successfully; Lint, Typecheck and Test steps succeeded. ([CI job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394781589/job/112048036429))
- Verdict posted 2026-10-05 17:46:30 PDT after re-reading the live head, which remained `feab0c3b74479d2c3b644e91f301a76d92222c0e`; REQUEST CHANGES, A/B/C = 0/1/1. ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6006810212))

## B findings

### B-381-1 — Valid notice can permanently dead-end client bookings and moves

**Normal-user story:** A coach saves 21 days' minimum notice for sessions planned ahead, then their client opens Book or Move and cannot select any time even though the coach has open hours after those 21 days. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

**Changed-line entry point:** `src/screens/coach/CoachBookingOptionsScreen.tsx:28-33,95-120` accepts `noticeValue = "21"`, `noticeUnit = "days"` with the default 120-day window, producing `min_notice_minutes = 30240`; the new API field permits up to 43200 minutes. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

**Cross-contract failure:** `src/hooks/useCalendar.ts:95-118` always requests only 14 days from the supplied start, and `src/screens/client/calendar/CalendarBookScreen.tsx:135-136` fixes that start at now with no setter or forward-range control; the empty state at lines 280-298 offers only Refresh, Message and See Calendar. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

**Backend confirmation:** `src/scheduling/scheduling-open-slots.service.ts:210-227,375-382` returns the policy and filters out all starts before now plus the minimum notice, so a 21-day notice removes every slot in this client's 14-day request even with ordinary recurring availability and no bookings. ([Backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))

**Why B, not an edge:** This requires one ordinary saved value exposed by the new editor and one later client visit, not unusual inputs, simultaneous actions, boundary timing or an older app.

**Minimal fix:** Use the returned minimum notice to choose a reachable first client range, or provide forward-range navigation; retain at-most-14-day requests and the coach's booking-window ceiling.

**Verification requested:** A regression must show a client can select and book after day 21 with 21-day notice, a 120-day window and ordinary recurring hours, and that Move can reach the same range.

**Evidence type:** Deterministic static walkthrough; no executed failing test claimed.

## A / C

A: none.

C-381-1 (non-blocking copy follow-up): client policy refusals still use generic later-time/refresh copy instead of the backend's notice/window-specific sentences (`src/calendar/schedulingErrors.ts:31-34,116-117`); the editor's named-field 400 sentences do display. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))

## Reviewed contracts and boundaries

- Read all nine changed files and the relevant backend contract without reading the Opus lens's notes, report or comments.
- GET/PATCH `/scheduling/coach/booking-options`, all five field names, defaults, ranges, full-set save and null daily-cap removal align with the backend; local validation also matches notice-shorter-than-window. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))
- The Settings row hides on 404/403 with no retry for those statuses, navigation registers the editor, and the server's field-prefixed 400 message is displayed under that field. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))
- The changed client horizon copy removes the incorrect fixed four-month promise. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))
- No runtime probe was launched: the task forbids pushes, and the common brief forbids local npm/jest/tsc/eslint/builds.

## Local evidence

- Full PR diff: `/home/user/workspace/ops/aud-122/AUD-SOL-AV2-122/pr381.diff`.
- Posted verdict payload: `/home/user/workspace/ops/aud-122/AUD-SOL-AV2-122/verdict-comment.md`.
- Final authenticated PR metadata: `/home/user/workspace/ops/aud-122/AUD-SOL-AV2-122/pr381-prepost.json`.
- Returned comment URL: `/home/user/workspace/ops/aud-122/AUD-SOL-AV2-122/posted-comment-url.txt`.
- Read-only worktree retained for workspace preservation: `/home/user/workspace/wt/AUD-SOL-AV2-122-1`; detached at the target head, no edits.
- Claim released by preserving its file at `/home/user/workspace/ops/aud-122/AUD-SOL-AV2-122/released-claim-mobile-381-feab0c3b-sol`; no active claim remains.

## Next action

Recommend one targeted builder fix for B-381-1, then independent re-review of that finding and changed lines; defer C-381-1.

## HANDOFF

- Completed: m#381 at `feab0c3b74479d2c3b644e91f301a76d92222c0e`, REQUEST CHANGES, A/B/C = 0/1/1; one blocker, valid 21-day notice makes client Book/Move permanently empty because only the next 14 days are requested. ([Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6006810212))
- Existing Typecheck, lint, test check is green; no independent runtime probe was launched. ([CI job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394781589/job/112048036429))
- Next operator action: assign only B-381-1 to the mobile builder; preserve backend field limits and 14-day request caps while making a later permitted range reachable.
- No pushes, merges, production access, new branches or CI runs; read-only worktree and all evidence files retained, no lock taken.
