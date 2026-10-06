Tier: T4
Why: paying buyers could not open the PDFs and videos they bought, and a delivered meal plan opened a different plan; the fix changes how paid content is reached on the client.
T4 trigger scan: paid-content access (buyer opens a grant-scoped signed URL from backend b#798). No auth, credentials, storage paths or tokens handled on the device beyond the short-lived URL the server signs.
T3 trigger scan: new client call `GET /v1/client/media/:id/signed-url`; new `assignmentId` route param on ClientDailyMealPlan.
Bounded T1: NO (T4 trigger above).
Canonical builder: Claude Opus 5.5 (B-DELIV-125, agent 125).
Parent owner: operator agent 125.
Acceptance evidence: `src/__tests__/deliveredContentOpens.test.tsx` (10 tests): with `dropRow.tsx` and `ClientDailyMealPlanScreen.tsx` reverted to main, 9 of 10 fail (the legacy date-ref test passes on both, by design). `deliverablesScreen.test.tsx` (36), `purchaseUnpackScreen.test.tsx` (35) and `clientDailyMealPlanRouteParam.test.tsx` (5) pass locally; scoped tsc over the changed files is clean; eslint clean. Full suite and typecheck in this PR's CI.
Promotion triggers: backend b#798 changing the route path or response shape; any change to what `materialised_ref` holds for meal_plan drops.

## Bs fixed (from AUDIT-18-125)

- **B3 (money).** A client who bought a package with a PDF or video opens Deliverables, sees the item marked "Saved to your library", and cannot open it. Delivered pdf/video rows are now tappable; a tap requests `GET /v1/client/media/<asset_id>/signed-url` (the CoachMediaAsset id, never `materialised_ref`, which is the grant id) and opens the signed link in the in-app browser (`expo-web-browser`, already a dependency). 409 shows "Still processing"; 404 shows "File not available ... message your coach"; no network shows "Check your connection and try again". The false "Saved to your library" caption is gone.
- **B4 (money/core).** A client taps a delivered meal plan and sees whichever plan is newest instead, because the backend stores the DailyMealPlanAssignment id in `materialised_ref` and mobile routed it as a date (the screen discarded it). The row now routes `{ assignmentId }` (a YYYY-MM-DD ref, as in older fixtures, still routes `{ date }`), and ClientDailyMealPlan selects exactly that assignment from today's active assignments. Delivered assignments start on delivery day with no end date, so the plan is always in that list while active; if the coach ended it, the screen says "This plan has ended" instead of showing a different plan.

## Works against today's production backend
- B4 uses only the existing `GET /me/meal-plan/today` (client-scoped by JWT), so it is fully fixed against current production.
- B3 needs backend b#798 (ships with tonight's deploy). Before that deploy, a tap gets 404 and shows the specific "File not available" message; nothing crashes, no raw error text, no dead spinner. After the deploy the same build opens the file with no app update.

## Overlap
- `src/navigation/ClientNavigator.tsx` is also touched by m#416 (accessibility). This PR changes only the `ClientDailyMealPlan` param type (2 lines); no other overlap with open PRs (checked m#411-m#432).
- Companion backend PR: growth-project-backend#798 (also fixes B2, coachless clients seeing every coach's lessons).

## Size
415 lines (181 source, 234 test). No new dependencies, no lockfile, no flags.
