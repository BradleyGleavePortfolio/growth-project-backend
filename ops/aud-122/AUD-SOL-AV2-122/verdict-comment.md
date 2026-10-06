AUDIT GPT-6.1 Sol — growth-project-mobile#381 @ feab0c3b74479d2c3b644e91f301a76d92222c0e — VERDICT: REQUEST CHANGES

A/B/C = 0/1/1

AUD-SOL-AV2-122, agent 122 — independent first review.

## B findings

**B-381-1 — A valid minimum notice can permanently block client booking and moves.**

**Files:** `src/screens/coach/CoachBookingOptionsScreen.tsx:28-33,95-120`; `src/hooks/useCalendar.ts:95-118`; `src/screens/client/calendar/CalendarBookScreen.tsx:135-136,280-298`.

**Normal-user story:** A coach saves 21 days' minimum notice for sessions planned ahead, then their client opens Book or Move and cannot select any time even though the coach has open hours after those 21 days. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))

**Concrete counterexample:** Keep the standard 120-day window, zero buffers and no daily cap, choose Days, enter 21 and save: the editor accepts 30,240 minutes, below its 43,200-minute maximum and below the booking window; the client picker always asks for `[now, now + 14 days]`, has no forward-range control, and the backend correctly removes every returned slot before `now + 21 days`, leaving the client with only Refresh, Message and See Calendar. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))

**Minimal fix rule:** Make a bookable client range reachable for every valid saved notice: use the returned minimum-notice policy to choose the first range, or add forward-range navigation, while keeping each open-slots request within the backend's 14-day range limit and the coach's booking window.

**Verify:** Add a regression with 21-day notice, a 120-day window and ordinary recurring availability: a client must be able to select and book a time after day 21, and the Move picker must reach the same range.

## A / C

A: none.

C-381-1 (non-blocking copy follow-up): client policy refusals still use generic later-time/refresh copy instead of the backend's notice/window-specific sentences (`src/calendar/schedulingErrors.ts:31-34,116-117`); the editor's named-field 400 sentences do display. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))

## Checks / evidence

- The five API fields, PATCH endpoint, null daily-cap removal, defaults, ranges and notice-shorter-than-window validation match backend #735; Settings hides the entry on 404/403, and the changed horizon message no longer promises four months. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381), [backend PR #735](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735))
- Size: 641 additions + 1 deletion = 642 changed lines, below 1,500. ([Mobile PR #381](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381))
- Existing PR CI is green: Lint, Typecheck and Test succeeded in run 37394781589. ([CI job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37394781589/job/112048036429))
- B-381-1 is a static cross-contract counterexample, not an executed failing test; no local suites, CI-lane push, production access or other lens evidence was used.
