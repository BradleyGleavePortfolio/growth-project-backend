FIX ROUND 1 (OPENING) (B-AIB5P-126, agent 126) — growth-project-mobile#439 @ 63417260fae82291539cadc3dcdf88b8c0b81bf1 — READY FOR AUDIT

Job B-AIB5P-126 (Claude Opus 5.5, T3 mobile): Ask AI paused state, never hidden. One commit on top of c138b4c4; main 950689af unchanged, so no merge needed.

Visibility (owner rule: never hidden):
- status `paused` and `not_configured` -> header button and prompt bar visible; the sheet shows "Ask AI is paused for maintenance. Your workouts are unchanged." with no prompt or chips, so nothing is proposed.
- `no_credits` -> the credits copy with the reset date (no purchase wording).
- status unreadable (network or 5xx) -> entry visible; the sheet shows the specific line (for example "No connection. ...") and Try again, which re-reads the status ("Checking" while in flight).
- ONLY a 404 from the status route (backend without AIB-4) hides the entry.

Fixed (U):
- U1: a coach opening the builder while the server switch is off (`not_configured`) read "Ask AI is not set up on this account yet.", which is false; now the paused copy.
- U2: a coach whose status read failed saw the prompt as if Ask AI were on, with no way to re-check; now a retry state.
- Propose sends no `lock_token` until the builder holds a real head token (none, empty or bootstrap are left out).

Specs: aiBuilder.test.tsx (paused/not_configured -> paused copy, no prompt/chips/propose; network -> Try again -> prompt; wire body has no lock_token), coachWorkoutBuilderUndo.test.tsx (paused/not_configured visible, tap shows paused copy, no propose; network keeps the entry with a retry; 404 hides).

Size: 792 changed lines (9 files). CI at this head: Typecheck, lint, test success (640 suites, 8621 tests), CodeQL success.
