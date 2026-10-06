Tier: T2
Why: Bounded shared accessibility and appearance fixes, plus primary tab safe-area layout, without changing routes or data behavior.
T4 trigger scan: none; no auth, tenancy, PII, money, credentials, or destructive-data change.
T3 trigger scan: none; no persistence, synchronization, scheduling, API contract, or offline behavior change.
Bounded T1: NO; shared press semantics and two navigator layouts require regression coverage.
Canonical builder: GPT-6.1 Sol
Parent owner: operator agent 125
Acceptance evidence: new targeted screen-reader, tab appearance/safe-area, exercise contrast, and large-text label regression tests; PR CI runs typecheck, lint and the complete test suite.
Promotion triggers: changing entitlement, routing, stored data, or API semantics requires re-grading.

## AUDIT-20-125 — B/U list

B: none established in this scope.

- U20-1: A client opening the main tabs sees low-contrast inactive icons, and both client/coach tab bars ignore the selected dark appearance. Use semantic foreground/background/border tokens.
- U20-2: On an iPhone with a bottom safe-area inset, fixed tab-bar heights consume icon/label space, and coach padding overrides inset protection. Retain the intended content height and coach bottom padding above the home indicator.
- U20-3: A screen-reader user encounters shared actionable press controls without a button role unless each screen supplies one. Supply the shared button default only for actionable controls; explicit roles and non-actionable content are preserved.
- U20-4: In dark mode, a client selecting an exercise filter sees dark text on the oxblood fill. Use the existing textOnAccent token for selected labels and accentText for load-error foregrounds.
- U20-5: A large-text client sees the Home message-coach action truncated to one line. Allow the existing flexible control to wrap.

## Compatibility and scope

- Works against the current production backend; no API or feature-flag changes.
- No dependencies, lockfile changes, migrations, store builds, merges or deploys.
- No file overlap with agent 124's open food, workout, money, auth, roster or day-one coach PRs. Roster lookup and Overview copy fixes remain covered by #408 and #414.
- Existing theme-provider legacy `colors` behavior is unchanged; this is not a risky app-wide palette rewrite.
- Physical-device large-text/VoiceOver/dark-mode smoke evidence is not claimed.

## Tests

- `src/components/__tests__/HapticPressable.accessibility125.test.tsx`
- `src/components/home/__tests__/HomeHeaderActions.test.tsx`
- `src/navigation/__tests__/tabBarPolish125.test.ts`
- `src/screens/client/__tests__/ExerciseLibraryPolish125.test.tsx`

Baseline reproduction uses the tests-only commit on `ci/AUDIT-20-125-baseline`. Shared mobile dependencies were not ready, so no local full suite, project typecheck, lint or build was run.

## CI and size

- Initial tests-only baseline: 11 regression failures and 6 passing preservation/existing assertions across four suites; [baseline run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530694949).
- Opening PR CI caught a removed legacy `colors` import still required by unchanged stack headers. Restored that import, kept the new tab semantic tokens, and pushed the correction.
- Operator 14:05 revised the U-only cap to under 150 changed lines. Condensed the regression tests without removing the primary behavioral checks: 148 changed lines, including tests (38 source + 110 tests; 134 additions + 14 deletions).
- No extra targeted lane run; the PR's own CI supplies final typecheck, lint and full-suite evidence.
