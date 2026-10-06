# S-E2E-CLIENT-123: client journey trace (scout, Claude Opus 5.5, read-only, agent 123)

Window: 21:30-21:50 PDT 10-05 (time box 45 min). Read-only: no PRs, comments, pushes, workflow runs or production access.
Evidence: backend main 5230306c (wt/RO-backend = production, deploy 8), mobile main a727eb49 (wt/RO-mobile = the 10-07 build source).
Probes and notes: ops/aud-123/S-E2E-CLIENT-123/ (routes.py = mobile-call vs backend-route sweep; route_miss.txt = its output).

Result: **1 B, 5 C**. The rest of the client journey holds end to end on mains.

## B (blocks under the freeze rules)

### B-E2E-1: Community "Be the first to post" dead-ends for every client whose coach has no community workspace (all coaches except a seeded one)
- Story (one sentence): a client of any coach (including the owner, unless a workspace row was put in by hand) opens the new Community tab on
  the 10-07 build, taps Hall, sees "The Hall is quiet / Be the first to post", writes a post, taps Post, and gets "Post not shared. This is
  no longer available..." every time. No post is ever stored, and nothing in the app or the API can fix it.
- Why: nothing in backend `src/` ever creates a `CommunityWorkspace`. The only writer is `scripts/seed-clinic-programs.ts:144-147`
  (the clinic seed). No route creates a workspace either: every POST is `workspaces/:workspaceId/...`.
  - `GET /community/me` bootstraps a student only into an existing default cohort (`src/community/community.service.ts:136-149`,
    `community.repository.ts:43-50`). With no workspace it returns `workspace_id: null` (Today shows "No cohort yet", which is fine).
  - Hall still offers the composer. `CommunityTabScreen.tsx:75,111-118` passes `workspaceId=null` and `prerequisiteLoading=me.isLoading`
    (false). `usePosts(null)` is disabled (`useCommunity.ts:82-92`), so `isEmpty` is true and `CommunitySpaceScreen.tsx:212-222` renders
    "Be the first to post".
  - The composer then uses `workspace_id ?? ''` (`CommunityComposerScreen.tsx:52,59`), so the request is
    `POST /community/workspaces//posts`. No route matches, the server returns 404, and the app shows the 404 copy in
    `communityErrors.ts:301-305`.
- Made worse tonight by two things. m#383 turned EXPO_PUBLIC_FF_COMMUNITY_TAB/HALL/COHORTS on in the production profile, and env-sync
  apply 37409749015 turned FEATURE_COMMUNITY_API/_POSTS on in production. Coaches also cannot start a community from the app:
  EXPO_PUBLIC_FF_COACH_COMMUNITY is in neither eas.json profile, and the coach community API calls 8 routes the backend does not have
  (see C-E2E-3).
- Failing-test sketch (backend, `test/community-me-bootstrap.spec.ts`): seed coach C (no workspace) and student S (`coach_id=C`). Call
  `GET /community/me` as S and expect `workspace_id` to be non-null and `membership` set. Then `POST /community/workspaces/<id>/posts` as S
  should return 201. On main the first expectation fails with `workspace_id: null`.
  Mobile sketch: render CommunitySpaceScreen with `space='hall'`, `workspaceId={null}`, `prerequisiteLoading={false}` and expect no
  "Be the first to post"; on main it renders.
- Smallest fix:
  1. Backend, about 40 lines plus one spec, in `CommunityService.getMe`. For a coach with no workspace, and for a student whose
     `coach_id` coach has none, idempotently create the space and its first cohort the same way the clinic seed does: workspace upsert on
     `slug = coach-<coachId>`, name "Community", plus cohort upsert on `workspace_id_name` "All members", `sort_order 0`. Then run the
     existing bootstrap.
  2. Mobile, about 5 lines as a safety net: in CommunitySpaceScreen, when `workspaceId` is null after a successful `/community/me`, show
     the Today-style "No cohort yet / Send your coach a message" state and hide the composer CTA.
- Operator decision D1 (default in bold):
  - **(a) Land fix 1 + 2 before the 10-07 build.**
  - (b) If they cannot land in time, drop the three production COMMUNITY flags from eas.json for this build (clinic keeps them).
  - Note for the store lens (W3-01): reports land in the workspace moderation queue, and coaches have no in-app moderation surface in
    this build.

## C (follow-ups; none blocks)
- C-E2E-2: More > Community ("Connect with other members", `MoreScreen.tsx:121-125`). For a client whose coach has no workspace, a shared
  win is visible only to its author (`community-wins.policy.ts:9-14`). The copy overstates the audience until B-E2E-1 fix 1 lands.
- C-E2E-3 (coach side, for W3-16): `coachCommunityApi.ts:511-642` calls `/community/coach/dashboard`, `/community/coach/inbox`
  (+ `/:id/ack`) and `/community/coach/cohorts` (+ `/:id`, `/:id/members`, `/:id/members/:userId`). None exists on the backend, whose
  routes are `me/coach-inbox` and `workspaces/:id/cohorts`. Hidden in this build because the coach community flag is off.
