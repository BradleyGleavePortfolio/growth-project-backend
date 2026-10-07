# FU-FOODLOG-126 — client food logging on the 10-07 clinic build

Started 18:00 PDT 10-06 (TZ=America/Los_Angeles date). Time box 75 min, hard stop 19:25.
Baselines: mobile main 950689af, backend main f71bb9a4 (RO checkouts).

## Scope traced
- Food Log tab: LogScreen -> clientStore.loadDayData -> GET /log/daily (LogController -> LogService.getDaily, user-scoped LoggedFoodEntry + food_item).
- Search: FoodSearchModal/FoodSearchView -> foodApi.search -> GET /foods/search (FoodService.search: local DB, USDA `usda_*`, OFF `off_*`).
- Portion: QuantityPickerModal -> utils/log/macros quantityMultiplier -> submitSearchLogOnline -> POST /foods (only for `off_*`/no id) + POST /log/food (resolveOrImportId).
- Manual / custom foods: ManualFoodEntryForm -> submitManualLog* -> POST /foods (CreateFoodDto, PER_SERVING) + POST /log/food.
- Recent / Frequent / Repeat meal: useFoodBrowse (7 x GET /log/daily) -> repeatPastMeal.
- Edit / move / delete: inline edit modal -> PUT /log/food/:id; delete -> DELETE /log/food/:id with optimistic removal + reload.
- Meal sections + daily totals vs targets: MealSectionCard, DailySummaryBar, useMacroTargets (GET /me/macros/current).
- Coach view: FoodLogReviewSection -> GET /coach/clients/:id/timeline (consent-gated meals slice, cursor paging); SummaryTab -> GET /coach/clients/:id/summary; roster activity (rosterFitnessConsents).
- Offline add then reconnect (one offline moment): logSubmit *Offline -> foodLogQueue.enqueue (AsyncStorage) -> flush -> POST /foods + POST /log/food with client_uuid upsert.
- Barcode: not on the shipped surface (stubs removed; no camera permission). Backend GET /foods/barcode/:upc exists with no mobile caller. Not a launch item.
- Traced clean: edit / move / delete, meal sections, totals vs targets, search result import (OFF -> category 'generic', numeric macros accepted by CreateFoodDto), manual entry validation copy, coach timeline paging and the withheld-vs-zero display (B-404-1, coachFoodConsent124.test.tsx).

