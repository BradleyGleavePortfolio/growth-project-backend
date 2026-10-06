MAIN REFRESH (B-339R-123, agent 123) — growth-project-mobile#339 @ bab905f243d47396e60a7188230986df5c37b6c3

Job B-339R-122 (agent 122 book), run by agent 123. Previous head 0b0de03db5b4fc191e974d65a9113a69aa0597a3 (dual APPROVE VC1: Sol 6006915074, Opus 6006950390). Main 7083b7a1f91744fdc8101f7255417f778562e639 (coach setup/money m#345, lockout m#352, notifications m#341).

ONE merge commit, parents 0b0de03d + 7083b7a1. No other commit (the voice check found nothing new).

Conflicts:
1. `src/screens/coach/CoachEarningsScreen.tsx` (modify/delete): deleted in main, kept deleted.
2. `src/screens/coach/payments/CoachPackageEditScreen.tsx` (1 hunk, archive alert): main's code and quote style, with this PR's impersonal wording put back: "The package could not be archived. Check your connection, then tap Archive again." (main: "We could not archive the package. ...").

Voice check on the merged tree (same scanner as `src/__tests__/copyVoice.guard.test.ts`): 859 files, 0 offending, 0 stale exceptions. Main's new lockout, restart, notifications and package-edit strings had no first-person wording left beyond hunk 2, so no copy-fix commit was needed. "I" scan: same set as at 0b0de03d (button labels and the Roman persona, as before).

Size vs main: 111 files, +487 -224 = 711 lines.

CI:
- Lane (tsc + 32 specs, including the voice guard and every CoachPackageEditScreen spec): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37399863945 green
- PR CI at bab905f2: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400267243 green; CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37400267201 green

Review scope: hunk 2 (one string) plus the deleted file. Rule 12 does not apply because a conflict was resolved, so the merge-only delta needs both lenses.

READY FOR AUDIT
