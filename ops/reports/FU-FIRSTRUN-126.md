# FU-FIRSTRUN-126 — Day-1 answers must save (U-01-2, U-01-3 from AUDIT-01-125)
Agent: FU-FIRSTRUN-126 (Claude Opus 5.5) for operator agent 126. Relaunched 18:03 PDT 10-06. Hard stop 19:30.
Code: backend main f71bb9a4 / 2df556b7 (after b#808 merge), mobile main 950689af. m#411 closed: not used, not built on.
Previous copy (stopped at 3 min) left no worktree and no pushed branch.

## Scope traced (screens + routes)
- Mobile: RootNavigator Day-1 gate (profile.day_one_completed is never sent by the backend; profileOnboardingCompleted reads
  onboardingCompleted) -> Day1OnboardingNavigator -> Goals / Notifications / CheckInTime / Ready -> screens/day-one/api.ts + resume.ts
  (offline queue, flushPendingSync) -> Day1WinScreen (cards, completion view) -> RootNavigator win targets (first_checkin -> Home/Habits).
  lib/finalizeLeanOnboarding + hooks/useLeanOnboardingReconcile (retries lean PUT /profile with onboarding_completed each app open).
  services/timezoneSync (PUT /notifications/timezone source device, 404/405 fallback).
- Backend: profile.dto.ts UpdateProfileDto (onboarding_completed accepted; no day_one_* / daily_checkin_*), main.ts ValidationPipe
  forbidNonWhitelisted, notifications.dto.ts (timezone, daily_checkin_enabled; no daily_checkin_time), notifications.controller
  PUT timezone, users.controller PATCH me/preferences (Partial<interface>, unknown keys ignored), first-win.service (labels, fallbacks,
  fixed_template egress). No backend job sends a reminder at a chosen check-in time (daily_checkin_enabled is stored only).

## B list
- None.

## U list
- U-01-2 (CONFIRMED on main, FIXED m#441): a client whose last onboarding answer did not reach the server goes through Day-1 and every
  step shows "Couldn't save your progress", because goals / check-in time / completion use fields the backend rejects with a 400.
- U-01-3 (CONFIRMED, FIXED m#441 + b#812): Day One shows "YOUR FIRST DATA POINT" and an AI message saying the meal/weight is already
  logged before anything is logged; the check-in card lands on Habits and talks about "your coach" to coachless clients.
- U-FR-1 (new, FIXED m#441): Day-1 copy contradicts the app: "We'll remind you once a day at this time" (no such reminder), "Your coach
  has been notified you've joined" (shown to coachless clients), "Never spam ... Nothing else. Promise." (booking reminders and
  milestones also send), goals "You can adjust this any time" (no screen for it), first person in "Continue offline" copy.

## C one-liners
- C (edge, deferred to 10k clients): Day-1 offline queue only drains on the Ready tap (m#411 closed); the server completion still lands
  via the lean reconcile hook on the next app open.
- C (edge, deferred to 10k clients): global (not per-account) AsyncStorage keys day_one_completed / day_one_onboarding_state_v1 on a
  shared phone.

## Covered by open PRs
- None overlapping (open: b#809, m#439 AI builder; no Day-1 files).

## PRs opened
- growth-project-mobile#441 `agent126/fu-firstrun-126`, head a1449f3740ba03bf4a44bb43863182b151a5c10b, +219/-42 = 261 lines (incl. tests).
  New dayOneSavesAccepted.test.ts: 7/8 fail on main, 8/8 pass. day1OnboardingFlow 23, day1OnboardingScreens 27, Day1WinScreen 16 pass.
- growth-project-backend#812 `agent126/fu-firstrun-126`, head 91ab6aa7aecedfe69a66ce7d50dba73883fac1ee, +89/-9 = 98 lines.
  New test/first-win-step-copy.spec.ts: 2/2 fail on main, 2/2 pass; coach-ai-consent.spec 22/22 pass.
- CI: m#441 Typecheck, lint, test SUCCESS (run 37556168479) + CodeQL SUCCESS. b#812 build-and-test SUCCESS (run 37556405219), all
  other checks SUCCESS, deploy-readiness-gate SKIPPED.
- READY comments: m#441 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/441#issuecomment-6028824596 (18:21),
  b#812 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/812#issuecomment-6028914090 (18:28).
- No ci/* lane branches were used.

## FIX ROUND 2 (m#441, operator 18:39; LF-SOL B-441-1)
- B-441-1 (FIXED at 9cc1fcdc1fe0982df000a5b320a0dcbeef6d6fa5): a client who picks goals and a check-in time and taps "Open my
  dashboard" lost both answers (goals no-op, time not sent, Ready cleared the only copy in the resume draft).
  Fix: new src/screens/day-one/answers.ts keeps them per account in prefsStorage `onboarding.day1_answers:<userId>`;
  saveGoals / saveCheckInTime write it; ReadyScreen keeps the draft answers before clearResumeState (and leaves the checkpoint if the
  write fails); key prefix added to authActions USER_SCOPED_PREFIXES (swept on sign-out, as the lean drafts are).
  Completion field (onboarding_completed) and PUT /notifications/timezone unchanged; no reminder promise.
- Tests: ReadyScreen finish-flow regression reads both answers back after completion (fails at a1449f37, passes); dayOneSavesAccepted
  3 updated cases fail at a1449f37, 8/8 pass; authActions sign-out sweep covers the new key (14/14); day1OnboardingScreens 28/28;
  day1OnboardingFlow 23/23; targeted eslint clean. PR now ~439 changed lines.

## Not fixed (needs operator)
- Day-1 goals and check-in time have no backend home and no reminder job: needs a migration + job. Recommended default: post-launch.

## HANDOFF
- 18:50: FIX ROUND 2 READY on m#441 at 9cc1fcdc1fe0982df000a5b320a0dcbeef6d6fa5, CI green (run 37558533543), mergeable, 439 lines:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/441#issuecomment-6029161041 . b#812 merged (operator).
  Worktree removed again after confirming push + clean tree. Awaiting LF-SOL re-verdict.
- Done 18:29. Both PRs READY FOR AUDIT at the heads above, CI green. Awaiting LF lens pair. Worktrees removed after confirming both
  branches pushed and trees clean; to continue a fix round, re-create a worktree from origin/agent126/fu-firstrun-126 in each repo.
- Independent PRs: either can merge first. m#441 must merge before the 09:30 freeze for the 10-07 build.