## B list
- **B1 (FIXED, m#447)** — A client logs lunch with no signal, sees "Saved offline", closes or backgrounds the app, and later opens it on Wi-Fi: the lunch never reaches their log, totals or their coach unless they pull down on Food Log. Cause: the queue was sent only on an in-app offline -> online change (RootNavigator `wasOnlineRef` starts `true` on every cold start) or a Food Log pull to refresh, and nothing reloaded the day after a send, so even the reconnect case left the food missing on screen and invited a duplicate log.
- **B2 (NOT FIXED, owner decision, T4 consent)** — A coach (role `coach`, not `owner`) opens any client and sees "Food logs are not shared with this coach." (and empty workouts, weigh-ins, check-ins in the timeline and roster activity), because no code path ever creates `fitness.*` ClientCoachConsent rows: the mobile app has no grant UI (no caller of POST /consent/grant for fitness scopes), and `ConsentService.rowIsGranted(null)` is false. The published health-data notice (backend src/public-pages/trust-pages.html.ts:452) tells clients their coach and assigned team coaches see their logs, check-ins and connected health data. Owner accounts bypass the check, so an owner-account test would not show it. "Silence is not consent" is a deliberate, tested design (backend test/consent.service.spec.ts:82 and :243, test/coach-consent-gating.spec.ts, test/coach-roster-activity.spec.ts), so it was not flipped here. Details and smallest fix under "Not fixed".

## U list
- **U1 (FIXED, m#447)** — Offline, a client saves breakfast and the Food Log still shows an empty Breakfast and unchanged totals with nothing saying it is waiting; the only signal was a one-time alert. Now: "1 food saved offline is not in this log or its totals yet. It syncs when the connection returns." (online: "Pull down to sync it now."), plural form for several.
- **U2 (FIXED, m#447)** — Offline, Add Food wiped Recent and said "No foods logged in the last 7 days" to a client who logs daily, hiding the recent foods that can still be saved offline. Now the last lists stay and the empty state reads "Recent foods could not load. Check the connection, or tap Enter Manually to save this food now."

## C one-liners
- PUT /log/food/:id (backend src/log/log.service.ts:122 updateEntry) does not call `aiContext.invalidateForUser` (logFood :61 and deleteEntry :148 do); Roman sees an edited portion after the 30 s cache TTL.
- docs/RELEASE_SMOKE.md:113 (T-6) still asks testers to scan a barcode; barcode is not shipped (docs only; flag to S-BUILDDAY).
- foodLogQueue.mergeAnonymousQueueIntoUser (src/services/foodLogQueue.ts:172) has no caller; foods queued while signed out stay under the anonymous owner (edge).
- quantity_multiplier `@Min(0.01)` (backend src/log/log.dto.ts:30, :72) rejects portions under 1 g of per-100 g foods (edge).

## Covered by open PRs
- None. No open mobile or backend PR touches food logging files (checked 18:02: mobile #439/#302/#265/#264 + dependabot; backend #808/#809 + older).

## PRs opened
- growth-project-mobile#447 `fix(food): send foods saved offline at app start and show them while they wait` — branch agent126/fu-foodlog-126, head 863df75fab9102b28f44bef7c17bbb34e4e6b441, +482/-23 (11 files, 307 added lines are tests). CI green at that head (Typecheck, lint, test SUCCESS; CodeQL SUCCESS). The first push cf19cfa1 was red from this change (Typecheck: untyped renderHook props in a new test), fixed in 863df75f. READY comment posted 18:41: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/447#issuecomment-6029058316
  - New: src/services/foodLogSync.ts (single-flight send, never rejects, reloads the selected day when at least one food lands, pending-count pub/sub), src/hooks/useFoodLogQueueSync.ts (sign-in / cold start, reconnect, foreground; usePendingFoodLogCount).
  - Changed: RootNavigator (uses the hook; workout triggerSync untouched), LogScreen (pending notice, pull-to-refresh via syncFoodLogQueue, notify after offline saves), useFoodBrowse (browseUnavailable, keeps last lists), FoodSearchModal/FoodSearchView (prop + copy).
  - Tests: foodLogSync.test.ts (5), useFoodLogQueueSync.test.ts (5), LogScreen.offlinePending.test.tsx (5), useFoodBrowse.speed.test.ts (+2, 8 total). Locally also green: rootNavigatorConsultationColdBoot (7), LogScreen.foodSpeed (6).
  - Works against the current production backend: same POST /foods + POST /log/food with client_uuid, no contract change. No backend PR.

## Not fixed (needs operator)
1. **B2 coach cannot see food logs (owner decision, T4).** Recommended default: the four `fitness.*` scopes (workouts, food_macros, body_metrics, habits_progress) count as shared with the client's own coach when no row exists; an explicit revoke still wins; bloodwork, finance and wearable.insights stay opt-in. This matches the published notice. Smallest fix (backend, about 60-120 lines with spec updates, Opus builder + dual lens): src/consent/consent.service.ts:328-336 `coachCanAccess` (no row + fitness scope -> true; isGranted itself unchanged so bloodwork stays opt-in) and src/coach/coach.service.ts:297-322 `rosterFitnessConsents` (start every client from the full fitness set, delete scopes whose row exists and is not granted); update test/consent.service.spec.ts:243-286, test/coach-roster-activity.spec.ts:97-150. Alternative if the owner wants explicit consent: a client screen that grants the four scopes (larger, mobile + copy). Early note: ops/lanes126/notify/FU-FOODLOG-126-EARLY.txt.
2. **Device check: portion sheet over the search sheet on iPhone.** QuantityPickerModal (src/components/log/QuantityPickerModal.tsx:50, pageSheet) opens as a sibling Modal while FoodSearchModal (src/components/log/FoodSearchModal.tsx:69, pageSheet) is visible. On RN 0.85 Fabric, UIKit may refuse a second presentation from a presenter that is already presenting. TestFlight build 4 had the same layout with no report (unverified). Recommended default: confirm on the TestFlight device pass; if the portion sheet does not open, render QuantityPickerModal inside FoodSearchModal's content.

## HANDOFF
- m#447 @ 863df75f is READY FOR AUDIT (T3, mobile only, CI green). Next: lens audit, then merge before the 09:30 freeze. No backend PR.
- B2 (coach sees no food logs for a non-owner coach) needs an owner decision before anyone builds it; recommended default and smallest fix are in "Not fixed" item 1. If approved, it is a T4 backend PR (Opus builder + dual lens) and should land before the clinic coaches use the coach app.
- Device pass: check that the portion sheet opens over Add Food on iPhone (Not fixed item 2) and, offline, that the waiting-food notice shows and clears after reopening the app online.
- C items go to the C backlog; RELEASE_SMOKE T-6 barcode wording goes to S-BUILDDAY.
- Worktree /home/user/workspace/wt/FU-FOODLOG-126-mobile removed after confirming it was clean and pushed. No ci/* branches were created.
- Finished 18:41 PDT (TZ=America/Los_Angeles date), inside the 19:25 hard stop.
