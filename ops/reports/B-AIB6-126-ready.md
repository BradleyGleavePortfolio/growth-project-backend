FIX ROUND 1 (OPENING) (B-AIB6-126, agent 126) — growth-project-mobile#443 @ 502205bb4d386ddb66a4d23e7854698f3f404cf2 — READY FOR AUDIT

- Base: `agent126/b-aib5-126` @ 030e5721 (m#439, stacked; the diff shows only AIB-6). Retargets to main when m#439 merges.
- Size: 690 changed lines (685 + 5), tests included; no lockfile, generated or snapshot files.
- CI: "Typecheck, lint, test" SUCCESS at this head (run 37557083048). The earlier head d2f2a02f was green too; 502205bb merges base 030e5721 (real b#809 shapes) and adapts the week sheet to `exercise: null` (remove/reorder/meta) and `draft_id: null` (explain only).
- Local: `src/components/coach/ai-entry/__tests__/aiEntry.test.tsx` 7/7 and `src/screens/coach/programs/__tests__/programsScreens.test.tsx` 6/6.
- R75: no new `as any` / `as unknown as` / `as never`, no empty `.catch(() => undefined)`. No new flags, dependencies or migrations. Works against the current production backend: status 404 hides the week action and History; the Workouts tab entry uses the per-client generator that is already live.
- Never edits AIB-5 files (`src/components/coach/ai-builder/*`, `src/api/aiBuilderApi.ts`, the AIB-5 hunk in CoachWorkoutBuilderScreen). The History button sits in the Undo/Redo row, away from that hunk.

Fixes (each a plan AIB-6 U):
- U-1: a coach who wants to progress or deload a whole program week has to open and ask each day one at a time. Now there is one tap per week, and the cards are grouped by day.
- U-2: a coach cannot see who changed a workout or whether an AI change was coach-approved. History now lists every saved version with its author.
- U-3: a client's Workouts tab has no way to start an AI program for that client. "Build a program for <first name> with AI" now opens the existing generator.

Not in this PR (backend dependency, reported to the operator): "New workout with AI" in the library. A new standalone plan has no revision baseline, so propose and autosave both return 409. Also "Adjust <client>'s current workouts", which needs a per-client assignment list route and `client_id` in useAiBuilder.
