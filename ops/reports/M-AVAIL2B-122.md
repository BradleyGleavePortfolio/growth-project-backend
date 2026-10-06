# M-AVAIL2B-122 — m#381 fix round B-381-1 (agent 122, relaunch of M-AVAIL2-122)

Started 18:09 PDT 2026-10-05. Time box 20 min.

- START comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6007219345
- PR: growth-project-mobile#381, branch agent122/avail-booking-options. Old head feab0c3b74479d2c3b644e91f301a76d92222c0e.
- New head: eab75ececc60380b216e39111d744635cb1b0e06 (one commit, Bradley Gleave, pushed 18:21).

## Review of the 2 uncommitted files left by the 17:55 cancel
Both kept as-is (correct):
- `src/screens/coach/CoachBookingOptionsScreen.tsx`: `NOTICE_UNDER_MINUTES = OPEN_SLOTS_RANGE_DAYS (14, useCalendar) * 1440`;
  `validateBookingDraft` refuses notice >= 14 days with "Minimum notice must be under 14 days so clients can see open times."
  (range sentence becomes "at least 5 minutes and under 14 days" when the server max is >= 14 days); `editNotice` clamps the
  number input and the unit switch to the largest value under 14 days (13 days / 335 hours / 20159 minutes) and shows the sentence;
  helper text under the label says "Keep it under 14 days so clients can see open times." Copy: impersonal, no exclamation marks.
- `src/screens/coach/__tests__/coachBookingOptions.test.tsx`: UI test (21 days -> 13, 400 hours -> 335, switch to days -> 13, save
  sends 18720) and rule test (14d, 21d, 336h, 20160m refused; 13d, 335h, 20159m accepted); existing range test updated.

## Verification
- Local (heavy.sh, single file): coachBookingOptions.test.tsx 10/10 pass with the fix; on feab0c3b's screen 3 fail (both B-381-1
  tests + the updated range test) -> test fails on feab0c3b as required.
- eslint on the 2 files: clean.
- Size: 721 changed lines (under 1,500).
- PATCH/PUT note: PR body already says GET/PATCH; no PR text says PUT (only Opus's audit says "the route is PATCH, not PUT"). Nothing to fix.
- PR body: minimum notice line updated to "at least 5 minutes and under 14 days" + size line.
- Mobile CI lane: run 37398723907 (ci/M-AVAIL2B-122) SUCCESS; lane branch deleted.
- PR CI at eab75ece: "Typecheck, lint, test" run 37398727748 FAILURE, 2 tests in src/navigation/__tests__/coachSettingsMoneyRow.test.tsx
  (main's m#345 test renders Settings without a QueryClient; #381's BookingOptionsEntry -> useBookingOptions throws "No QueryClient set").
  Not caused by the B-381-1 commit. 7836 other tests pass; CodeQL green.

## Status
STATUS STOPPED at operator WRAP UP (18:23). Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/381#issuecomment-6007436723
Not READY FOR AUDIT: PR CI is red because of the main test above.

## HANDOFF
Head eab75ececc60380b216e39111d744635cb1b0e06 is pushed and complete (fix + tests; lane green). Remaining (one test-only push, needs
operator OK for a second push this round; recommended default: allow): in src/navigation/__tests__/coachSettingsMoneyRow.test.tsx add the
same jest.mock of '../../screens/coach/settings/BookingOptionsEntry' that #381 already has in imessageDmRoutes.test.tsx. Push it, wait for
PR CI green (poll with `gh pr view 381 --json statusCheckRollup` / `gh api .../actions/runs/<id>/jobs`, not gh run view / gh pr checks),
then post "FIX ROUND 2 (<job>, agent 12x) — growth-project-mobile#381 @ <sha>" ending READY FOR AUDIT. Worktree
/home/user/workspace/wt/M-AVAIL2-122 is clean (branch m-avail2-122 = eab75ece) and can be reused or removed.
