FIX ROUND 1 (OPENING) (FU-FOODLOG2-126, agent 126) — growth-project-mobile#449 @ 4d13021c9792f921487fd89855f88131e0748926 — READY FOR AUDIT

- Size: +565 / -32 = 597 changed lines vs merge-base ad08af9b (11 files, about 250 test lines). Under the 600 job cap.
- CI at this head: Typecheck, lint, test SUCCESS; CodeQL SUCCESS (both analyses). The first push 44857ee6 was also green; the second commit only adds the Water Goal fix (U5) and trims comments/tests.
- Fixes: B1 coach cannot set a client's daily targets (dead "Use the prescriber" copy; now a Set daily targets form on the existing POST /coach/clients/:id/macros, server limits mirrored, specific failure copy, load-failure Retry). U1 Home targets now come from GET /me/macros/current (same as the Food Log). U2 Home always shows today, even after the Food Log was left on another day. U3 failed water add now says so. U4 "1 glass" copy, no "today" on past days. U5 water card uses the Settings Water Goal instead of a fixed 128 oz.
- Backend: none needed; every route used is live on production f71bb9a4.
- Overlap: none with m#447 (LogScreen, FoodSearch*, useFoodBrowse, RootNavigator, foodLogSync untouched) or any other open mobile PR.
- Local targeted runs (one file at a time): CoachMacrosReviewScreen.setTargets 4/4, HomeScreen.todayTargets 3/3, macroTargetForm 4/4, clientStore.failureStates 5/5, WaterTracker.goal 2/2, HomeScreen.macroMode 5/5, LogScreen.foodPortions 4/4.
