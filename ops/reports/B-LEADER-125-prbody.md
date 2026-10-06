**Tier:** T3 (privacy-adjacent UI: makes an existing opt-in, coach-roster-scoped leaderboard reachable)
**Why:** Owner 15:06 10-06: "Leaderboard: seems like a simple addition to flip on if it has great usability and good mobile screen path placement - should be near/inside the community space?" The backend board is already live (LEADERBOARD_ENABLED unset = on); the mobile screens were registered on the More stack but nothing opened them.
**T4 trigger scan:** none. No auth, RLS/tenancy, money, credentials, PII fields or destructive data changes. No backend change. Reads the existing GET /me/leaderboard and POST /me/leaderboard/opt-in only.
**T3 trigger scan:** shows other clients' display names and 0-100 scores, but only peers who opted in, only within the viewer's own coach roster (server-scoped by coach_id, b#747 already enforces opt-in). Default stays OFF (show_on_leaderboard @default(false)).
**Bounded T1:** navigation registration, one header link, Back/Settings controls, a coachless state, copy and screen-reader labels.
**Canonical builder:** B-LEADER-125 (agent 125, Claude Opus 5.5).
**Acceptance evidence:** new src/screens/community/__tests__/communityLeaderboardEntry.test.tsx (4 tests, fail on main: no entry link / no Community-stack route / no coachless state). Local targeted runs green: communityLeaderboardEntry (4/4), LeaderboardScreen source guards (16/16), quietLuxuryDoctrine (10/10), communityScreens (16/16), communityFlagOff (9/9). Full suite and tsc in this PR's CI.

**Decision note (owner/operator):** SoT A7 lists LEADERBOARD_ENABLED under "Stay OFF for launch" and OR-113-13 (agent 113) kept the leaderboard with no entry for the clinic launch. Owner's 15:06 message asks to flip it on; this PR is that entry point. Merge only if the owner confirms. Backend needs no change. Works against current production backend (ec12a4b3): routes are unchanged since deploy 9.

## What a client sees (clinic build, Community tab ON)
- Community tab header row: "Leaderboard" (left, only when the client has a coach) and "Community safety" (right, unchanged).
- Leaderboard opens on the Community stack, so Back returns to the Community tab. Top bar: Back and Settings (opens LeaderboardSettings on the same stack).
- Not opted in: opt-in card (default OFF). Opted in: ranked list of opted-in peers of the same coach.
- Returning from Settings refreshes the board (opt-out removes the own row at once).
- Coachless client: no entry link; if reached, a calm explanation, never an error, no API call.

## Fixes (U)
- U1: Nothing opened the leaderboard. A client with a coach could never find the leaderboard. Entry point added in the Community tab.
- U2: Leaderboard and Leaderboard settings had no Back control and drew their title under the status bar (both host stacks hide the native header). A client who opens them sees the title under the clock and no Back button. Back + safe-area top inset added.
- U3: Coachless client saw "Opt in to your coach's leaderboard"; opting in reloaded the same card forever (server returns an empty board with no coach). A client without a coach loops on an opt-in that does nothing. Coachless state added; entry point hidden.
- U4: No way to opt out from the leaderboard once opted in (Settings was unreachable). A client who opted in could not leave. Settings link added; board refreshes on return.
- U5: Settings explainer said "four habit signals" and listed five, and said meals count against "a 3-per-day target" while the server counts each food entry (90 in 30 days). A client reads a score description that does not match how the score is built. Copy corrected.
- U6: Screen reader read each row as five loose fragments ("1", "Sarah C.", "Score bar...", "80", "+4"). VoiceOver users cannot follow the ranking. One label per row: "Rank 1, Sarah C., score 80 of 100, up 4 since the last update" (own row says "you").

Doctrine test: CommunityTabScreen.tsx, communityNavTypes.ts and the new test are added to the existing ALLOWLIST_LEADERBOARD_REFERENCE (same list that already allows the leaderboard and challenge screens), because they now name the route.

Overlap: none with open PRs. m#416 (accessibility) does not touch these files.
