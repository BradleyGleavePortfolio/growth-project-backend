# FU-BOOK-126 — coach booking leftovers (Claude Opus 5.5, T3 mobile)

Start 18:03 PDT 10-06 (fresh start; the earlier stopped copy left no worktree, branch or report). Hard stop 19:25.
Bases: mobile main 950689af (RO-mobile), backend main f71bb9a4 (RO-backend = production). Worktree
/home/user/workspace/wt/FU-BOOK-126-mobile, branch agent126/fu-book-126 from origin/main 950689af.
Source findings: /home/user/workspace/ops/reports/AUDIT-04-125.md U-04-2, U-04-3, U-04-4. All three re-checked on current main: still hold.

## Scope traced
- Client: CalendarBookScreen (open times, fallback, reschedule mode) -> useOpenSlots (14-day range) -> GET
  /scheduling/coaches/:id/open-slots (SchedulingOpenSlotsService.getOpenSlots: validateRange caps 14 days; payload already echoes
  min_notice_minutes + booking_window_days; withinBookingWindow filters).
- Coach: Settings -> Booking Options copy ("Open times are offered up to this many days from today"); Booking Inbox
  (CoachBookingInboxScreen: requests, agenda) -> GET /scheduling/sessions (scope upcoming|past, status filter, keyset paging);
  POST /scheduling/sessions/:id/complete (CompleteSessionDto: reason, coach_notes_md) and /no-show (CancelSessionDto: reason,
  expected_start_at) -> SchedulingSessionLifecycleService completeSession/markNoShow (assertIsSessionCoach, scheduled -> completed |
  no_show only, assertHasStarted, compare-and-set, audit). Hooks useCompleteSession / useMarkNoShow existed with no UI.
- Client view of the result: calendarUi statusLabel completed -> "Completed", no_show -> "Missed".

## B list
None.

## U list (all fixed in the mobile PR)
- U-04-2: a coach sets "How far ahead clients can book" to 120 days, but a client booking a session only ever sees the next 14 days
  and has no way to see later times. Fix: Show later times / Show earlier times step 14 days at a time up to booking_window_days from
  the production open-slots reply; range note "Showing open times from <day> to <day>."; the empty fallback also offers later times;
  first-page copy uses the coach's window when shorter than 14 days. Older backend without the field: first page only (unchanged).
  The coach-side copy is now true, so CoachBookingOptionsScreen is unchanged.
- U-04-3: a coach who finished a session yesterday has no way to mark it done or missed, so the client's Calendar says "Confirmed"
  forever. Fix: "Past sessions" section in the Booking Inbox (scope=past, status=scheduled, paged, refreshes every 30 s) with
  Mark complete and Mark missed (missed asks first; sends expected_start_at); result line names what the client sees; coach copy for
  SESSION_STATE_CHANGED / SESSION_NOT_ACTIVE on these two actions; loading, empty and error states.
- U-04-4: a coach opens the Booking Inbox and reads "10/7/2026, 9:00:00 AM – 9:30:00 AM". Fix: formatSessionSpan ->
  "Wed, Oct 7 · 9:00–9:30 AM" (built from Intl parts) for requests, agenda and past rows. Also: Confirm / Decline now show a success
  line, and the line is error-coloured only for errors.

## C one-liners
- Complete / missed for a session in progress (started, not ended) is not offered until its end time. C (edge, deferred to 10k clients)
- Coach recap text (client_recap_md) still has no editor. C (post-launch feature)

## Covered by open PRs
- None. Open mobile PRs checked 18:05 (m#439 AIB-5, m#302 importer, dependabot, m#264/m#265 custom exercise): none touch booking.

## PRs opened
- mobile #445 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/445 — head 559999b2c7d7d8737f9e45171ab3eda4f9ac842e,
  +423 / -25 (9 files, tests included), T3. Pushed 18:20. CI GREEN at 559999b2 (Typecheck, lint, test incl. full suite; CodeQL).
  READY comment posted 18:27: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/445#issuecomment-6028898270
  Local jest (heavy.sh, one file each): coachSchedulingFixRound 16/16, calendarScreens 49/49 (incl. 4 new U-04-2 cases),
  conciergePhase1 4/4, calendarTime 6/6, coachSchedulingSettings 12/12.

## Not fixed (needs operator)
- None so far.

## HANDOFF
DONE 18:28. m#445 READY FOR AUDIT at 559999b2c7d7d8737f9e45171ab3eda4f9ac842e, CI green. Worktree removed (all work pushed; local HEAD
= origin/agent126/fu-book-126). No ci/* lane branches were created. Next: LF lens pair (LF-OPUS-126 / LF-SOL-126) on m#445 at that head;
operator merges on dual APPROVE. If a lens asks for a fix: recreate the worktree from origin/agent126/fu-book-126 (never rebase), fix,
push, post FIX ROUND 2 comment.
Files: PR body ops/reports/FU-BOOK-126-pr-body.md, READY text ops/reports/FU-BOOK-126-ready-comment.md, jest logs
ops/reports/FU-BOOK-126-jest-*.log, runner ops/reports/FU-BOOK-126-runjest.sh.
