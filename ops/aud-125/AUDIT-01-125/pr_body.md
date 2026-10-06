Tier: T2
Why: client-side navigation gate for a one-time interstitial; a wrong answer only shows or hides the Day One screen, no data, money or access changes.
T4 trigger scan: none (no auth, session, token, tenancy, PII, money or deletion change; the new key holds only an ISO time under the user's own id in the non-sensitive prefs namespace).
T3 trigger scan: none (no backend contract, no shared data shape).
Bounded T1: NO (touches RootNavigator boot routing).
Canonical builder: Claude Opus 5.5 (AUDIT-01-125, agent 125)
Parent owner: operator agent 125
Acceptance evidence: `src/__tests__/rootNavigatorPackagePromptGate.test.tsx` (real RootNavigator: no skip -> Day One shows; this user skipped -> Home; another account's skip on the same phone -> Day One still shows) and `src/__tests__/Day1WinScreen.test.tsx` (Skip writes the marker for the signed-in user and records no win). Failing first: test-only commit d0123f30, ci-lane run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37532574885. Full typecheck, lint and Jest: this PR's CI.
Promotion triggers: any change to what the server stores, or to sign-out cache sweeping.

## Fixes (AUDIT-01-125, client first run)
- **U-01-1:** A new client who taps "Skip for now" on the Day One screen gets that same full-screen Day One screen again every time they open the app, because `GET /me/first-win/status` only turns `completed` true when a win card is tapped and RootNavigator asked it on every cold start.

Build profile: the 10-07 build is eas.json "clinic" (consultation onboarding on). The Day One screen appears on the standard path: every client with no coach (coachless sign-up) and every client whose coach has no clinic program (`GET /me/onboarding` consultation_available false). The consultation path never shows it and is unchanged.

## Change
- `src/lib/day1WinSkip.ts`: `markDay1WinSkipped(userId)` / `wasDay1WinSkipped(userId)` on `prefsStorage` key `onboarding.day1win_skipped_at:<userId>` (falls back to the cached signed-in user id; never throws; logs on failure).
- `Day1WinScreen.handleSkip` (the "Skip for now" button and the repeated-failure "continue" escape) records the skip before the existing package-sheet gate.
- `RootNavigator.bootstrapAuth`: the first-win status read is skipped when this user already skipped; otherwise unchanged.
- No API, backend, dependency, flag or lockfile change. Works against the current production backend (no new endpoint). The marker is per user id, so a second account on the same phone still sees its own Day One screen once; a prefs-namespace clear at sign-out only means the screen can appear once more after the next sign-in.

## Overlap
- `src/navigation/RootNavigator.tsx`: m#413 edits the linking config and imports in the same file (different hunks; this PR adds one import line next to `profileOnboardingCompleted` and edits only the first-win block). m#411 (draft) mounts a hook in RootNavigator; different hunk.

Size: 116 changed lines (47 test).
