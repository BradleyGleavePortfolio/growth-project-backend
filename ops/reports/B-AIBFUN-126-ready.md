FIX ROUND 1 (OPENING) (B-AIBFUN-126, agent 126) — growth-project-mobile#450 @ f67962d054475a4e6ffb379331a749fb45ef80fa — READY FOR AUDIT

- Base: main (m#439 AIB-5 merged 19:00 as 1f9b919a; origin/main merged in at 19:01, clean).
- Size: 279 changed lines (259 + 20), 5 files, tests included; no lockfile, generated or snapshot files.
- CI: "Typecheck, lint, test" SUCCESS at this head (run 37559989593); CodeQL SUCCESS.
- Local: NEW `src/components/coach/ai-builder/__tests__/aiFunLayer.test.tsx` 7/7 (fails on main: module absent); `aiBuilder.test.tsx` 12/12; `src/__tests__/coachWorkoutBuilderUndo.test.tsx` 19/19 (apply now also asserts the header momentum line). Targeted tsc on the screen and tests, and eslint on the changed files, clean.
- R75: no new `as any` / `as unknown as` / `as never`, no empty `.catch(() => undefined)`. No new flags, dependencies, migrations or server calls. Against the current production backend Ask AI status is 404, so the entry, the momentum line and the win card all stay hidden there, as before.
- Overlap: m#443 (AIB-6) also edits CoachWorkoutBuilderScreen.tsx (History button + import). This PR's hunks there (momentum line after the header row, header Undo `onPress`, toast swap, one counter line in aiOnApplied) do not touch m#443's lines; `git merge-tree` with agent126/b-aib6-126 @ 82d8b252 is clean.

Fixes (each a plan "The fun layer" U):
- U1: a coach reviewing AI suggestions saw the cards fade in flat, and an Apply ended with a plain line of text. Now each card springs in on a 60 ms stagger, in step with the light haptic tick. Apply ends in a win card (check icon, "Applied N changes.", "AI-suggested, coach-approved", Undo) that screen readers announce.
- U2: the builder header gave a coach no running count for the session. It now shows a momentum line, for example "6 exercises, 18 sets. 5 changes applied with Ask AI this session.", and the line pulses once each time an apply lands.
- U3: the header Undo was the only Ask AI action with no haptic. It now gives a medium haptic, matching the toast Undo (plan: "Undo = medium").

Rules held: with Reduce Motion on there are no springs, no stagger and no pulse, the win card cross-fades, and haptics stay. Colour is never the only signal, and every state is also in text. The only new control, Undo, has the label "Undo the AI change". The copy has no first person, no emojis and no exclamation marks. The AI entry is never hidden.
