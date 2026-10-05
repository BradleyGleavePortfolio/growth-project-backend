# AUD-OPUS-SCH1-122 notes (Claude Opus 5.5 lens, agent 122)

Started 16:33 PDT 10-05. Worktree /home/user/workspace/wt/AUD-OPUS-SCH1-122-367 (detached at 6418e759, read only).
Heads: m#365 cceeb33a71982d44da40e75714332f59844e45fc, m#366 fa7744cc237418a90239279541450ce2a8dc5959,
m#367 6418e759813065dc353720533dfd5c9b5a51ceb3. Opened 2026-10-03 21:34Z (before the 1,500 rule), sizes 2,025 / 1,680 / 2,294,
grandfathered under 3,000. Backend reference: growth-project-backend origin/main 5cde6253.

## Contract checks (mobile vs backend main, which is production deploy 4)
- Routes: every schedulingApi path exists in scheduling.controller.ts (my-coaches, session-types, availability, sessions, approve,
  decline, reschedule, cancel, complete, no-show, manual-video-link, open-slots, coach/availability-overrides).
- DTOs: RequestSessionDto (coach_id, session_type_id, title, start_at, end_at) matches; notes/client_timezone stripped before POST.
  ApproveSessionDto/CancelSessionDto accept expected_start_at. CreateSessionTypeDto accepts is_welcome, default_meeting_url,
  default_video_provider 'manual' (service allows stub/manual).
- Status filter: backend LISTABLE_STATUSES accepts requested, scheduled, pending_provider (coach inbox/agenda).
- Error codes: schedulingError() puts code in both code and error; http-exception.filter forwards code. Mobile maps all but
  REQUEST_EXPIRED (falls to the 409 generic copy, accurate enough: C).
- Push: booking.emitter BOOKING_PUSH_SCREEN client CalendarSession, coach CoachBookingInbox with sessionId; mobile push router has
  both routes.
- Open slots for the coach's own id: assertCanBrowseCoach allows coach self; coachTimezone defaults when profile tz missing.

## Finding
- B-367-1: backend view returns status 'expired' (scheduling-session.view.ts:98; S-SCHED-5 from #653, in production). The client
  Upcoming list has no status filter (listSessionsForActor upcoming = end_at > now, all statuses), so an expired request stays in
  Upcoming until its time passes. Mobile SchedulingSessionStatus (schedulingApi.ts:50-57) has no 'expired', and statusLabel
  (calendarUi.tsx:11-29) falls to default "Status unavailable. Refresh Calendar or message your coach." Shown on
  CalendarHomeScreen.tsx:157 and CalendarSessionScreen.tsx:171. The "Session request closed" push opens CalendarSession too.
  Story: a client requests a time that needs approval, the coach does not answer within 48 hours, and Calendar plus the
  "Session request closed" push show "Status unavailable. Refresh Calendar or message your coach." instead of saying the request
  closed and the client should pick another time.

## Cs
- C-366-1 tutorialSteps.ts:363 "Pick a time that suits you and it is set." is not true when the welcome type needs approval (new
  types default to approval); the next screen says "Requested, waiting for your coach".
- C-367-2 CalendarBookScreen.tsx:66 "Booked. <coach> will see it in Calendar." The coach sees it under Booking inbox > Upcoming
  sessions, not a Calendar screen.
- C-365-1 REQUEST_EXPIRED has no mapped copy (generic 409 copy shows).
- C (edge, deferred to 10k clients): a lapsed request not yet swept still has DB status requested and is filtered out of the coach
  inbox by the client-side status guard.

## Operator items
- Coach booking options (minimum notice, booking window, buffers, daily maximum; owner A6.2) exist in neither backend main nor
  this stack. Not a B on this train (outside the diff). Decision needed on where they land.
- Land K1-K3 as one (A5 rule 11): K1 turns EXPO_PUBLIC_FF_CLIENT_CALENDAR on in the production and clinic EAS profiles, K2 adds
  tutorial steps targeting tab:CalendarTab, and only K3 registers CalendarTab. No EAS build between the merges.
- CI: Typecheck, lint, test green at all three heads (CodeQL green on K1), run 10-03 on base 367e6c48; main is now 2c88eae.
