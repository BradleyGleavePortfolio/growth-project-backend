# B-SHARE-126 — the client's coach can see their logs (explicit consent)

Started 18:43 PDT 10-06 (TZ=America/Los_Angeles date). Time box 80 min, hard stop 20:10.
Baselines read: mobile main 950689af, backend main f71bb9a4 (RO). Worktrees from origin/main at start: mobile 8e08197a, backend fdf4260a.
Both PRs carry "HELD: needs owner approval of the wording". Operator does not merge until the owner answers.

## Scope traced (screens + routes)
- Backend (unchanged rules): src/consent/consent.controller.ts (GET /consent/me, POST /consent/grant, /consent/revoke, @Roles('student'),
  JwtAuthGuard loads req.user from the DB so req.user.coach_id is fresh), consent.service.ts (rowIsGranted: no row = false;
  coachCanAccess: owner bypass, else granted row), coach.service.ts loadFitnessConsents (:87-108), rosterFitnessConsents (:297-322).
- Mobile before: no caller of /consent/* anywhere (rg). Link moments: invite code at Create Account / RoleSelection (persists coach_id
  in the user cache), emailed invite (AcceptInviteScreen), coachless Home -> CoachCodeSheet (POST /coachless/coach-code/redeem;
  patchUserCache only, useCurrentUser does not re-read). Settings > Privacy (client SettingsScreen.tsx:410).
  RootNavigator branches: unauthenticated / onboarding (consultation in clinic) / day1onboarding / student / package_prompt.

## B list
- B-SHARE-1 (FU-FOODLOG-126 B2) FIXED in m#451 + b#820: a client of any coach-role coach logs food and workouts and the coach sees
  "Food logs are not shared with this coach." on every client, because nothing in the app ever asked the client to share.

## U list
- None new.

## C one-liners
- Sub-coach ("any coach on their team assigned to you" in the notice): consent rows are keyed by coach id, so an assigned team coach
  still needs their own grant; the screen grants only the primary coach. Team coaching is not on the 10-07 path (C, follow-up).
- A coachless client's app start sends one GET /consent/me that answers 400 (no coach) and shows nothing (C, noise only).
- Not now is per device (reinstall asks again) (C, edge, deferred to 10k clients).
- Dunning lockout modal + the share prompt could both be up for a locked-out client on first start (C, edge, deferred to 10k clients).

## Covered by open PRs
- None. Checked 18:45: mobile m#448, #443, #441, #439 and backend b#816, #815, #814, #813, #809 do not touch consent, Settings,
  RootNavigator/ClientNavigator or CoachCodeSheet.

## PRs opened
- backend #820 `feat(consent): GET /consent/me says when the coach is the owner account (coach sharing)` — agent126/b-share-126-backend
  @ e6cf93160d95ee3d023ff01333c0dbd12e83eac9, +76/-3 (53 spec). CI all green. READY posted:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/820#issuecomment-6029364507
- mobile #451 `feat(privacy): client chooses to share workouts, food logs, weigh-ins and check-ins with their coach` —
  agent126/b-share-126-mobile @ 06570f132c2a2af0ccd5d9d39382a339e762aff7, +590/-3 (176 test). CI all green (Typecheck, lint,
  test full suite; CodeQL; Analyze). READY posted 19:13:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/451#issuecomment-6029440158
  Locally green one file at a time: coachSharing.test.tsx (6), CoachCodeSheet.sharing.test.tsx (2), CoachlessEntitlement (1),
  rootNavigatorPackagePromptGate (9); targeted eslint clean.

## Shipped wording (HELD for owner approval)
- Link screen: eyebrow "COACH SHARING"; title "Share your logs with <Coach name>?" (or "your coach"); body "<Coach name> will see your
  workouts, food logs, weigh-ins, and check-ins and habits."; small "Change this any time in Settings > Privacy > Coach sharing.";
  primary "Share with my coach"; secondary "Not now"; error "Sharing did not finish. Check the connection and try again."
- Settings > Privacy > Coach sharing: "Choose what your coach sees. Each change saves right away." Rows Workouts / Food logs /
  Weigh-ins / Check-ins and habits with "Shared" / "Not shared"; owner note "Your coach uses the TGP owner account, which can see these
  logs even when they are turned off here."

## Clinic build 10-07 reach
- Coach linked at sign-up / during onboarding: yes, first client-app screen after onboarding (server's primary coach).
- Coach linked later via coachless Home code sheet: yes, inside the sheet after Join, before the welcome.
- Coach linked later any other way: next app start.

## Not fixed (needs operator / owner)
1. Owner approval of the wording above (both PRs HELD). Recommended default: approve as is.
2. "Share with my coach" is in the client's voice (first person "my"), as the job specified; alternative "Share with <Coach name>".
   Recommended default: keep the job's label.

## HANDOFF
- b#820 READY at e6cf93160d95ee3d023ff01333c0dbd12e83eac9 (CI green, 16 SUCCESS + 1 SKIPPED). m#451 READY at
  06570f132c2a2af0ccd5d9d39382a339e762aff7 (CI green). Both HELD for owner approval of the wording; then T4 dual lens at those heads.
- Merge order: either order works (mobile reads owner_access only when present). Deploying #820 before or after the APK is fine.
- Device pass: on a fresh clinic install with an invite code, finish onboarding and confirm the share screen appears once; tap Share and
  confirm the coach (coach-role account) sees food logs; Settings > Privacy > Coach sharing shows four "Shared" rows.
- Worktrees removed after confirming clean and pushed (19:13). No ci/* branches created. No locks held.
- Finished 19:14 PDT (TZ=America/Los_Angeles date), inside the 20:10 hard stop.
