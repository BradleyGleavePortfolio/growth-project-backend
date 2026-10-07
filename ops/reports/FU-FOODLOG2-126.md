# FU-FOODLOG2-126 — food logging pass 2 (coach view + targets, totals maths, water/meals, Today cards, barcode/quick-add copy, no-plan day)

Started 18:33 PDT 10-06 (TZ=America/Los_Angeles date). Hard stop 19:40.
Baselines: mobile main 950689af (RO checkout; PR cut from origin/main ad08af9b, none of my files changed between them), backend main f71bb9a4.
m#447 (FU-FOODLOG-126) owns: LogScreen, FoodSearchModal, FoodSearchView, useFoodBrowse, RootNavigator, foodLogSync, useFoodLogQueueSync. Not touched here.

## Scope traced
- Coach view of targets: ClientDetail Summary "Macros" pill -> CoachMacrosReviewScreen -> useCurrentMacrosForClient / useClientMacroHistory -> GET /coach/clients/:id/macros(/current) (CoachMacrosController, CoachGuard, MacrosService.assertClientOfCoach). Write path: useCreateMacroTarget -> POST /coach/clients/:id/macros (CreateMacroTargetDto 800-7000 kcal etc.) — had NO caller in the app.
- Coach view of food log: FoodLogReviewSection (timeline paging, consent, per-day totals, % of target via resolveCoachTargets: coach target then profile macro_target_*), SummaryTab (today totals from /coach/clients/:id/summary). Traced clean apart from B2 of pass 1 (consent rows; owner decision, not redone).
- Totals vs targets maths: backend LogService.getDaily (sum quantity_multiplier x food_item, rounded once; targets via resolveDisplayedTargets), mobile clientStore.loadDayData (per-entry rounding for meal rows, server totals for the bar), DailySummaryBar (Eaten / Remaining or Over target / goal lines), useMacroTargets (GET /me/macros/current, per-user cache). Units kcal/g consistent; gross calories only (no exercise netting anywhere; profile.calorie_display "net" is stored but unused, so no false "net" claim on screen).
- Water: WaterTracker -> clientStore.logWater (optimistic) -> POST /nutrition/water (LogWaterDto) ; GET /nutrition/water?date (WaterService.getDaily) ; Home shows litres, Log shows oz.
- Meal counts: Home buildProgressLine (distinct meal types logged), MealSectionCard per-meal kcal + empty copy.
- Today (Home) food cards: HomeScreen number grid (CALORIES/PROTEIN/CARBS/FAT/WATER, simple mode), FullMacrosIntroCard, loadError state.
- Day with no plan (no coach target, profile incomplete): /me/macros/current null -> Log bar "—  No target", Home "—" cells that open Log, ClientMacrosScreen "No targets yet". Clean. Profile-sourced targets show "Effective <profile updated date>" (not 1970; effective_from = profile.updated_at).
- Barcode: not on the shipped surface (pass 1 confirmed). Quick-add / manual / search failure copy lives in LogScreen (m#447 file); read it: specific copy everywhere ("Couldn't log food" + reason), no generic errors. Nothing to fix.

## B list
- **B1 (FIXED, m#449)** — A coach opens a client, taps Macros to set calories and protein, and reads "No target set. Use the prescriber to issue the first target." — there is no prescriber anywhere in the app (useCreateMacroTarget had no caller), so no coach can prescribe a client's calories or macros. (Operator may grade this a U-high "dead end + copy contradicts the app"; it is a coach nutrition core-flow dead end on the owner's top-priority area.)

## U list
- **U1 (FIXED, m#449)** — A client whose coach set targets sees one goal on the Food Log ("2400 goal") and a different one, or none, on Home: Home read `currentUser.profile.calorie_target` etc., the phone's onboarding numbers that the server ignores (consultation-onboarded clinic clients never have them, so Home showed no goal at all). Home now uses useMacroTargets (GET /me/macros/current), cache only as first-paint fallback.
- **U2 (FIXED, m#449)** — A client looks back at yesterday on the Food Log, taps Home, and sees yesterday's meal count and calories under today's date (shared day store; Home loaded `selectedDate`). Home now loads today on mount, refresh, and on focus when the store holds another day.
- **U3 (FIXED, m#449)** — On a weak connection a client taps +8 oz, the water number rises and then silently drops back. Now: "8 oz of water was not saved. Check the connection, then add it again." (shown in the existing day-data notice on Log and Home).
- **U4 (FIXED, m#449)** — Water card says "1 glasses today", and "today" while viewing a past day. Now "1 glass (8 oz)" / "3 glasses (8 oz each)".
- **U5 (FIXED, m#449)** — A client sets Water Goal to 64 oz in Settings, but the Food Log water card keeps saying "/ 128 oz" (fixed default, not even the Settings default of 100). WaterTracker now reads the Settings goal; useSettings instances share saves so it updates without a restart.
- CoachMacrosReview load failure used to read "No target set" (false); now a Retry state (part of the B1 fix).

## C one-liners
- Meal row kcal are rounded per entry while the bar uses one server-rounded total; rows can sum 1-2 kcal off the bar (cosmetic).
- WaterTracker's 128 oz goal is a hard-coded default, not a coach target (product choice; no coach water target exists).
- Home shows water in litres, Food Log in oz (cosmetic inconsistency).
- C (edge, deferred to 10k clients): coach Summary "today" totals are computed for a server-chosen day (time zone; not analysed per rule 8).
- Settings "Meals per day" stepper saves meals_per_day to the profile; no mobile screen reads it (backend use not checked; left).
- FoodLogReviewSection shows the current target only when the window has meals (coach sees no target line on an empty window; Macros screen has it).
- GET /coach/clients/:id/macros/current returns only coach rows, not the profile fallback the client sees; the Macros screen copy now says so.
- C (edge, deferred to 10k clients): useMacroTargets keeps the cached target when the server later returns null (coach archived every target).

## Covered by open PRs
- Offline queue / pending notice / browse-offline copy: m#447 (pass 1). Coach consent (B2 of pass 1): owner decision, in pass 1 report. Not redone.

## PRs opened
- growth-project-mobile#449 `fix(food): coaches can set a client's daily targets; Home shows today's numbers against the server targets` — branch agent126/fu-foodlog2-126, head 4d13021c9792f921487fd89855f88131e0748926 (2 commits), +565/-32 = 597 lines vs merge-base ad08af9b (11 files, about 250 of them tests). CI at 4d13021c: Typecheck, lint, test SUCCESS; CodeQL SUCCESS. READY comment posted 18:55 PDT (issuecomment-6029218590).
  - Files: src/screens/coach/CoachMacrosReviewScreen.tsx, src/utils/coach/macroTargetForm.ts (new), src/screens/client/HomeScreen.tsx, src/store/clientStore.ts (logWater only), src/components/WaterTracker.tsx, src/hooks/useSettings.ts; tests CoachMacrosReviewScreen.setTargets (4), HomeScreen.todayTargets (3), macroTargetForm (4), clientStore.failureStates (+1), WaterTracker.goal (2). Local: all green, plus HomeScreen.macroMode (5), LogScreen.foodPortions (4).
  - No overlap with m#447 or any other open mobile PR (checked 18:39). Works against production backend f71bb9a4 (routes already live). No backend PR needed.

## Not fixed (needs operator)
- None new. Pass 1's B2 (coach consent rows) still stands as an owner decision. B1's fix does not depend on it: the Macros screen and POST /coach/clients/:id/macros are not consent-gated, so any coach can now set targets; only the food-log views stay hidden for role `coach` until B2 is decided.

## HANDOFF
- State at 18:55 PDT 10-06: m#449 open, head 4d13021c9792f921487fd89855f88131e0748926, 597 lines, CI green, READY FOR AUDIT comment posted. Needs T3 dual-lens review (Opus + Sol) at that head, then operator merge before the 10-07 build.
- No backend PR (no route is wrong; every route used is live on f71bb9a4). No ci/* lane branches were created.
- Worktree /home/user/workspace/wt/FU-FOODLOG2-126-mobile removed after push (branch agent126/fu-foodlog2-126 on origin holds everything).
- If a lens asks for changes: recreate a worktree from origin/agent126/fu-foodlog2-126, keep the total under 600 lines (vs merge-base), post a FIX ROUND 2 comment.
- Open owner decision carried from pass 1: B2 coach consent rows (FU-FOODLOG-126 report). Not touched.
