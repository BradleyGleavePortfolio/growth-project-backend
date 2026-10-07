**Tier:** T3 (mobile UI motion, haptics and copy in the coach-only Ask AI builder; no money, auth, tenancy, PII or data logic changes; no new server calls).
**Why:** Owner 15:40 10-06: "smooth transitions with haptic feedback layered in. I want the FUN part of being a trainer to be fun in-app." Plan AI_MASTER_BUILDER_PLAN.md PART 1 "The fun layer": the parts AIB-5 (m#439) and AIB-6 (m#443) did not build.
**T4 trigger scan:** none. No auth/RLS/tenancy, money, credentials, destructive data, migrations, dependencies, lockfile edits or feature flags. Apply, Discard and Undo still call exactly the AIB-5 routes; this PR only changes how the result looks and feels.
**T3 trigger scan:** new coach UI component file (AiFunLayer.tsx: win moment + momentum line), ChangeCard motion in AiBuilderSheet.tsx (AIB-5 file), three small hunks in CoachWorkoutBuilderScreen.tsx (toast swap, header line, header Undo haptic).
**Bounded T1:** copy per plan PART 1 voice (numbers first; no first person, emojis or exclamation marks).
**Canonical builder:** Claude Opus 5.5 (B-AIBFUN-126, agent 126).
**Acceptance evidence:** NEW `src/components/coach/ai-builder/__tests__/aiFunLayer.test.tsx` (7 tests; fail on main: module absent) passes locally; `aiBuilder.test.tsx` 12/12 (unchanged); `src/__tests__/coachWorkoutBuilderUndo.test.tsx` 19/19 (apply now also asserts the header momentum line). Targeted tsc on the changed files and eslint on the changed files clean locally; full suite + tsc in this PR's CI.

Base main (m#439 AIB-5 merged 19:00 as 1f9b919a). Builds on the AIB-5 files; works against the current production backend unchanged (status 404 still hides Ask AI, so the momentum line and win card never show there).

## What it adds
- **Staged reveal with spring motion:** every change card springs in (damping 18, translate + scale, opacity clamped) on a 60 ms stagger, in step with the existing light haptic tick per card (capped at 5). Turning a card off springs it to a dimmed state; the "Not applied." line still says it in text. The Apply button gives a small spring pop when a keep toggle changes its count.
- **Coach win moment after Apply:** the applied toast becomes a win card that springs up with a check icon, "Applied N changes." and "AI-suggested, coach-approved", is announced to VoiceOver/TalkBack (`announceForAccessibility`), and keeps the 10 s Undo (44 pt target). Success haptic on Apply is unchanged (AIB-5).
- **Momentum line in the builder header:** "6 exercises, 18 sets. 5 changes applied with Ask AI this session." Live from the screen's rows; the applied count grows with each Ask AI apply and the line pulses once (spring). Shown only where the Ask AI entry shows.
- **Haptic intents on propose / apply / undo:** propose = medium, apply = success, toast Undo = medium (all AIB-5, kept); NEW: the header Undo button is a medium haptic too (plan: "Undo = medium").
- **Rules:** Reduce Motion = no springs, no stagger, no pulse; the win card cross-fades; haptics stay. Colour is never the only signal (kind badges carry text, kept/off carries text, the win card carries text). Every new control has a screen-reader label (the only new button is Undo, label "Undo the AI change"). The AI entry is never hidden by this PR.

## B/U fixed
- U (plan "The fun layer"): a coach reviewing AI suggestions sees cards fade in flatly with no spring, and nothing marks the moment an Apply lands beyond a plain line of text; now the cards spring in on a stagger and Apply ends in a clear win card that is also announced to screen readers.
- U (plan "The fun layer"): a coach building a workout has no running sense of what the session has done; the header now shows the exercise and set count and how many Ask AI changes were applied.
- U (plan "Undo = medium"): the header Undo button gave no haptic while every other Ask AI action did; it now gives a medium haptic.

## Overlap with open PRs
- m#443 (AIB-6) also edits `src/screens/coach/CoachWorkoutBuilderScreen.tsx` (History button in the Undo/Redo row + import). This PR's hunks there are the header momentum line (after the header row), the Undo button `onPress` (one line, before the Redo button) and the toast swap; none touch m#443's lines. `git merge-tree` of this branch with `agent126/b-aib6-126` and with `main` is clean. No other m#443 file is touched.
- m#443's WeekAiSheet has its own card list; it does not get the spring reveal here (its file). Follow-up: reuse `AI_SPRING` / `AI_STAGGER_MS` from AiFunLayer.tsx there once m#443 merges.
