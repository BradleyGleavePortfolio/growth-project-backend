# B-DELIV-125 — lessons scope, buyer media, delivered meal plan (T4 builder, Claude Opus 5.5)

Started 14:21 PDT 10-06. Hard stop 15:25. Source: AUDIT-18-125 "Not fixed (needs operator)" B2, B3, B4.

## Scope traced (screens + routes)
- More -> Learn -> EducationScreen -> `GET /lessons`, `GET /lessons/recommended`, `POST /lessons/:id/complete` -> LessonsService -> Prisma Lesson / LessonCompletion. `Lesson.coach_id` is required (no platform lessons); coachless README promises Home + coach code only.
- Deliverables / PurchaseUnpack -> shared dropRow -> `GET /v1/checkout/purchases/:id/drops` (CheckoutService.listDropsForBuyer); pdf/video drops: `asset_id` = CoachMediaAsset id, `materialised_ref` = ClientAssetGrant id (MediaAssetResolver); signer CoachMediaService.getBuyerSignedUrl (grant live, asset not archived, purchase coach = asset coach, uniform 404; 409 not ready) had no route.
- meal_plan drops: MealPlanAssetResolver writes DailyMealPlanAssignment (starts_on = delivery day UTC, ends_on null) and returns its id as `materialised_ref`; ClientDailyMealPlanScreen -> `GET /me/meal-plan/today` (client-scoped, returns all active assignments, newest first).

## B list (all fixed)
- B2 (private data): a coachless client opens Learn and sees every coach's lessons. Fixed in backend #798 (no coach scope -> empty list; one coach_id filter always; completeLesson refuses lessons outside the scope).
- B3 (money): a buyer cannot open a purchased PDF/video. Fixed: backend #798 adds `GET /v1/client/media/:id/signed-url` over the existing grant-scoped signer; mobile #434 makes the rows tappable and opens the signed link, with specific 409/404/network messages.
- B4 (money/core): a buyer taps a delivered meal plan and sees the newest plan instead. Fixed in mobile #434 only (route `{ assignmentId }`, screen selects that assignment from the existing endpoint, "This plan has ended" when it is no longer active). Works against current production; no backend change needed.

## U list
- U (fixed with B3): "Saved to your library" caption on delivered pdf/video rows was a false claim; now "Tap to open".

## C one-liners
- C (edge, deferred to 10k clients): legacy rows whose meal_plan ref is a YYYY-MM-DD date still route by date (newest plan on that day).
- C: LessonsController is class-level `@Roles('student')` while create/update check role === 'coach' (coach authoring path effectively student-tier route); unchanged, not a launch flow.

## Covered by open PRs
- None. No open PR touches src/lessons/**, src/coach-media/**, dropRow.tsx or ClientDailyMealPlanScreen.tsx. m#416 also touches ClientNavigator.tsx (this change: 2-line param type), named in m#434 body. AUDIT-18 PRs b#788 / m#418 touch catalog and EducationScreen only.

## PRs opened
- backend #798 `agent125/b-deliv-125-buyer-access` head 3de021eb766f84f70e4d84fad88eca1ac1ed8613, 301 lines (92 src / 209 test). CI all green (run 37534390397: build-and-test, rls-live, rls-floor, community-live, mwb-3-live; danger, R75, schema parity, audit, CodeQL). READY comment https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/798#issuecomment-6026133769
- mobile #434 `agent125/b-deliv-125-deliverables` head 9d4cfb53557c3ed1990c41ec6e1697c0abc3885f, 415 lines (181 src / 234 test). CI all green (run 37535050283 Typecheck, lint, test; CodeQL). READY comment https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434#issuecomment-6026072108
- Local evidence: backend spec 11/11 pass; with lessons.service.ts reverted, 6/7 lesson tests fail. Mobile spec 10/10 pass; with dropRow + screen reverted, 9/10 fail; deliverablesScreen 36, purchaseUnpack 35, clientDailyMealPlanRouteParam 5 pass; scoped tsc and eslint clean.

## Not fixed (needs operator)
- None for code. Deploy ordering: b#798 must deploy for B3 to work; before that, mobile shows "File not available" on a pdf/video tap (graceful).

## HANDOFF
- Done 14:53 PDT. Both PRs open, single push each, CI green, READY FOR AUDIT posted at the exact heads above. Route T4 dual-lens audits through the operator; merge order: b#798 and m#434 are independent to merge, but B3 only works for buyers after b#798 deploys.
- PR bodies and READY texts: /home/user/workspace/ops/reports/B-DELIV-125/.
- Worktrees verified clean (0 dirty, 0 unpushed) and retained at /home/user/workspace/wt/B-DELIV-125-backend and /home/user/workspace/wt/B-DELIV-125-mobile under the workspace-retention instruction (no files deleted). No ci/* branches created; no heavy locks held.
- Nothing merged, deployed or touched in production.
