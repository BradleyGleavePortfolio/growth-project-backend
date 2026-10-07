# B-AIBFUN-126 — Ask AI fun layer (mobile, T3)

Started 18:33 PDT 10-06 (times from `TZ=America/Los_Angeles date`). Builder: Claude Opus 5.5, agent 126 worker. Hard stop 19:45.
Branch agent126/b-aibfun-126 from origin/agent126/b-aib5-126 @ 030e5721 (m#439 open at 18:41); merged its 63076852 (B-439-1) at 19:00
(conflicts in aiBuilder.test.tsx: took m#439's folded RM test; screen aiOnApplied: m#439's adopt + my counter). m#439 merged 19:00
(1f9b919a); merged origin/main at 19:01; PR opened against main.
Worktree /home/user/workspace/wt/B-AIBFUN-126-mobile.

## Scope traced (screens + routes)
- CoachWorkoutBuilderScreen (AIB-5 hunk: header Ask AI button, prompt bar, aiOnApplied, toast, header Undo/Redo row).
- AiBuilderSheet (ChangeCard motion, keep toggles, Apply/Discard), useAiBuilder (haptics: propose medium, toggle selection/warning,
  card ticks light x5, apply success, discard warning, error error), aiBuilderCopy.
- m#443 (AIB-6) diff on CoachWorkoutBuilderScreen (History button + import) read to keep hunks apart. No server routes added or changed.

## Built
1. ChangeCard: Animated.spring reveal (damping 18, translateY 16 + scale 0.96, opacity clamped), 60 ms stagger; keep-off springs to 0.55
   dim (text "Not applied." unchanged); Apply button spring pop when the kept count changes. Reduce Motion: no springs, no stagger.
2. NEW AiFunLayer.tsx: AiWinToast (coach win moment: spring up + check icon pop, "Applied N changes." + "AI-suggested, coach-approved",
   announceForAccessibility, Undo with medium haptic; Reduce Motion cross-fade) and AiMomentumLine (header: "6 exercises, 18 sets. 5
   changes applied with Ask AI this session."; spring pulse on each apply, none under Reduce Motion).
3. Screen: toast -> AiWinToast (same testIDs), momentum line under the header row (only where Ask AI shows), aiApplied counter in
   aiOnApplied, header Undo medium haptic.
4. Tests: NEW aiFunLayer.test.tsx (7) pass; aiBuilder.test.tsx 12/12 (unchanged); coachWorkoutBuilderUndo.test.tsx 19/19 (+ momentum
   line assertion). Targeted tsc (screen + tests) and eslint clean locally.

## B list
None.

## U list (fixed in this PR)
- U1: a coach reviewing AI suggestions sees cards fade in flatly and an Apply ends in a plain text line; now spring reveal + win card.
- U2: a coach has no running sense of the session in the builder header; now the momentum line.
- U3: the header Undo gave no haptic while every other Ask AI action did; now medium.

## C one-liners
- C: useAiBuilder card-tick timeouts are not cleared on unmount (harmless no-op haptics). C (edge, deferred to 10k clients).
- C: Android may announce the win card twice (live region + announce). C (edge, deferred to 10k clients).
- C: m#443 WeekAiSheet cards still use timing, not the spring (its file); reuse AI_SPRING after m#443 merges.

## Covered by open PRs
- m#439 (AIB-5): haptics on propose/apply/discard/toggle/error/card ticks already there; kept unchanged.
- m#443 (AIB-6): History, week actions, AI draft haptics.

## PRs opened
- m#450 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/450 base main, head f67962d0 (279 lines: 259 + 20, 5 files,
  tests included). CI "Typecheck, lint, test" SUCCESS (run 37559989593), CodeQL SUCCESS. READY FOR AUDIT posted 19:11
  (issuecomment-6029414955). merge-tree with m#443 (82d8b252) clean.

## Not fixed (needs operator)
- None.

## HANDOFF
- State 19:11: m#450 READY FOR AUDIT at f67962d054475a4e6ffb379331a749fb45ef80fa, base main, CI green. Waiting for lenses (T3: Opus + Sol).
- Worktree /home/user/workspace/wt/B-AIBFUN-126-mobile removed after push (nothing unsaved). No ci/* branches created.
- To continue: `git -C /home/user/workspace/growth-project-mobile worktree add /home/user/workspace/wt/B-AIBFUN-126-mobile origin/agent126/b-aibfun-126`
  (local branch agent126/b-aibfun-126 still exists), merge origin/main (never rebase/force-push), run aiFunLayer.test.tsx via heavy.sh, push, comment.
- If m#443 merges first: merge origin/main; the screen hunks are apart from its History button (merge-tree clean at 82d8b252).
- Follow-up (not built): m#443 WeekAiSheet cards could reuse AI_SPRING / AI_STAGGER_MS; builder list "strike through then collapse"
  and LinearTransition morph after apply; sheet spring (damping 18) instead of Modal slide.
