# AUD-E2E-CLIENT-126 — client first hour on the 10-07 build (Claude Opus 5.5, auditor, read-only)

Start 18:33 PDT 10-06 (TZ=America/Los_Angeles date). Hard stop 19:35. No PRs (auditor job).
Code read: mobile main moved during the audit, so findings are against **mobile origin/main e8c4d766** (950689af + #444, #442, #440, #445) and
**backend origin/main 35c22212** (f71bb9a4 + #808, #810, #812), read with `git show origin/main:` from the main clones (no checkout).
Build: eas.json profile clinic (extends production). Prod flags: backend .github/fly-env-desired-state.json on main.

## Status
DONE 18:55 PDT (10-06). Auditor only, no PRs. B=1, U=4, C=3 one-liners.

## B list
- B-1: a client taps Start on the workout their coach assigned and nothing happens (WorkoutAssignmentDetailScreen.tsx:110-121).

## U list
- U-1: the coach's name at the top of the client's Messages thread is a dead tap (MessagesScreen.tsx:433-440; ContactView only in MoreStack).
- U-2: "Mute all notifications" is unreachable for clients; Settings opens a reduced categories screen whose "System" line is untrue
  (client SettingsScreen.tsx:344; settings/NotificationPreferencesScreen.tsx:76-82, :155-159).
- U-3: Support screen mentions a "Client Bot" that does not exist (SupportInboxScreen.tsx:169-170).
- U-4: a client with no coach is told "your coach manages your access" / "your coach hasn't published a plan", and Day-1 offers
  "Log your first meal" / "check-in" that hit the paywall (PaywallSheet.tsx:41-43, ProtectedScreen.tsx:22-85,
  ClientPackagesScreen.tsx:415-429, Day1WinScreen.tsx:45-60).

## Covered by open PRs
- Day-1 copy and lost last onboarding answer: m#441 (open) + b#812 (merged), FU-FIRSTRUN-126.
- Food saved offline at app start: m#447 (open), FU-FOODLOG-126.
- Roman memory permission row in Settings: m#446 (open) / b#811 (open), B-R11C-126.
- None of the open mobile PRs (#447, #446, #443, #441, #439) touch WorkoutAssignmentDetailScreen, MessagesScreen, client SettingsScreen,
  SupportInboxScreen, ProtectedScreen, PaywallSheet, ClientPackagesScreen or Day1WinScreen.

## PRs opened
None (auditor job: "No PRs").

## Not fixed (needs operator)
1. B-1 (route to a mobile builder tonight, before the APK; T1/T2, about 10 lines incl. 2 test mocks):
   WorkoutAssignmentDetailScreen.tsx:110 replace `navigation.getParent()?.getParent?.()` with `navigation.getParent()` and keep
   `navigate('WorkoutTab', { screen: 'ActiveWorkout', params })`; drop the dead fallback at :121 or keep it; fix the mocks in
   src/__tests__/workoutAssignmentNamesUx124.test.tsx:25 and workoutAssignmentRomanSets125.test.tsx:24 to one level
   (`getParent: () => ({ navigate: mockNavigate })`). A test that fails on main: render the screen with the one-level mock, tap Start,
   expect mockNavigate called with 'WorkoutTab'.
2. U-1: add `<HomeStackNav.Screen name="ContactView" component={ContactView} />` + HomeStackParamList entry (ClientNavigator.tsx ~415).
3. U-2: client SettingsScreen.tsx:344 -> `navigation.getParent()?.navigate('Home', { screen: 'NotificationPreferences', initial: false })`
   (full screen with Mute all), or add a second row; System description -> "Weekly summary email."
4. U-3: SupportInboxScreen.tsx:169 copy -> "Support is separate from Roman. A person from the support team replies during business hours."
5. U-4: coach-less branch in ProtectedScreen / PaywallSheet / ClientPackages empty state ("Join a coach to start logging" + Enter a coach
   code -> Home > Messages) and Day1WinScreen shows only the weight card when the entitlement is not active.

## Decisions for operator / owner
- D1 (operator): ship B-1 in the 10-07 build. Recommended default: yes; one small mobile PR with U-1, U-2 and U-3 (all under 60 lines),
  so the device pass C3/D4/H3 can pass.
- D2 (owner): should a client with no coach (or a code that only offers a plan) be able to log food, workouts and check-ins free before
  paying? Recommended default: keep them gated as built (coach-led product), and fix only the wording (U-4).

## Scope traced (client, clinic build, prod flags)
- Root routing: RootNavigator bootstrapAuth (student branch: consultationApplies -> Consultation or Lean onboarding -> Day-1 -> Day-1 win -> app),
  AuthNavigator (Welcome, Login, CreateAccount, RoleSelection, EmailVerified, SupportInbox pre-sign-in).
- Backend: GET /me/onboarding consultation_available (onboarding.service.ts:611) -> coachless client gets the standard path.
- Tabs (icon-only, no labels): Home, Train (WorkoutTab), Log food, Calendar, More ("Profile and more", person icon), Community.
- Cross-navigator navigation audit: every `navigate('X')` in client screens/components checked against the stack the screen is registered in
  (HomeStack, WorkoutStack, MoreStack, CalendarStack, CommunityStack, Tab). React Navigation core 7.21.1: an unhandled NAVIGATE is a silent
  no-op in production (BaseNavigationContainer.tsx:412-416) and `navigationInChildEnabled` is not set, so a cross-stack name is a dead tap.
- Train -> From your coach -> WorkoutAssignmentDetail -> Start (WorkoutScreen.tsx:589-606, WorkoutAssignmentDetailScreen.tsx:90-122).
- Messages (client thread header), ContactView.
- Coach code sheet (CoachCodeSheet.tsx join/welcome), coachless Home slot.
- Community tab, Leaderboard (CommunityStack + backend me/leaderboard scoped to requester.coach_id), More > Community (wins feed, /community/feed policy-scoped).
- Deliverables -> PDF/video (dropRow.tsx openPurchasedMedia, grant-scoped signed URL).
- Progress > log weight (lbs only, labelled lbs), Report screen.
- Settings: Notification preferences, Support, Trust & Privacy, Roman and AI, Blocked Users, My data, Reset Onboarding.
- Support: SupportInboxScreen (Crisp + Report a problem by email + fallback).
- Roman: roman.controller sendMessage ordering (crisis short-circuit before rate limit, consent, daily cap and coach pool) - correct.
- Health Connect: app.config.js TGP_ANDROID_HEALTH_CONNECT=1 in clinic, onDeviceCopy states.
- Email confirmation: backend emailRedirectTo default tgp://verified + linking `verified` path.
- Role choice: SIGNUP_ROLE_CHOICE_ENABLED unset -> code default true (auth.service.ts:81), so the sheet's "select the client role" is right.


## Findings

### B-1 — Coach-assigned workout: Start does nothing (core flow "train" dead-ends)
- User story: a client taps Train, then "From your coach", opens the workout their coach assigned and taps Start, and nothing happens, so they
  cannot do (or log) the workout their coach gave them.
- Where: mobile src/screens/client/WorkoutAssignmentDetailScreen.tsx:110-121 (main e8c4d766).
  The screen is registered only in MoreStack (ClientNavigator.tsx MoreStackNav "WorkoutAssignmentDetail"). `navigation.getParent()` is already
  the Tab navigator; `getParent()?.getParent?.()` is undefined because Tab is the top navigator under NavigationContainer (RootNavigator renders
  <ClientNavigator/> directly, no root stack, never had one). So the code falls to `navigation.navigate('ActiveWorkout', params)` from
  MoreStack; ActiveWorkout lives only in WorkoutStack; MoreStack and Tab routers return null; navigationInChildEnabled is off; in production the
  unhandled action is silently dropped (core 7.21.1 BaseNavigationContainer.tsx:412-416). Both entry paths hit it: one pending assignment
  (WorkoutScreen.tsx:594-605 -> MoreTab/WorkoutAssignmentDetail) and several (ClientWorkoutViewerScreen.tsx:59 -> WorkoutAssignmentDetail), plus a
  delivered workout program from a purchased package (dropRow.tsx:220). It is the only Start path for an assigned workout (no other
  `navigate('ActiveWorkout')` carries assignmentId).
- Why tests pass: src/__tests__/workoutAssignmentNamesUx124.test.tsx:25 and workoutAssignmentRomanSets125.test.tsx:24 mock
  `getParent: () => ({ getParent: () => ({ navigate }) })`, a two-level parent that does not exist in the app.
- Smallest fix (about 6 lines + 2 test mocks): use the Tab navigator directly:
  `const tabNav = navigation.getParent(); if (tabNav) { tabNav.navigate('WorkoutTab', { screen: 'ActiveWorkout', params }); return; }`
  and change both test mocks to `getParent: () => ({ navigate: mockNavigate })` asserting
  `('WorkoutTab', { screen: 'ActiveWorkout', params: expect.objectContaining({ assignmentId }) })`. No backend change. Not T4.
- Covered by an open PR? No (m#447, #446, #443, #441, #439 files checked; none touch this screen).
- Device sheet C3 and D4 will record "different" on both phones until this is fixed.

### U-1 — Client Messages header (coach name with a chevron) is a dead tap
- User story: a client in their coach conversation taps the coach's name at the top (it shows a chevron) and nothing opens, so the contact
  card with Mute and Block User is unreachable from the thread.
- Where: mobile src/screens/client/MessagesScreen.tsx:433-440 (`navigation.navigate('ContactView', ...)`), header at :582-592. MessagesScreen is
  registered in HomeStack (ClientNavigator.tsx:415); ContactView only in MoreStack (ClientNavigator.tsx:578). Same silent no-op as B-1.
- Smallest fix: register ContactView in HomeStackNav too (one line `<HomeStackNav.Screen name="ContactView" component={ContactView} />` plus
  the HomeStackParamList entry). Block User for the coach thread also has message-level Report, so U, not B.

### U-2 — Client cannot reach "Mute all notifications"; Settings opens a reduced categories screen with an untrue "System" line
- User story: a client opens More > Settings > Notification preferences to silence the app and finds only five category switches (no "Mute
  all notifications", no community switch), and the "System" switch says it covers billing and critical alerts but only turns off the weekly
  summary.
- Where: client Settings row src/screens/client/SettingsScreen.tsx:344 -> MoreStack 'NotificationPreferences' = settings/NotificationPreferencesScreen
  (ClientNavigator.tsx:87 import alias, :538), title "Notification Categories". The full m#341 screen with Mute all
  (src/screens/notifications/NotificationPreferencesScreen.tsx:305-313) is registered only as HomeStack 'NotificationPreferences'
  (ClientNavigator.tsx:422-426) and nothing in the client app navigates to it (repo-wide grep). "System" maps to
  `{ weekly_summary_enabled }` only (settings/NotificationPreferencesScreen.tsx:76-82 vs description at :155-159).
- Smallest fix: point the client Settings row at the full screen
  (`navigation.getParent()?.navigate('Home', { screen: 'NotificationPreferences', initial: false })`), or register
  notifications/NotificationPreferencesScreen in MoreStack as 'NotificationSettings' and add one row; change the System description to
  "Weekly summary email." Device sheet H3 fails until then.

### U-4 — A client with no coach is told "your coach" manages access; Day-1 wins send unentitled clients to a paywall
- User story: a new client who signs up without a code finishes Day-1, taps "Log your first meal" (or the Log food / Train tab), and is told
  "Your coach manages your access ... Send them a message" (iPhone) or "Choose a Plan" then "Your coach hasn't published a plan yet. Message
  them" (Android), although they have no coach.
- Where: every client food, workout, check-in, booking, macros and meal-plan route is behind ClientEntitlementGuard (backend
  src/common/guards/client-entitlement.guard.ts; log.controller.ts:13, client-check-ins.controller.ts:24, scheduling.controller.ts:71,
  workout.controller.ts), so a coachless or plan-less client is unentitled by design. The app copy assumes a coach:
  mobile src/entitlements/PaywallSheet.tsx:41-43 (COACH_MANAGED_TITLE/BODY), src/entitlements/ProtectedScreen.tsx:22-50 and :53-85,
  src/screens/client/ClientPackagesScreen.tsx:415-429. Day-1 win cards offer first_meal and first_checkin without checking entitlement
  (src/screens/client/Day1WinScreen.tsx:45-60), and RootNavigator routes first_meal to the gated Log tab (RootNavigator.tsx:911-912).
  Not a dead end: "Message your coach" opens Messages, which shows "Enter a coach code" for a coachless client.
- Smallest fix (mobile only, no backend): when the cached user has no coach_id, ProtectedScreen / PaywallSheet / ClientPackages empty
  state say "Join a coach to start logging. Enter the code your coach gave you." with an "Enter a coach code" action (navigate
  Home > Messages, which already hosts the code sheet); and Day1WinScreen shows only "Log your starting weight" (weight logging is not
  gated) when the entitlement is not active.
- Needs owner decision (see below): whether coachless clients should log food and workouts free before choosing a coach.

### U-3 — Support screen names a "Client Bot" that does not exist
- User story: a client opening Settings > Support reads "Support is separate from Coach AI and the Client Bot", but no Client Bot appears
  anywhere in the app; the assistant is called Roman.
- Where: src/screens/support/SupportInboxScreen.tsx:169-170.
- Smallest fix: "Support is separate from Roman. A person from the support team replies during business hours."

## C one-liners
- C (edge, deferred to 10k clients): SettingsScreen.tsx:79 Reset Onboarding swallows a failed profile update (`.catch(() => {})`) offline.
- C: Progress logs weight in lbs only (labelled "Weight (lbs)", ProgressScreen.tsx:784); kg clients convert by hand. Truthful, not a defect.
- C: CommunitySpace / coachless Home banner hidden when GET /coachless/home fails (network) - Messages still offers Enter a coach code.

## Checked and fine (no finding)
- Roman sendMessage: crisis short-circuit (911/988 template) runs before rate limit, AI consent, daily cap and coach pool
  (roman.controller.ts:112-142); mobile has no client-side consent gate in front of the composer.
- Leaderboard: backend me/leaderboard scoped to requester.coach_id and opt-in; entry hidden without a coach (CommunityTabScreen.tsx:80-93).
- Purchased PDF/video: GET /v1/client/media/:id/signed-url requires a live grant, same 404 for every refusal (client-media.controller.ts).
- Wins feed (More > Community): /community/feed policy-scoped to the coach circle or own wins.
- Coach code: CoachCodeSheet join -> patchUserCache + entitlement refresh + Welcome with plan/message actions; iOS plan goes to labelled
  1:1 ClientPackages.
- Email confirmation: emailRedirectTo default tgp://verified (auth.service.ts:561) + linking `verified` path -> EmailVerified screen.
- Role picker: SIGNUP_ROLE_CHOICE_ENABLED unset = code default true (auth.service.ts:81); sheet B1/B2 "select the client role" is right.
- Consultation only where the server can finish it (onboarding.service.ts:611 + RootNavigator consultationApplies); coachless -> Lean ->
  Day-1 (Day-1 copy fixes are in open m#441 / merged b#812, FU-FIRSTRUN-126).
- Push tap routing: CLIENT_PUSH_ROUTES uses tab + nested screen names (pushTapRouter.ts), no cross-stack names.
- Health Connect: clinic profile sets TGP_ANDROID_HEALTH_CONNECT=1 -> extra.healthConnectEnabled; More shows Health and sleep and
  Connected devices on iPhone always and on Android in clinic.
- Tutorial: every signal step has Later or the overlay's "Skip the tour"; welcome call step is deferrable.

## Device sheet corrections (ops/reports/S-BUILDDAY-126/DEVICE_PASS_10-07.md)
1. Header: mobile main is now e8c4d766 (950689af + #444 workout push, #442 check-in, #440 copy, #445 booking); backend main is 35c22212
   (2df556b7 + #810 cron, #812 Day One). Re-stamp both links; production backend is still f71bb9a4 until the next deploy.
2. Tabs have no text labels (ClientNavigator.tsx `tabBarShowLabel: false`). Add icons: Home (house), Train (dumbbell), Log (fork and knife),
   Calendar, More (person icon, read as "Profile and more"), Community (speech bubbles).
3. C3 and D4: expect "different" on both phones until B-1 is fixed (Start on a coach-assigned workout does nothing). Quick Workout and My
   Routines still start normally, so do not mark the whole Train tab broken.
4. H3: More > Settings > Notification preferences opens "Notification Categories" (five switches: Coach Messages, Reminders, Workout
   reminders, Milestones, System; no "Mute all notifications", no community switch). Until U-2 is fixed, record Mute all as not available;
   the Coach Messages switch alone does not prove community replies are silenced.
5. I4: "Report a problem by email" only shows when live chat is available; when the build has no live chat the button reads
   "Email support". Accept either and note which one appeared.
6. B5 / C1 / C3 / C5 / H6 need an entitled test client (a code that includes a plan, or an existing active plan). A client on a code that
   only offers a plan to buy, or with no coach, gets the paywall on Log food, Train, check-in and Calendar booking (U-4); that is by design,
   not a failure, but note the paywall wording.
7. H1 / messages: tapping the coach's name at the top of the client thread does nothing (U-1); Mute and Block User for the coach are not
   reachable from the client thread. Do not mark H2 failed for it.

## HANDOFF
- Job complete. Read-only audit; no worktrees, no branches, no PRs, no comments were created. /tmp/aud126 is a throwaway `git archive`
  of mobile origin/main e8c4d766 used for grep (safe to ignore).
- Next agent: route "Not fixed" items 1-4 to one mobile builder (single PR, well under 800 lines); item 5 after the owner answers D2.
- Not traced in depth (left to their own lanes): money/checkout (AUD-MJ-*), coach side (AUD-E2E-COACH-126), booking (FU-BOOK-126, merged
  #445), food log (FU-FOODLOG-126, m#447), check-in (FU-CHECKIN-126, merged #442), Day-1 (FU-FIRSTRUN-126).
