Tier: T4
Why: one change closes a private-data leak (every coach's lessons shown to coachless clients) and the other gives paying buyers access to the PDFs and videos they bought; both are access decisions on private or paid content.
T4 trigger scan: tenancy/access scope (Lesson reads and writes now always scoped to one coach); paid-content access (new buyer route over the existing grant-scoped signer). No auth, RLS, credentials, migrations or destructive data changes.
T3 trigger scan: new authenticated route `GET /v1/client/media/:id/signed-url`.
Bounded T1: NO (T4 triggers above).
Canonical builder: Claude Opus 5.5 (B-DELIV-125, agent 125).
Parent owner: operator agent 125.
Acceptance evidence: `test/b-deliv-125-lessons-scope-buyer-media.spec.ts` (11 tests). With only `src/lessons/lessons.service.ts` reverted to main, 6 of the 7 lesson tests fail (coachless list, coachless recommended, unknown user, cross-coach complete, coachless complete, scoped complete); the 4 route tests fail on main because the route does not exist. Existing `test/lessons.service.spec.ts` still passes. Full suite and tsc in this PR's CI.
Promotion triggers: any change to `getBuyerSignedUrl`, ClientAssetGrant semantics, or a decision that coachless clients should see the featured coach's lessons.

## Bs fixed (from AUDIT-18-125)

- **B2 (private data).** A client who signs up without a coach opens More, then Learn, and sees every coach's lessons on the platform, because a missing coach meant "no coach filter". Now `getLessons` and `getRecommended` return an empty list when the user has no coach scope, and always filter by exactly one `coach_id` otherwise; `completeLesson` refuses (404) a lesson outside the client's coach scope instead of recording it. Lessons always belong to a coach (`Lesson.coach_id` is required) and the coachless product (src/coachless/README.md) promises Home and a coach code, not a lesson library, so empty is the correct coachless result. The mobile Learn screen already shows an empty state for an empty list.
- **B3 (money).** A client who bought a package with a PDF or video sees it under Deliverables but cannot open it, because the grant-scoped signer `CoachMediaService.getBuyerSignedUrl` had no route. New `GET /v1/client/media/:id/signed-url` (`:id` = the drop's `asset_id`, the CoachMediaAsset id) calls it with `req.user.id`. Access is unchanged and entirely the signer's: live (non-revoked) ClientAssetGrant for that caller and asset, asset not archived, purchase coach equals asset coach; every refusal is the same 404; a not-yet-ready asset is 409 `ASSET_NOT_READY`. The caller cannot choose the URL lifetime (default signed TTL). JwtAuthGuard at class level plus global RolesGuard (`student`, `coach`, `owner`, mirroring `GET /v1/checkout/purchases/:purchaseId/drops`).

B4 (delivered meal plan routed as a date) needs no backend change: it is fixed in the mobile PR by routing on the assignment id against the existing `GET /me/meal-plan/today`.

## Overlap
None. No open PR touches `src/lessons/**` or `src/coach-media/**` (checked b#776-b#797). Mobile companion PR opens the new route and degrades to a specific error message until this deploys.

## Size
301 lines (92 source, 209 test). No migrations, no new dependencies, no flags.
