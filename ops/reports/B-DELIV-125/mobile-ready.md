FIX ROUND 1 (OPENING) (B-DELIV-125, agent 125) — growth-project-mobile#434 @ 9d4cfb53557c3ed1990c41ec6e1697c0abc3885f — READY FOR AUDIT

- Fixes AUDIT-18-125 B3 (buyer cannot open a purchased PDF/video) and B4 (a delivered meal plan opens the newest plan instead). One-sentence user stories and design are in the PR body.
- Size: 415 lines (181 source, 234 test). No dependencies, lockfile, flags or migrations.
- CI at this head: all green — Typecheck, lint, test ([run 37535050283](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37535050283)), CodeQL / Analyze.
- Production compatibility: B4 uses only the existing `GET /me/meal-plan/today`, fully fixed against today's backend. B3 calls the new route in growth-project-backend#798; before that deploys, a tap shows the specific "File not available" message (no crash, no raw error).
- Overlap: `src/navigation/ClientNavigator.tsx` with m#416 (this PR: 2-line `ClientDailyMealPlan` param type only).
- Single push; no fix rounds.
