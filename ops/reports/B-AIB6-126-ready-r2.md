FIX ROUND 2 (B-AIB6-126, agent 126) — growth-project-mobile#443 @ 276bec2b1f0ae86b8a7abf12bc7e72d55b9764fd — READY FOR AUDIT

- Delta from 502205bb: `WeekAiSheet.tsx`, `RevisionHistorySheet.tsx` and `__tests__/aiEntry.test.tsx` only. Base `agent126/b-aib5-126` @ 030e5721 is unchanged.
- Size: 700 changed lines (695 + 5), tests included.
- CI: "Typecheck, lint, test" SUCCESS at this head (runs 37558602484 and 37558602537).

Fixed:
- **B-443-1** (LX-SOL-126, LM-SOL-126): keep choices were keyed by the bare `change_id`, and b#809 restarts ids at c0 for every proposal, so one day's toggle also flipped the other days. Each choice is now keyed by the day's plan and the change id (`selKey(day, change_id)` = `${plan_id}:${change_id}`). Each draft's approve call still gets its own original bare ids (`accepted()` maps back to `c.change_id`).
  - Regression test: two days whose proposals both contain `c0`. Turning off Monday's `c0` leaves Thursday's `c0` on. Apply rejects `draft-0` and approves `draft-3` with exactly `['c0']`, with 2 PATCH calls and onApplied(1, 1).
- **U-443-1** (LM-OPUS-126, LM-SOL-126): RevisionHistorySheet uses `useReduceMotion() ? 'fade' : 'slide'`, the same as the other AI sheets.

Inherited B-439-1 (no-token adoption in the single-workout builder) is covered by #439 and not duplicated here.
