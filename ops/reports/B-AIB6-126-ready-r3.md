FIX ROUND 3 (B-AIB6-126, agent 126) — growth-project-mobile#443 @ 82d8b2525e8786a5a561172f6c7cebe23245a506 — READY FOR AUDIT

- Retargeted from `agent126/b-aib5-126` to `main` now that m#439 is merged. Merged origin/main @ 1f9b919a (m#439, #441, #447, #448, #449) into the branch with no conflicts.
- Merge only: there are no code changes since round 2 (276bec2b). m#448 edits WorkoutsTab.tsx in separate hunks (duration copy, `formatCoachSessionSets`), and both sides are kept. The "Build a program for <first name> with AI" entry is unchanged.
- Size against main: 700 changed lines (695 + 5), tests included.
- CI at this head is green: "Typecheck, lint, test" SUCCESS (run 37559914813), and CodeQL, Analyze (actions) and Analyze (javascript-typescript) are SUCCESS (run 37559914749).
- Local: `src/components/coach/ai-entry/__tests__/aiEntry.test.tsx` passes 7/7 after the merge.
- Round 2 fixes are unchanged: B-443-1 (keep choices keyed by day plan + change id) and U-443-1 (History fades under Reduce Motion).
