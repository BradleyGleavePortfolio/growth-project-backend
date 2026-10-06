# S-AVAIL-122 — backend coach booking options (agent 122)

Started 16:50 PDT 2026-10-05 (time box 75 min, ends 18:05). Builder Opus.

## State
- PR: growth-project-backend#735 (base main 6aff479c, which contains 95b0a05d and the scheduling train b#712-#720).
- Head: 32d8120712cc106eb87a4a3457661dc2cf427a1e (one commit, Conventional Commits title).
- Size: 915 changed lines (872 + / 43 -), under 1,500. No banned casts (diff grep for the r75 tokens: none).
- Branch: agent122/s-avail-booking-options. Worktree: /home/user/workspace/wt/S-AVAIL-122-1.
- CI lane: ci/S-AVAIL-122-1 run 37392131534 GREEN (tsc --noEmit + 9 scheduling specs); lane branch deleted.
- PR CI at head: all checks green except build-and-test, whose only failures are 3 tests in test/coachless/coach-code-redemption.spec.ts,
  identical on main 6aff479c (run 37390793076). Flagged in ops/lanes122/notify/main-red-coach-code-redemption.txt.
- Comment: FIX ROUND 1 (OPENING) + READY FOR AUDIT
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/735#issuecomment-6006284912
- Endpoint contract for the mobile builder: /home/user/workspace/ops/lanes122/notify/avail.txt.

## What shipped
- Migration 20270318122000_coach_booking_options (+ down.sql): CoachProfile booking_min_notice_minutes INT NOT NULL DEFAULT 5,
  booking_window_days INT NOT NULL DEFAULT 120, booking_buffer_before_min / booking_buffer_after_min INT NOT NULL DEFAULT 0,
  booking_daily_max INT NULL. schema.prisma matches.
- GET/PATCH /scheduling/coach/booking-options (coach-only, own data). Service src/scheduling/scheduling-booking-options.service.ts.
- Enforcement in the advisory-locked booking transaction (requestSession, client rescheduleSession) via
  SchedulingOpenSlotsService.intervalBookability (verdict + options read in one pass under the lock).
- Open slots honour notice/window/buffers/daily max; payload echoes min_notice_minutes and booking_window_days.
- slot-computer: optional bufferBeforeMinutes / bufferAfterMinutes / dailyMax inputs (omitted = old behaviour), intervalBookability(),
  localDayKey().
- Tests: test/scheduling-booking-options.spec.ts (15 cases, pass locally via heavy.sh); scheduling-lifecycle-integrity.spec.ts
  104/104 locally. Fake DB gained coachProfile.update and booking fields on coachProfile.findUnique.

## Decisions taken (operator may flip; recommended default = what shipped)
1. Per coach only (one set for all appointment types). Per-type overrides deferred: recommended default keep per coach for launch.
2. Buffers are additive (before + after between two sessions) and only separate sessions from sessions (may fall outside open hours).
3. Daily maximum counts occupying sessions (requested, scheduled, pending_provider) by start time on the coach-local day.
4. Coach moves: 5-minute floor, up to max(120, coach window) days, not bound by buffers or the cap.
5. Minimum notice floor stays 5 minutes (0 not allowed) so a slot cannot be shown that the server refuses on arrival.
6. Error codes reused (SESSION_IN_PAST, BEYOND_BOOKING_HORIZON, SLOT_UNAVAILABLE) so the mobile app needs no new code mapping;
   one new code INVALID_BOOKING_OPTIONS for the editor.

## Log
- 16:50 start; 16:57 contract fixed and written to notify/avail.txt; 17:04 PR #735 opened, CI lane 37392131534 pushed.
- 17:08 lane green; 17:16 PR CI done (main-inherited coach-code-redemption failure only); 17:18 comment posted.

## HANDOFF
- Done: PR #735 @ 32d8120712cc106eb87a4a3457661dc2cf427a1e, READY FOR AUDIT (comment 6006284912). Next: lens pair (T4: both Opus and
  Sol at the exact head). Fix rounds go on branch agent122/s-avail-booking-options (recreate a worktree from it; the S-AVAIL-122-1
  worktree is removed).
- build-and-test will turn green once main's coach-code-redemption failure is fixed and #735 picks up main (or branch protection
  treats it as main-inherited; operator call).
- Mobile builder reads ops/lanes122/notify/avail.txt for the contract.
- Cleanup done: ci/S-AVAIL-122-1 deleted; worktree removed.
