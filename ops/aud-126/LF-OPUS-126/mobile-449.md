DRAFT (pre-read 44857ee6, incremental 4d13021c re-read; re-check head before posting)

Reviewed: 11 files, 565+/32- = 597 lines. T3; mobile only, existing production routes (f71bb9a4).
Traced:
- Coach "Set daily targets" (CoachMacrosReviewScreen.tsx SetTargetsForm -> useCreateMacroTarget -> POST /coach/clients/:clientId/macros):
  body {calories_kcal, protein_g, carbs_g, fats_g, notes?} matches backend CreateMacroTargetDto (macros.dto.ts:18-54: IsInt, 800-7000,
  0-500, 0-900, 0-400, notes <= 500, trimmed); the form mirrors those limits with field-specific copy and rounds to whole numbers, so an
  accepted value is never a 400. Tenancy stays server-side (CoachGuard + assertClientOfCoach); 404/400/429/network copy is specific.
  A failed current-target read shows Retry instead of the old "No target set" claim; the form is hidden while loading or on error.
- Home targets now read useMacroTargets (GET /me/macros/current, per-user cache, the Food Log's source) with the cached profile numbers only
  as a first-paint fallback, so Home and Food Log agree.
- Home pins the shared day store to today (mount, refresh, focus when another day is held). clientStore.loadDayData sets selectedDate with
  the data in one set() and leaves both untouched on failure, so the Food Log never shows one day's rows under another day's date.
- Water: a failed POST /nutrition/water now reverts and says "8 oz of water was not saved ..." via the existing loadError banner; copy
  "1 glass (8 oz)" / "N glasses (8 oz each)".
- 4d13021c: WaterTracker's goal now comes from Settings > Water Goal (useSettings merges DEFAULT_SETTINGS, Settings clamps 40-200 oz, so
  the divisor is never 0 or missing) instead of a fixed 128 oz; useSettings instances share saves through a listener set removed on unmount.
- R75 scan: no new as any / as unknown as / as never / empty catch.
B: none.
C: none.
