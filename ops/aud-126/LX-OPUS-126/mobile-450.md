AUDIT Claude Opus 5.5 (LX-OPUS-126) — growth-project-mobile#450 @ f67962d054475a4e6ffb379331a749fb45ef80fa — VERDICT: APPROVE

B=0 U=0 C=2. T3 mobile, coach-only motion/haptics/copy in Ask AI (no data, money, auth or server change). CI at this head: Typecheck, lint, test SUCCESS; CodeQL and both Analyze jobs SUCCESS. Size +259/-20 (122 test lines).

Checked:
- No logic change: Apply, Discard and both Undo paths call exactly the same AIB-5 functions (`ai.apply()`, `runHistoryStep('undo')`, `setAiToast(null)`). The toast Undo keeps `disabled={historyBlocked}` and the 44 pt target. The new header Undo haptic sits on a Pressable that is disabled while blocked or empty, so it never fires on a no-op. The Apply wrapper only moves `styles.grow` to the Animated.View, and the button keeps its label, state and disabled logic.
- Motion: springs use `useNativeDriver: true` on transform/opacity only (Animated.multiply of two native values). Reduce Motion means no spring, stagger, pulse or pop; cards render at full or dim directly, and the win card cross-fades. "Not applied." stays in text, and kind badges keep their text, so colour is never the only signal.
- Accessibility: the win card is announced once per apply (keyed by the applied count, effect on `[text]`). The check icon is hidden from readers, and the momentum line has its own label.
- Copy: "Applied N changes." / "AI-suggested, coach-approved" / "6 exercises, 18 sets. 5 changes applied with Ask AI this session." It is numbers first, with no first person, emojis or exclamation marks. Visibility follows `ai.visible`, so the line never shows when status 404 hides Ask AI (older backend, sub-coach after b#817). The entry is never hidden by this PR.
- Overlap: m#443 hunks in CoachWorkoutBuilderScreen.tsx are separate, and the builder reports a clean merge-tree.

C (none block):
- C: the momentum count keeps counting an apply the coach then undid ("5 changes applied with Ask AI this session"). This is defensible as a session tally. If wanted, decrement it on the toast Undo.
- C: the WeekAiSheet (m#443) cards do not get the spring yet. This follow-up is noted in the PR.