- C-E2E-4: a no-code client while FEATURE_COACHLESS_HOME is off gets locked Workout and Log, an empty plans list, and Messages saying
  "contact support to get connected" (`MessagesScreen.tsx:478-505`). This is the owner-accepted complete state (10-01 13:28). Self-serve
  code entry arrives with the m#386 code sheet when coachless_home turns on.
- C-E2E-5: the Habits check-in (`HabitsScreen` via `useSaveCheckIn`) is not behind ProtectedScreen, while `/check-ins` has
  ClientEntitlementGuard (`client-check-ins.controller.ts:24`). An unentitled client's save gets a 402. Copy not verified. Only clients
  with no plan hit it.
- Dependency, not new: Sign in with Apple on production still depends on the APPLE_AUDIENCES fix (env-truth 37405459790; W3-04
  B-APPLE-123 owns it). Until then Apple sign-up on iOS fails at the server.
- Not on the client path: `invites.ts:219` `POST /coach/invite-codes/single` (no caller) and `talentMarketplaceApi.ts:63`
  `GET /applications/me` have no backend route.

## Journey trace (what was checked and holds)
| Step | Result | Evidence |
|---|---|---|
| Sign up: email / Google / Apple, with and without a code | OK (Apple: see dependency) | CreateAccountScreen.tsx:408-416,509,730-860; b#658 code refusals `inviteCodeLifecycleRefusal` (invite-codes.service.ts) mapped on day 1 by `classify` / ATTACH_CODE_KINDS (day-one/api.ts:65-81, m#385); Day-1 CoachPairing Skip works (CoachPairingScreen.tsx:101-105) |
| Day 1 | OK | RootNavigator.tsx:709-800 order: onboarding -> day1onboarding -> day1win -> package_prompt; ReadyScreen emits authEvents -> App.tsx:144-168 uploads the push token once permission was granted on the Day-1 step |
| Buy: Android sheet | OK | PackageSelectionSheet.tsx:214-227 (empty list dismisses), ClientPackagesScreen.tsx:162-208 (usePackagePurchase, entitlement refresh on success) |
| Buy: iOS labelled 1:1 screen | OK | packagePromptGate.ts:26 (no unsolicited sheet), ProtectedScreen.tsx:48 (coach-managed gate), More > Membership > "View coaching plans" (MembershipScreen.tsx:179) -> ClientPackages headed `oneToOneCoachingLabel` ("1:1 coaching with <coach>") |
| Access | OK | ProtectedScreen fails closed; Workout/Log tabs wrapped (ClientNavigator.tsx:161,697); backend ClientEntitlementGuard on workout/log matches |
| First workout | OK | ActiveWorkoutScreen.tsx:869 (romanChat on: back to WorkoutMain with justCompletedId); no Roman network calls from client workout or Home screens |
| Food log | OK | Log tab protected; log.controller.ts:13 guard |
| Check-in | OK for entitled clients (C-E2E-5) | /check-ins routes exist; useApi.ts:371-396 |
| Roman chat, consent first | OK | Row and route behind romanChat (true in both profiles, m#383); roman.controller.ts:106-145: crisis turns skip rate, consent, cap and pool, so a crisis message always gets the 911/988 template; non-crisis turns without box-2 consent get 403 ai_consent_required -> AiRefusalNotice -> RomanAiConsent route (ClientNavigator.tsx:488); consent API /me/ai-consent(/roman) present |
| Community post | **B-E2E-1** | above |
| Message the coach | OK | POST /messages has no entitlement guard (client-messaging.controller.ts:74-87); v2 extras guarded by MessagingCoreV2Guard (flag on); block check, then push |
| Push | OK | PATCH /users/me/push-token (users.controller.ts:171); message push carries actionScreen 'Messages' (notifications.service.ts:1074-1096) -> CLIENT_PUSH_ROUTES.Messages -> Home/Messages (pushTapRouter.ts:60) |
| Seam sweeps | OK | (1) 597 literal `api.*` calls in mobile vs 835 backend routes: 10 unmatched, none on the client path (route_miss.txt). (2) Every literal `navigate('X')` / `screen: 'X'` target is registered, except the coach CrossPillar* screens |

## HANDOFF
- Done: full client journey traced on backend 5230306c and mobile a727eb49. Report final.
- Open for the operator: D1 (B-E2E-1), default (a) backend auto-provision + mobile composer guard before the 10-07 build, else (b) drop the
  three production COMMUNITY flags for this build. Pass C-E2E-3 to W3-16 (coach journey), and the moderation-surface note to W3-01.
- A fresh agent continuing: re-run `python3 ops/aud-123/S-E2E-CLIENT-123/routes.py` after new merges to repeat the route sweep. The
  B-E2E-1 repro needs no device: read the four file:line points above.
- No worktrees, branches, locks or claims were created. Nothing to clean up.
